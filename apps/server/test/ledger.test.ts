import { describe, expect, it, vi } from 'vitest';
import { Keypair, SystemProgram, Transaction, type Connection } from '@solana/web3.js';
import type { MarketKey, MatchEvent, OddsTick } from '@zygos/core';
import type { OddsFeedAdapter, UnsignedVenueTx, VenueAdapter, VenuePosition, VenueQuote } from '@zygos/venue-adapters';
import { delegations, openDb } from '../src/db.js';
import { FeedService, type FeedLogger } from '../src/feed.js';
import { HedgeOrchestrator } from '../src/hedge.js';
import { LockLedger } from '../src/ledger.js';
import { RuleEngine } from '../src/rules.js';
import { ValuationService } from '../src/valuation.js';

/**
 * Lock ledger: verified executed locks persist with the edge captured vs
 * TxLINE fair value. Plan fields must come from the server's own cached
 * preview (never client-supplied numbers); delegated submissions record with
 * null plan fields and the trigger packet as provenance.
 */

const silentLog: FeedLogger = { info: () => {}, warn: () => {}, error: () => {} };
// confirm() builds a memo tx for the wallet, so it must be a real pubkey.
const WALLET = Keypair.generate().publicKey.toBase58();

const POSITION: VenuePosition = {
  positionRef: 'pos-1',
  fixtureId: 'fx-1',
  market: { kind: '1X2' },
  outcome: 'HOME',
  size: 10_000_000n,
  entryPrice: 400_000n,
};

function baseRecord() {
  return {
    wallet: WALLET,
    positionRef: 'pos-1',
    fixtureId: 'fx-1',
    market: '1X2',
    outcome: 'HOME',
    fractionPpm: 1_000_000,
    route: 'CLOSE' as const,
    guaranteedFloor: '5200000',
    edgePts: 1.4,
    impliedExitProb: 0.52,
    packetIds: ['pkt-1'],
    consensusAsOf: 1,
    txSig: 'SIG',
    source: 'MANUAL' as const,
    ruleId: null,
    sizeBefore: '10000000',
    sizeAfter: null,
    executedAt: 1_000,
  };
}

describe('LockLedger', () => {
  it('records, lists newest-first, and aggregates stats over preview-backed locks only', async () => {
    const ledger = new LockLedger(await openDb('memory://'));
    await ledger.record(baseRecord());
    await ledger.record({
      ...baseRecord(),
      route: null,
      guaranteedFloor: null,
      edgePts: null,
      impliedExitProb: null,
      source: 'DELEGATED',
      ruleId: 'rule-1',
      executedAt: 2_000,
    });

    const locks = await ledger.list(WALLET);
    expect(locks).toHaveLength(2);
    expect(locks[0]?.executedAt).toBe(2_000);
    expect(locks[0]?.source).toBe('DELEGATED');
    expect(locks[1]?.packetIds).toEqual(['pkt-1']);

    const stats = await ledger.stats(WALLET);
    expect(stats.count).toBe(2);
    expect(stats.totalGuaranteedFloor).toBe('5200000'); // delegated lock carries no floor
    expect(stats.avgEdgePts).toBeCloseTo(1.4);
    expect(stats.positiveEdgeCount).toBe(1);
    expect(stats.lastLockAt).toBe(2_000);

    expect(await ledger.list('OTHERWALLET')).toHaveLength(0);
    expect(await ledger.stats('OTHERWALLET')).toMatchObject({ count: 0, avgEdgePts: null, lastLockAt: null });
  });
});

// ---- integration: preview → confirm writes the signed plan to the ledger ----

class FakeFeedAdapter implements OddsFeedAdapter {
  private tickCbs: Array<(t: OddsTick) => void> = [];
  private eventCbs: Array<(e: MatchEvent) => void> = [];
  async connect() {}
  async subscribe(_ids: string[]) {}
  onTick(cb: (t: OddsTick) => void) {
    this.tickCbs.push(cb);
  }
  onEvent(cb: (e: MatchEvent) => void) {
    this.eventCbs.push(cb);
  }
  health() {
    return { connected: true, streaming: true, lastTickAgeMs: {} };
  }
  async disconnect() {}

  emitTick(bookmakerId: string, odds: [number, number, number], sourceTs: number) {
    for (const cb of this.tickCbs)
      cb({
        packetId: `pkt-${bookmakerId}-${sourceTs}`,
        receivedAt: sourceTs,
        sourceTs,
        fixtureId: 'fx-1',
        market: { kind: '1X2' },
        bookmakerId,
        outcomes: [
          { outcome: 'HOME', decimalOdds: odds[0] },
          { outcome: 'DRAW', decimalOdds: odds[1] },
          { outcome: 'AWAY', decimalOdds: odds[2] },
        ],
      });
  }
  emitEvent(event: MatchEvent) {
    for (const cb of this.eventCbs) cb(event);
  }
}

