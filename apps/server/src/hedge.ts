import { createHash } from 'node:crypto';
import {
  marketKeyString,
  planHedge,
  SimulationFailedError,
  type ConsensusSnapshot,
  type HedgePlan,
  type OutcomeKey,
} from '@zygos/core';
import { Connection, PublicKey, Transaction, TransactionInstruction, VersionedTransaction } from '@solana/web3.js';
import type { VenuePosition } from '@zygos/venue-adapters';
import type { FeedLogger, FeedService } from './feed.js';
import type { ValuationService } from './valuation.js';

/**
 * Hedge orchestration (PRD FR-3x, DOCS.md §5.6): quote both routes → plan →
 * build unsigned tx → simulateTransaction → hand to the wallet. A failed
 * simulation returns an error and NO transaction (CLAUDE.md §2.4). The memo
 * commitment is a second unsigned tx issued by /hedge/confirm only after
 * post-verification (DOCS.md §5.6).
 */

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

const COMPLEMENTS: Record<string, OutcomeKey[]> = {
  HOME: ['DRAW', 'AWAY'],
  DRAW: ['HOME', 'AWAY'],
  AWAY: ['HOME', 'DRAW'],
  OVER: ['UNDER'],
  UNDER: ['OVER'],
};

export interface HedgePreview {
  plan: SerializedPlan;
  unsignedTxBase64: string;
  /** Consensus packet ids the fair value came from (FR-31 provenance). */
  packetIds: string[];
  consensusAsOf: number;
  simulated: boolean;
}

export interface SerializedPlan {
  viable: boolean;
  reason?: string;
  route: 'CLOSE' | 'HEDGE';
  hedgeSize: string;
  cost: string;
  proceeds: string;
  guaranteedFloor: string;
  retainedUpside: string;
  impliedExitProb: number;
  edgePts: number;
  payoutMatrix: Array<{ outcome: string; total: string }>;
}

export function serializePlan(plan: HedgePlan): SerializedPlan {
  return {
    viable: plan.viable,
    ...(plan.reason !== undefined ? { reason: plan.reason } : {}),
    route: plan.route,
    hedgeSize: plan.hedgeSize.toString(),
    cost: plan.cost.toString(),
    proceeds: plan.proceeds.toString(),
    guaranteedFloor: plan.guaranteedFloor.toString(),
    retainedUpside: plan.retainedUpside.toString(),
    impliedExitProb: plan.impliedExitProb,
    edgePts: plan.edgePts,
    payoutMatrix: plan.payoutMatrix.map((r) => ({ outcome: r.outcome, total: r.total.toString() })),
  };
}

export class HedgeOrchestrator {
  constructor(
    private readonly valuation: ValuationService,
    private readonly feed: FeedService,
    private readonly connection: Connection | null,
    private readonly log: FeedLogger,
  ) {}

  /** Build the full preview for locking `fraction` of a position. Throws typed errors upstream maps to HTTP. */
  async preview(wallet: string, positionRef: string, fraction: number): Promise<HedgePreview> {
    const position = await this.valuation.getPosition(wallet, positionRef);
    if (!position) throw new PreviewError(404, `position ${positionRef} not found for wallet`);

    const complements = COMPLEMENTS[position.outcome];
    if (!complements) throw new PreviewError(422, `positions on outcome ${position.outcome} cannot be hedged (unmapped market)`);

    const snapshot = this.findSnapshot(position);
    if (!snapshot) throw new PreviewError(409, `no fresh consensus for ${position.fixtureId} ${marketKeyString(position.market)} — feed STALE, lock-in disabled (FR-14)`);
    const consensusProb = snapshot.probs[position.outcome as OutcomeKey];
    if (consensusProb === undefined) throw new PreviewError(422, `consensus has no probability for ${position.outcome}`);

    const venue = this.valuation.venueAdapter;
    const complementQuotes = await Promise.all(
      complements.map((outcome) => venue.getQuote(position.market, outcome, 'BUY', position.size)),
    );
    let holdBid: bigint | null = null;
    if (venue.buildCloseTx) {
      try {
        holdBid = (await venue.getQuote(position.market, position.outcome, 'SELL', position.size)).price;
      } catch {
        holdBid = null; // venue can't quote a close right now: synthetic route only
      }
    }

    const plan = planHedge({
      size: position.size,
      fraction,
      holdOutcome: position.outcome,
      complementAsks: complementQuotes.map((q) => ({ outcome: q.outcome, price: q.price })),
      holdBid,
      consensusProb,
    });

    if (!plan.viable) {
      return { plan: serializePlan(plan), unsignedTxBase64: '', packetIds: snapshot.packetIds, consensusAsOf: snapshot.asOf, simulated: false };
    }

    const quoteForRoute =
      plan.route === 'CLOSE'
        ? await venue.getQuote(position.market, position.outcome, 'SELL', plan.hedgeSize)
        : complementQuotes[0];
    if (!quoteForRoute) throw new PreviewError(500, 'route quote unavailable');

    const tx =
      plan.route === 'CLOSE' && venue.buildCloseTx
        ? await venue.buildCloseTx(wallet, position, fraction, quoteForRoute)
        : await venue.buildHedgeTx(wallet, position, fraction, quoteForRoute);

    const simulated = await this.simulate(tx.txBase64);

    return {
      plan: serializePlan(plan),
      unsignedTxBase64: tx.txBase64,
      packetIds: snapshot.packetIds,
      consensusAsOf: snapshot.asOf,
      simulated,
    };
  }

