import { randomUUID } from 'node:crypto';
import {
  marketKeyString,
  planHedge,
  SimulationFailedError,
  type ConsensusSnapshot,
  type HedgePlan,
  type OutcomeKey,
} from '@zygos/core';
import { Connection, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import type { VenuePosition } from '@zygos/venue-adapters';
import { buildUnsignedMemoTx, lockCommitment } from './chain/memo.js';
import type { FeedLogger, FeedService } from './feed.js';
import type { LockLedger } from './ledger.js';
import type { ValuationService } from './valuation.js';

/**
 * Hedge orchestration (PRD FR-3x, DOCS.md §5.6): quote both routes → plan →
 * build unsigned tx → simulateTransaction → hand to the wallet. A failed
 * simulation returns an error and NO transaction (CLAUDE.md §2.4). The memo
 * commitment is a second unsigned tx issued by /hedge/confirm only after
 * post-verification (DOCS.md §5.6).
 */

/**
 * Outcomes a lock can be built for. The venue trades binary YES/NO contracts,
 * so the synthetic hedge is a single leg: buy `NOT_{outcome}` on the SAME
 * market the position holds. Planning multi-leg complements (DRAW+AWAY) while
 * executing a single NO purchase would price the plan with one book and the
 * trade with another — the displayed floor would be fiction.
 */
const HEDGEABLE_OUTCOMES: ReadonlySet<string> = new Set<OutcomeKey>(['HOME', 'DRAW', 'AWAY', 'OVER', 'UNDER']);

export interface HedgePreview {
  /** Server-side handle: /hedge/confirm passes it back so the lock ledger records the exact plan the user signed against — never client-supplied numbers. */
  previewId: string;
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

const PREVIEW_TTL_MS = 15 * 60 * 1000;

interface CachedPreview {
  wallet: string;
  positionRef: string;
  fraction: number;
  preview: HedgePreview;
  at: number;
}

export class HedgeOrchestrator {
  /** Viable previews kept for confirm-time ledger recording (pruned by TTL). */
  private readonly previewCache = new Map<string, CachedPreview>();

  constructor(
    private readonly valuation: ValuationService,
    private readonly feed: FeedService,
    private readonly connection: Connection | null,
    private readonly log: FeedLogger,
    private readonly ledger: LockLedger | null = null,
  ) {}

  /** Build the full preview for locking `fraction` of a position. Throws typed errors upstream maps to HTTP. */
  async preview(wallet: string, positionRef: string, fraction: number): Promise<HedgePreview> {
    const position = await this.valuation.getPosition(wallet, positionRef);
    if (!position) throw new PreviewError(404, `position ${positionRef} not found for wallet`);

    if (!HEDGEABLE_OUTCOMES.has(position.outcome)) {
      throw new PreviewError(422, `positions on outcome ${position.outcome} cannot be hedged (unmapped market)`);
    }

    const snapshot = this.findSnapshot(position);
    if (!snapshot) throw new PreviewError(409, `no fresh consensus for ${position.fixtureId} ${marketKeyString(position.market)} — feed STALE, lock-in disabled (FR-14)`);
    const consensusProb = snapshot.probs[position.outcome as OutcomeKey];
    if (consensusProb === undefined) throw new PreviewError(422, `consensus has no probability for ${position.outcome}`);

    const venue = this.valuation.venueAdapter;
    // Direct close is all-or-nothing at the venue (DELETE sells every
    // contract), so the CLOSE route is only offered for a full lock. The two
    // quotes are independent — fetch them concurrently.
    const [complementQuote, holdBid] = await Promise.all([
      venue.getQuote(position.market, `NOT_${position.outcome}`, 'BUY', position.size, position.fixtureId),
      venue.buildCloseTx && fraction === 1
        ? venue.getQuote(position.market, position.outcome, 'SELL', position.size, position.fixtureId).then(
            (q) => q.price,
            () => null, // venue can't quote a close right now: synthetic route only
          )
        : Promise.resolve<bigint | null>(null),
    ]);

    const plan = planHedge({
      size: position.size,
      fraction,
      holdOutcome: position.outcome,
      complementAsks: [{ outcome: complementQuote.outcome, price: complementQuote.price }],
      holdBid,
      consensusProb,
    });

    if (!plan.viable) {
      return { previewId: randomUUID(), plan: serializePlan(plan), unsignedTxBase64: '', packetIds: snapshot.packetIds, consensusAsOf: snapshot.asOf, simulated: false };
    }

    const quoteForRoute =
      plan.route === 'CLOSE'
        ? await venue.getQuote(position.market, position.outcome, 'SELL', plan.hedgeSize, position.fixtureId)
        : complementQuote;

    const tx =
      plan.route === 'CLOSE' && venue.buildCloseTx
        ? await venue.buildCloseTx(wallet, position, fraction, quoteForRoute)
        : await venue.buildHedgeTx(wallet, position, fraction, quoteForRoute);

    const simulated = await this.simulate(tx.txBase64);

    const preview: HedgePreview = {
      previewId: randomUUID(),
      plan: serializePlan(plan),
      unsignedTxBase64: tx.txBase64,
      packetIds: snapshot.packetIds,
      consensusAsOf: snapshot.asOf,
      simulated,
    };
    this.cachePreview({ wallet, positionRef, fraction, preview, at: Date.now() });
    return preview;
  }

  private cachePreview(entry: CachedPreview): void {
    const cutoff = Date.now() - PREVIEW_TTL_MS;
    for (const [id, cached] of this.previewCache) {
      if (cached.at < cutoff) this.previewCache.delete(id);
    }
    this.previewCache.set(entry.preview.previewId, entry);
  }

  /**
   * Post-execution: re-read positions (post-verify, FR-33) and return the
   * unsigned memo-commitment transaction for the wallet to sign. A verified
   * lock is also written to the lock ledger; plan fields (route, floor, edge)
   * come from the server's own cached preview looked up by `exec.previewId`,
   * so the recorded edge is exactly what the user signed against.
   */
  async confirm(
    wallet: string,
    positionRef: string,
    fraction: number,
    packetIds: string[],
    exec?: { signature?: string; previewId?: string; ruleId?: string },
  ): Promise<{ verified: boolean; sizeAfter: string | null; memoTxBase64: string | null; lockId: string | null }> {
    const before = await this.valuation.getPosition(wallet, positionRef);
    await this.valuation.refreshPositions(wallet);
    const after = await this.valuation.getPosition(wallet, positionRef);

    // v1 post-verify: the position must have shrunk or closed. Strict payout-
    // matrix re-verification against chain state needs the venue's position
    // layout per route and lands with live-venue testing. A positionRef the
    // server never saw (before === null) is NOT verifiable — otherwise any
    // authed wallet could fabricate ledger rows for made-up refs.
    const shrunk = before !== null && (after === null || after.size < before.size);
    const source = before ?? after;

    let memoTxBase64: string | null = null;
    if (this.connection && shrunk) {
      const memo = lockCommitment({
        fixtureId: source?.fixtureId ?? 'unknown',
        market: source ? marketKeyString(source.market) : 'unknown',
        side: source?.outcome ?? 'unknown',
        fraction,
        packetIds,
      });
      memoTxBase64 = (await buildUnsignedMemoTx(this.connection, new PublicKey(wallet), memo)).txBase64;
    }

    let lockId: string | null = null;
    if (shrunk && this.ledger) {
      const cached = exec?.previewId !== undefined ? this.previewCache.get(exec.previewId) : undefined;
      // The plan is only trusted when it was quoted for this exact wallet,
      // position AND fraction — otherwise a stale previewId would pair another
      // fraction's floor/edge with this confirm's fractionPpm in the ledger.
      const plan =
        cached !== undefined && cached.wallet === wallet && cached.positionRef === positionRef && cached.fraction === fraction
          ? cached.preview
          : null;
      if (plan !== null && exec?.previewId !== undefined) this.previewCache.delete(exec.previewId);
      const record = await this.ledger.record({
        wallet,
        positionRef,
        fixtureId: source?.fixtureId ?? 'unknown',
        market: source ? marketKeyString(source.market) : 'unknown',
        outcome: source?.outcome ?? 'unknown',
        fractionPpm: Math.round(fraction * 1_000_000),
        route: plan?.plan.route ?? null,
        guaranteedFloor: plan?.plan.guaranteedFloor ?? null,
        edgePts: plan?.plan.edgePts ?? null,
        impliedExitProb: plan?.plan.impliedExitProb ?? null,
        packetIds: plan?.packetIds ?? packetIds,
        consensusAsOf: plan?.consensusAsOf ?? null,
        txSig: exec?.signature ?? null,
        source: exec?.ruleId !== undefined ? 'RULE' : 'MANUAL',
        ruleId: exec?.ruleId ?? null,
        sizeBefore: before?.size.toString() ?? null,
        sizeAfter: after?.size.toString() ?? null,
        executedAt: Date.now(),
      });
      lockId = record.id;
      this.log.info(
        { lockId: record.id, fixtureId: record.fixtureId, market: record.market, edgePts: record.edgePts, packetIds: record.packetIds },
        'lock recorded in ledger',
      );
    }

    return { verified: shrunk, sizeAfter: after?.size.toString() ?? null, memoTxBase64, lockId };
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