function unsignedTxBase64(): string {
  const payer = Keypair.generate().publicKey;
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 1 }));
  tx.feePayer = payer;
  tx.recentBlockhash = '4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM';
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}

/** Venue whose position list can shrink between calls, emulating an executed lock. */
function fakeVenue(state: { positions: VenuePosition[] }): VenueAdapter {
  return {
    venueId: 'fake-venue',
    cluster: 'devnet',
    getPositions: async () => state.positions,
    getQuote: async (market: MarketKey, outcome: string, side: 'BUY' | 'SELL', size: bigint): Promise<VenueQuote> => ({
      market,
      outcome,
      side,
      size,
      // NOT_x ask 0.50 keeps the direct close (bid 0.52) the winning route, as these tests assert.
      price: side === 'SELL' ? 520_000n : outcome.startsWith('NOT_') ? 500_000n : outcome === 'DRAW' ? 280_000n : 220_000n,
      feeIncluded: true,
      asOf: 0,
    }),
    buildHedgeTx: async (): Promise<UnsignedVenueTx> => ({ txBase64: unsignedTxBase64(), worstCasePrice: 0n }),
    buildCloseTx: async (): Promise<UnsignedVenueTx> => ({ txBase64: unsignedTxBase64(), worstCasePrice: 0n }),
  };
}

const okConnection = {
  simulateTransaction: async () => ({ value: { err: null } }),
  getLatestBlockhash: async () => ({ blockhash: '4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM', lastValidBlockHeight: 1 }),
} as unknown as Connection;

describe('HedgeOrchestrator → LockLedger', () => {
  async function buildStack() {
    const adapter = new FakeFeedAdapter();
    const db = await openDb('memory://');
    const ledger = new LockLedger(db);
    const feed = new FeedService(adapter, db, silentLog);
    const venueState = { positions: [POSITION] };
    const valuation = new ValuationService(fakeVenue(venueState), feed, silentLog);
    const hedge = new HedgeOrchestrator(valuation, feed, okConnection, silentLog, ledger);

    const now = Date.now();
    adapter.emitTick('book-a', [2.0, 3.6, 4.0], now - 2_000);
    adapter.emitTick('book-b', [1.95, 3.7, 4.2], now - 1_000);
    await feed.flushTicks(); // ticks are processed on an audited, serialized chain
    await valuation.refreshPositions(WALLET);
    return { hedge, ledger, venueState, db, valuation, feed, adapter };
  }

  it('a verified confirm with a previewId records exactly the signed plan', async () => {
    const { hedge, ledger, venueState } = await buildStack();

    const preview = await hedge.preview(WALLET, 'pos-1', 1);
    expect(preview.plan.viable).toBe(true);
    expect(preview.previewId).toBeTruthy();

    venueState.positions = []; // the lock landed: position closed on-chain
    const result = await hedge.confirm(WALLET, 'pos-1', 1, ['client-pkt'], {
      signature: 'SIG123',
      previewId: preview.previewId,
    });
    expect(result.verified).toBe(true);

    const locks = await ledger.list(WALLET);
    expect(locks).toHaveLength(1);
    expect(locks[0]).toMatchObject({
      fixtureId: 'fx-1',
      market: '1X2',
      outcome: 'HOME',
      route: 'CLOSE',
      guaranteedFloor: preview.plan.guaranteedFloor,
      edgePts: preview.plan.edgePts,
      txSig: 'SIG123',
      source: 'MANUAL',
      sizeBefore: '10000000',
      sizeAfter: null,
    });
    // Provenance is the server preview's packets, not the client-passed list.
    expect(locks[0]?.packetIds).toEqual(preview.packetIds);
  });

  it('a confirm without a matching preview still records the lock, with null plan fields', async () => {
    const { hedge, ledger, venueState } = await buildStack();
    venueState.positions = [{ ...POSITION, size: 4_000_000n }]; // partial close
    const result = await hedge.confirm(WALLET, 'pos-1', 0.6, ['client-pkt'], { signature: 'SIG456', previewId: 'unknown-preview' });
    expect(result.verified).toBe(true);

    const locks = await ledger.list(WALLET);
    expect(locks).toHaveLength(1);
    expect(locks[0]).toMatchObject({ route: null, guaranteedFloor: null, edgePts: null, txSig: 'SIG456', sizeAfter: '4000000' });
    expect(locks[0]?.packetIds).toEqual(['client-pkt']);
  });

  it('an unverified confirm (position unchanged) records nothing', async () => {
    const { hedge, ledger } = await buildStack();
    const result = await hedge.confirm(WALLET, 'pos-1', 1, [], { signature: 'SIG' });
    expect(result.verified).toBe(false);
    expect(await ledger.list(WALLET)).toHaveLength(0);
  });

  it('a confirm for a positionRef that never existed is NOT verified and records nothing', async () => {
    const { hedge, ledger } = await buildStack();
    // before === null && after === null must not read as "closed": otherwise
    // any authed wallet could fabricate verified 'unknown' ledger rows.
    const result = await hedge.confirm(WALLET, 'no-such-position', 1, ['client-pkt'], { signature: 'FAKE_SIG' });
    expect(result.verified).toBe(false);
    expect(result.memoTxBase64).toBeNull();
    expect(await ledger.list(WALLET)).toHaveLength(0);
  });

  it('a confirm whose previewId was quoted for a DIFFERENT fraction records null plan fields', async () => {
    const { hedge, ledger, venueState } = await buildStack();
    const preview = await hedge.preview(WALLET, 'pos-1', 1); // full-lock plan
    venueState.positions = [{ ...POSITION, size: 9_000_000n }]; // but only a 10% lock landed
    const result = await hedge.confirm(WALLET, 'pos-1', 0.1, ['client-pkt'], { signature: 'SIG', previewId: preview.previewId });
    expect(result.verified).toBe(true);

    const locks = await ledger.list(WALLET);
    expect(locks).toHaveLength(1);
    // The full-lock floor/edge must NOT be paired with the 10% fraction.
    expect(locks[0]).toMatchObject({ fractionPpm: 100_000, route: null, guaranteedFloor: null, edgePts: null });
    expect(locks[0]?.packetIds).toEqual(['client-pkt']);
  });

  it('confirm marked with a ruleId records source RULE', async () => {
    const { hedge, ledger, venueState } = await buildStack();
    const preview = await hedge.preview(WALLET, 'pos-1', 1);
    venueState.positions = [];
    await hedge.confirm(WALLET, 'pos-1', 1, [], { signature: 'SIG', previewId: preview.previewId, ruleId: 'rule-9' });
    expect((await ledger.list(WALLET))[0]).toMatchObject({ source: 'RULE', ruleId: 'rule-9' });
  });

  it('confirm returns the lockId; attachMemoSig is wallet-bound and completes the audit chain', async () => {
    const { hedge, ledger, venueState } = await buildStack();
    const preview = await hedge.preview(WALLET, 'pos-1', 1);
    venueState.positions = [];
    const result = await hedge.confirm(WALLET, 'pos-1', 1, [], { signature: 'SIG', previewId: preview.previewId });
    expect(result.lockId).toBeTruthy();

    expect(await ledger.attachMemoSig(result.lockId!, 'OTHERWALLET', 'MEMO')).toBe(false); // foreign wallet cannot attach
    expect(await ledger.attachMemoSig('no-such-lock', WALLET, 'MEMO')).toBe(false);
    expect(await ledger.attachMemoSig(result.lockId!, WALLET, 'MEMO_SIG_1')).toBe(true);
    expect((await ledger.list(WALLET))[0]?.memoSig).toBe('MEMO_SIG_1');
  });
});