  /**
   * Post-execution: re-read positions (post-verify, FR-33) and return the
   * unsigned memo-commitment transaction for the wallet to sign.
   */
  async confirm(wallet: string, positionRef: string, fraction: number, packetIds: string[]): Promise<{ verified: boolean; sizeAfter: string | null; memoTxBase64: string | null }> {
    const before = await this.valuation.getPosition(wallet, positionRef);
    await this.valuation.refreshPositions(wallet);
    const after = await this.valuation.getPosition(wallet, positionRef);

    // v1 post-verify: the position must have shrunk or closed. Strict payout-
    // matrix re-verification against chain state needs the venue's position
    // layout per route and lands with live-venue testing.
    const shrunk = after === null || (before !== null && after.size < before.size);

    let memoTxBase64: string | null = null;
    if (this.connection && shrunk) {
      const source = before ?? after;
      const commitment = createHash('sha256')
        .update(
          JSON.stringify({
            fixtureId: source?.fixtureId ?? 'unknown',
            market: source ? marketKeyString(source.market) : 'unknown',
            side: source?.outcome ?? 'unknown',
            fraction,
            packetIds: [...packetIds].sort(),
          }),
        )
        .digest('hex');
      const ix = new TransactionInstruction({
        keys: [],
        programId: MEMO_PROGRAM_ID,
        data: Buffer.from(`zygos:lock:${commitment}`, 'utf8'),
      });
      const tx = new Transaction().add(ix);
      tx.feePayer = new PublicKey(wallet);
      tx.recentBlockhash = (await this.connection.getLatestBlockhash('confirmed')).blockhash;
      memoTxBase64 = tx.serialize({ requireAllSignatures: false }).toString('base64');
    }

    return { verified: shrunk, sizeAfter: after?.size.toString() ?? null, memoTxBase64 };
  }

  private findSnapshot(position: VenuePosition): ConsensusSnapshot | null {
    const key = marketKeyString(position.market);
    const now = Date.now();
    return (
      this.feed.snapshots(now).find((s) => s.fixtureId === position.fixtureId && marketKeyString(s.market) === key) ?? null
    );
  }

  /** simulateTransaction before any signature prompt (CLAUDE.md §2.4). Throws SimulationFailedError on failure. */
  private async simulate(txBase64: string): Promise<boolean> {
    if (!this.connection) {
      this.log.warn({}, 'RPC_URL not configured — preview NOT simulated; refusing to offer signature');
      throw new SimulationFailedError('RPC not configured: cannot simulate, so no signature prompt is allowed');
    }
    const raw = Buffer.from(txBase64, 'base64');
    try {
      let result;
      try {
        result = await this.connection.simulateTransaction(VersionedTransaction.deserialize(raw));
      } catch {
        const legacy = Transaction.from(raw);
        result = await this.connection.simulateTransaction(legacy);
      }
      if (result.value.err) {
        throw new SimulationFailedError(JSON.stringify(result.value.err));
      }
      return true;
    } catch (err) {
      if (err instanceof SimulationFailedError) throw err;
      throw new SimulationFailedError(err instanceof Error ? err.message : String(err));
    }
  }
}

export class PreviewError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'PreviewError';
  }
}
