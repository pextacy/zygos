import { describe, expect, it } from 'vitest';
import { Keypair, SystemProgram, Transaction, type Connection } from '@solana/web3.js';
import type { MarketKey, MatchEvent, OddsTick } from '@zygos/core';
import type { OddsFeedAdapter, UnsignedVenueTx, VenueAdapter, VenuePosition, VenueQuote } from '@zygos/venue-adapters';
import { openDb } from '../src/db.js';
import { FeedService, type FeedLogger } from '../src/feed.js';
import { HedgeOrchestrator, PreviewError } from '../src/hedge.js';
import { RuleEngine, type RuleFiredFrame } from '../src/rules.js';
import { ValuationService } from '../src/valuation.js';

/**
 * End-to-end pipeline integration (T2.2/T2.8): real FeedService, consensus,
 * ValuationService, HedgeOrchestrator, and RuleEngine wired together exactly
 * as in index.ts — only the two external boundaries (feed adapter, venue,
 * RPC connection) are test doubles, the one sanctioned place for them
 * (CLAUDE.md §6). Drives: ticks → consensus → valuation → preview with
 * simulation → rule arm → event → RULE_FIRED, plus the STALE lockout path.
 */

const silentLog: FeedLogger = { info: () => {}, warn: () => {}, error: () => {} };
const WALLET = 'WALLETWALLETWALLETWALLETWALLETWALLET1111';

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
    return { connected: true, lastTickAgeMs: {} };
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

/** Genuinely deserializable unsigned transactions — the orchestrator parses before simulating. */
function unsignedTxBase64(lamports: number): string {
  const payer = Keypair.generate().publicKey;
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports }));
  tx.feePayer = payer;
  tx.recentBlockhash = '4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM';
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}
const HEDGE_TX = unsignedTxBase64(1);
const CLOSE_TX = unsignedTxBase64(2);

const POSITION: VenuePosition = {
  positionRef: 'pos-1',
  fixtureId: 'fx-1',
  market: { kind: '1X2' },
  outcome: 'HOME',
  size: 10_000_000n,
  entryPrice: 400_000n,
};

function fakeVenue(): VenueAdapter {
  return {
    venueId: 'fake-venue',
    cluster: 'devnet',
    getPositions: async () => [POSITION],
    getQuote: async (market: MarketKey, outcome: string, side: 'BUY' | 'SELL', size: bigint): Promise<VenueQuote> => ({
      market,
      outcome,
      side,
      size,
      // DRAW ask 0.28, AWAY ask 0.22 → hedge floor/share = 0.50; SELL HOME bid 0.52 → close wins
      price: side === 'SELL' ? 520_000n : outcome === 'DRAW' ? 280_000n : 220_000n,
      feeIncluded: true,
      asOf: 0,
    }),
    buildHedgeTx: async (): Promise<UnsignedVenueTx> => ({ txBase64: HEDGE_TX, worstCasePrice: 0n }),
    buildCloseTx: async (): Promise<UnsignedVenueTx> => ({ txBase64: CLOSE_TX, worstCasePrice: 0n }),
  };
}

const okConnection = {
  simulateTransaction: async () => ({ value: { err: null } }),
  getLatestBlockhash: async () => ({ blockhash: '4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM', lastValidBlockHeight: 1 }),
} as unknown as Connection;

function buildStack() {
  const adapter = new FakeFeedAdapter();
  const db = openDb(':memory:');
  const feed = new FeedService(adapter, db, silentLog);
  const valuation = new ValuationService(fakeVenue(), feed, silentLog);
  const hedge = new HedgeOrchestrator(valuation, feed, okConnection, silentLog);
  const rules = new RuleEngine(db, valuation, hedge, feed, silentLog);
  return { adapter, feed, valuation, hedge, rules };
}