describe('delegated execution → LockLedger', () => {
  it('a submitted pre-signed tx records a DELEGATED lock with the trigger packet as provenance', async () => {
    const db = await openDb('memory://');
    const ledger = new LockLedger(db);
    const listeners: Array<{ onEvent?: (e: MatchEvent) => void }> = [];
    const feed = { addListener: (l: (typeof listeners)[0]) => listeners.push(l) } as unknown as FeedService;
    const valuation = { getPosition: async () => POSITION } as unknown as ValuationService;
    const hedge = { preview: vi.fn() } as unknown as HedgeOrchestrator;
    const connection = { sendRawTransaction: vi.fn(async () => 'DELEGATED_SIG') } as unknown as Connection;

    const engine = new RuleEngine(db, valuation, hedge, feed, silentLog, connection, ledger);
    const rule = await engine.create({ wallet: WALLET, positionRef: 'pos-1', template: 'GOAL_LOCK', team: 'HOME', fraction: 0.7 });
    await db
      .insert(delegations)
      .values({ ruleId: rule.id, wallet: WALLET, noncePubkey: 'N', signedTxBase64: Buffer.from('tx').toString('base64'), createdAt: Date.now(), status: 'armed', submittedSig: null });

    const event: MatchEvent = { packetId: 'pkt-goal-7', sourceTs: Date.now() - 500, fixtureId: 'fx-1', type: 'GOAL', team: 'HOME', inferred: false };
    await Promise.all(listeners.map((l) => l.onEvent?.(event)));
    await new Promise((r) => setTimeout(r, 20)); // async matcher settles (as in pipeline.integration.test.ts)

    const locks = await ledger.list(WALLET);
    expect(locks).toHaveLength(1);
    expect(locks[0]).toMatchObject({
      source: 'DELEGATED',
      ruleId: rule.id,
      txSig: 'DELEGATED_SIG',
      fractionPpm: 700_000,
      market: '1X2',
      outcome: 'HOME',
      route: null,
      edgePts: null,
    });
    expect(locks[0]?.packetIds).toEqual(['pkt-goal-7']);
  });
});