describe('pipeline integration: ticks → consensus → valuation → preview → rule firing', () => {
  it('carries a tick end-to-end into a simulated, provenance-tagged lock preview', async () => {
    const { adapter, feed, valuation, hedge } = buildStack();
    const now = Date.now();

    adapter.emitTick('book-a', [2.0, 3.6, 4.0], now - 2_000);
    adapter.emitTick('book-b', [1.95, 3.7, 4.2], now - 1_000);

    // Consensus exists and is fresh.
    const snaps = feed.snapshots(now);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.bookCount).toBe(2);
    expect(snaps[0]?.confidence).toBe('OK');

    // Valuation joins position × consensus.
    await valuation.refreshPositions(WALLET);
    const [valued] = valuation.valueWallet(WALLET, snaps, now);
    expect(valued?.state).toBe('OK');
    expect(BigInt(valued?.valuation?.fairValue ?? '0')).toBeGreaterThan(4_000_000n);

    // Preview: close bid 0.52 beats synthetic floor 0.50 → CLOSE route, simulated.
    const preview = await hedge.preview(WALLET, 'pos-1', 1);
    expect(preview.plan.viable).toBe(true);
    expect(preview.plan.route).toBe('CLOSE');
    expect(preview.plan.guaranteedFloor).toBe('5200000');
    expect(preview.simulated).toBe(true);
    expect(preview.unsignedTxBase64).toBe(CLOSE_TX);
    expect(preview.packetIds.length).toBeGreaterThan(0); // FR-31 provenance

    // Edge line: implied 52% vs consensus ~50.6% → positive edge, stated.
    expect(preview.plan.edgePts).toBeGreaterThan(0);
    expect(preview.plan.edgePts).toBeLessThan(5);
  });

  it('refuses a preview when consensus is stale — the FR-14 lockout reaches the tx layer', async () => {
    const { adapter, hedge, valuation } = buildStack();
    adapter.emitTick('book-a', [2.0, 3.6, 4.0], Date.now() - 120_000); // stale
    await valuation.refreshPositions(WALLET);
    await expect(hedge.preview(WALLET, 'pos-1', 1)).rejects.toThrow(PreviewError);
    await expect(hedge.preview(WALLET, 'pos-1', 1)).rejects.toThrow(/STALE/);
  });

  it('armed GOAL_LOCK fires from a feed event with a fully built, simulated preview', async () => {
    const { adapter, rules, valuation } = buildStack();
    const now = Date.now();
    adapter.emitTick('book-a', [2.0, 3.6, 4.0], now - 1_000);
    adapter.emitTick('book-b', [1.95, 3.7, 4.2], now - 500);
    await valuation.refreshPositions(WALLET);

    await rules.create({ wallet: WALLET, positionRef: 'pos-1', template: 'GOAL_LOCK', team: 'HOME', fraction: 0.7 });
    const fired: RuleFiredFrame[] = [];
    rules.onFired((f) => fired.push(f));

    adapter.emitEvent({ packetId: 'pkt-goal', sourceTs: now - 800, fixtureId: 'fx-1', type: 'GOAL', team: 'HOME', inferred: false });
    await new Promise((r) => setTimeout(r, 20)); // async matcher settles

    expect(fired).toHaveLength(1);
    expect(fired[0]?.preview.plan.viable).toBe(true);
    expect(fired[0]?.preview.simulated).toBe(true);
    expect(fired[0]?.event.packetId).toBe('pkt-goal');
    expect(fired[0]?.latencyMs).toBeLessThan(3_000); // FR-42 target
  });

  it('inferred events flow through the same path when no real event stream exists', async () => {
    const { adapter, feed } = buildStack();
    const now = Date.now();
    const events: MatchEvent[] = [];
    feed.addListener({ onEvent: (e) => events.push(e) });

    // Sustained ≥8pt HOME jump across ticks (DOCS §6): 0.50 → 0.60.
    adapter.emitTick('book-a', [2.0, 3.6, 4.0], now - 6_000);
    adapter.emitTick('book-a', [1.63, 4.1, 5.2], now - 4_000);
    adapter.emitTick('book-a', [1.62, 4.15, 5.3], now - 2_000);

    const inferred = events.filter((e) => e.inferred);
    expect(inferred).toHaveLength(1);
    expect(inferred[0]).toMatchObject({ type: 'GOAL', team: 'HOME', fixtureId: 'fx-1' });
  });
});
