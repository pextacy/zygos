import { describe, expect, it, vi } from 'vitest';
import type { ConsensusSnapshot, MatchEvent } from '@zygos/core';
import type { VenuePosition } from '@zygos/venue-adapters';
import { openDb } from '../src/db.js';
import type { FeedLogger, FeedService } from '../src/feed.js';
import type { HedgeOrchestrator, HedgePreview } from '../src/hedge.js';
import { RuleEngine, intentHash, type RuleFiredFrame } from '../src/rules.js';
import type { ValuationService } from '../src/valuation.js';

const silentLog: FeedLogger = { info: () => {}, warn: () => {}, error: () => {} };

const POSITION: VenuePosition = {
  positionRef: 'pos-1',
  fixtureId: 'fx-1',
  market: { kind: '1X2' },
  outcome: 'HOME',
  size: 10_000_000n,
  entryPrice: null,
};

const FAKE_PREVIEW: HedgePreview = {
  previewId: 'pv-1',
  plan: {
    viable: true,
    route: 'HEDGE',
    hedgeSize: '7000000',
    cost: '3150000',
    proceeds: '0',
    guaranteedFloor: '3850000',
    retainedUpside: '3000000',
    impliedExitProb: 0.55,
    edgePts: 2.1,
    payoutMatrix: [],
  },
  unsignedTxBase64: 'TX',
  packetIds: ['pkt-1'],
  consensusAsOf: 0,
  simulated: true,
};

async function makeEngine(previewImpl?: () => Promise<HedgePreview>) {
  const listeners: Array<{ onEvent?: (e: MatchEvent) => void; onConsensus?: (s: ConsensusSnapshot) => void }> = [];
  const feed = { addListener: (l: (typeof listeners)[0]) => listeners.push(l) } as unknown as FeedService;
  const valuation = { getPosition: async () => POSITION } as unknown as ValuationService;
  const preview = vi.fn(previewImpl ?? (async () => FAKE_PREVIEW));
  const hedge = { preview } as unknown as HedgeOrchestrator;
  const engine = new RuleEngine(await openDb('memory://'), valuation, hedge, feed, silentLog);
  // The engine handles feed callbacks fire-and-forget; with a real async DB the
  // chain needs macrotask turns to settle before assertions.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const emit = async (e: MatchEvent) => {
    listeners.forEach((l) => l.onEvent?.(e));
    await settle();
  };
  const emitConsensus = async (s: ConsensusSnapshot) => {
    listeners.forEach((l) => l.onConsensus?.(s));
    await settle();
  };
  return { engine, emit, emitConsensus, preview };
}

function goalEvent(team: 'HOME' | 'AWAY', fixtureId = 'fx-1'): MatchEvent {
  return { packetId: 'pkt-goal-1', sourceTs: Date.now() - 500, fixtureId, type: 'GOAL', team, inferred: false };
}

function snapshot(homeProb: number, fixtureId = 'fx-1', packetId = 'pkt-c1'): ConsensusSnapshot {
  return {
    fixtureId,
    market: { kind: '1X2' },
    probs: { HOME: homeProb, DRAW: 0.2, AWAY: Math.max(0, 0.8 - homeProb) },
    bookCount: 3,
    confidence: 'OK',
    excludedBookIds: [],
    packetIds: [packetId],
    asOf: Date.now() - 200,
  };
}

describe('RuleEngine v1 (PRD FR-4x)', () => {
  it('creates a rule bound to the position fixture with a deterministic intent hash', async () => {
    const { engine } = await makeEngine();
    const rule = await engine.create({ wallet: 'W1', positionRef: 'pos-1', template: 'GOAL_LOCK', team: 'HOME', fraction: 0.7 });
    expect(rule.fixtureId).toBe('fx-1');
    expect(rule.fractionPpm).toBe(700_000);
    expect(rule.intentHash).toBe(intentHash(rule));
    expect(await engine.list('W1')).toHaveLength(1);
    expect(await engine.list('W2')).toHaveLength(0);
  });

  it('fires GOAL_LOCK on a goal by the position team, with the prebuilt preview and packet ref', async () => {
    const { engine, emit } = await makeEngine();
    await engine.create({ wallet: 'W1', positionRef: 'pos-1', template: 'GOAL_LOCK', team: 'HOME', fraction: 0.7 });

    const fired: RuleFiredFrame[] = [];
    engine.onFired((f) => fired.push(f));

    await emit(goalEvent('HOME'));
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ type: 'RULE_FIRED', template: 'GOAL_LOCK', wallet: 'W1' });
    expect(fired[0]?.preview.unsignedTxBase64).toBe('TX');
    expect(fired[0]?.event.packetId).toBe('pkt-goal-1');
    expect(fired[0]?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('does not fire on the wrong team, wrong fixture, or wrong event type', async () => {
    const { engine, emit } = await makeEngine();
    await engine.create({ wallet: 'W1', positionRef: 'pos-1', template: 'GOAL_LOCK', team: 'HOME', fraction: 0.5 });
    const fired: RuleFiredFrame[] = [];
    engine.onFired((f) => fired.push(f));

    await emit(goalEvent('AWAY'));
    await emit(goalEvent('HOME', 'fx-OTHER'));
    await emit({ ...goalEvent('HOME'), type: 'RED_CARD' });
    expect(fired).toHaveLength(0);
  });

  it('RED_CARD_REDUCE fires only on red cards against the position side', async () => {
    const { engine, emit } = await makeEngine();
    await engine.create({ wallet: 'W1', positionRef: 'pos-1', template: 'RED_CARD_REDUCE', team: 'HOME', fraction: 0.5 });
    const fired: RuleFiredFrame[] = [];
    engine.onFired((f) => fired.push(f));

    await emit({ ...goalEvent('HOME'), type: 'RED_CARD' });
    expect(fired).toHaveLength(1);
    expect(fired[0]?.template).toBe('RED_CARD_REDUCE');
  });

  it('a firing whose preview/simulation fails shows NO prompt (no frame emitted)', async () => {
    const { engine, emit } = await makeEngine(async () => {
      throw new Error('simulation failed');
    });
    await engine.create({ wallet: 'W1', positionRef: 'pos-1', template: 'GOAL_LOCK', team: 'HOME', fraction: 1 });
    const fired: RuleFiredFrame[] = [];
    engine.onFired((f) => fired.push(f));
    await emit(goalEvent('HOME'));
    expect(fired).toHaveLength(0);
  });

  it('PRICE_LOCK requires a threshold in (0,1) and a direction', async () => {
    const { engine } = await makeEngine();
    await expect(engine.create({ wallet: 'W1', positionRef: 'pos-1', template: 'PRICE_LOCK', team: 'HOME', fraction: 0.5 })).rejects.toThrow(/threshold/);
    await expect(
      engine.create({ wallet: 'W1', positionRef: 'pos-1', template: 'PRICE_LOCK', team: 'HOME', fraction: 0.5, threshold: 1.2, direction: 'ABOVE' }),
    ).rejects.toThrow(/threshold/);
    await expect(
      engine.create({ wallet: 'W1', positionRef: 'pos-1', template: 'PRICE_LOCK', team: 'HOME', fraction: 0.5, threshold: 0.75 }),
    ).rejects.toThrow(/direction/);
  });

  it('PRICE_LOCK stores threshold terms and folds them into the intent hash; event-template hashes are unchanged by them', async () => {
    const { engine } = await makeEngine();
    const price = await engine.create({ wallet: 'W1', positionRef: 'pos-1', template: 'PRICE_LOCK', team: 'HOME', fraction: 0.5, threshold: 0.75, direction: 'ABOVE' });
    expect(price.thresholdPpm).toBe(750_000);
    expect(price.direction).toBe('ABOVE');
    expect(price.intentHash).toBe(intentHash(price));
    expect(intentHash({ ...price, thresholdPpm: 800_000 })).not.toBe(price.intentHash);

    // Threshold fields on an event template are ignored and do not perturb its hash.
    const goal = await engine.create({ wallet: 'W1', positionRef: 'pos-1', template: 'GOAL_LOCK', team: 'HOME', fraction: 0.5, threshold: 0.75, direction: 'ABOVE' });
    expect(goal.thresholdPpm).toBeNull();
    expect(goal.intentHash).toBe(intentHash({ ...goal, thresholdPpm: 123, direction: 'BELOW' }));
  });

  it('PRICE_LOCK fires once on the crossing tick, with the crossing packet as provenance, then latches', async () => {
    const { engine, emitConsensus } = await makeEngine();
    await engine.create({ wallet: 'W1', positionRef: 'pos-1', template: 'PRICE_LOCK', team: 'HOME', fraction: 0.6, threshold: 0.7, direction: 'ABOVE' });
    const fired: RuleFiredFrame[] = [];
    engine.onFired((f) => fired.push(f));

    await emitConsensus(snapshot(0.62, 'fx-1', 'pkt-below'));
    expect(fired).toHaveLength(0);

    await emitConsensus(snapshot(0.73, 'fx-1', 'pkt-cross'));
    expect(fired).toHaveLength(1);
    expect(fired[0]?.event).toMatchObject({ type: 'PRICE_CROSS', outcome: 'HOME', prob: 0.73, threshold: 0.7, direction: 'ABOVE', packetId: 'pkt-cross' });
    expect(fired[0]?.preview.unsignedTxBase64).toBe('TX');

    // One-shot: further ticks beyond the threshold never re-fire; firedAt is persisted.
    await emitConsensus(snapshot(0.8, 'fx-1', 'pkt-after'));
    await emitConsensus(snapshot(0.65, 'fx-1', 'pkt-dip'));
    await emitConsensus(snapshot(0.9, 'fx-1', 'pkt-recross'));
    expect(fired).toHaveLength(1);
    expect((await engine.list('W1'))[0]?.firedAt).not.toBeNull();
  });

  it('PRICE_LOCK BELOW fires on a drop through the threshold, not above it', async () => {
    const { engine, emitConsensus } = await makeEngine();
    await engine.create({ wallet: 'W1', positionRef: 'pos-1', template: 'PRICE_LOCK', team: 'HOME', fraction: 1, threshold: 0.4, direction: 'BELOW' });
    const fired: RuleFiredFrame[] = [];
    engine.onFired((f) => fired.push(f));

    await emitConsensus(snapshot(0.55));
    await emitConsensus(snapshot(0.45));
    expect(fired).toHaveLength(0);
    await emitConsensus(snapshot(0.38));
    expect(fired).toHaveLength(1);
    expect(fired[0]?.event).toMatchObject({ type: 'PRICE_CROSS', direction: 'BELOW', prob: 0.38 });
  });

  it('PRICE_LOCK ignores other fixtures and markets without the watched outcome', async () => {
    const { engine, emitConsensus } = await makeEngine();
    await engine.create({ wallet: 'W1', positionRef: 'pos-1', template: 'PRICE_LOCK', team: 'HOME', fraction: 0.5, threshold: 0.7, direction: 'ABOVE' });
    const fired: RuleFiredFrame[] = [];
    engine.onFired((f) => fired.push(f));

    await emitConsensus(snapshot(0.9, 'fx-OTHER'));
    const totals: ConsensusSnapshot = { ...snapshot(0), market: { kind: 'TOTAL', line: 2.5 }, probs: { OVER: 0.9, UNDER: 0.1 } };
    await emitConsensus(totals);
    expect(fired).toHaveLength(0);
  });

  it('a PRICE_LOCK whose preview fails consumes the cross silently and re-arms on the next cross', async () => {
    let calls = 0;
    const { engine, emitConsensus } = await makeEngine(async () => {
      calls += 1;
      if (calls === 1) throw new Error('simulation failed');
      return FAKE_PREVIEW;
    });
    await engine.create({ wallet: 'W1', positionRef: 'pos-1', template: 'PRICE_LOCK', team: 'HOME', fraction: 0.5, threshold: 0.7, direction: 'ABOVE' });
    const fired: RuleFiredFrame[] = [];
    engine.onFired((f) => fired.push(f));

    await emitConsensus(snapshot(0.6));
    await emitConsensus(snapshot(0.75)); // cross → preview fails → no prompt, not latched
    expect(fired).toHaveLength(0);
    expect((await engine.list('W1'))[0]?.firedAt).toBeNull();

    await emitConsensus(snapshot(0.78)); // still beyond: edge consumed, no retry spam
    expect(fired).toHaveLength(0);
    await emitConsensus(snapshot(0.6)); // back below…
    await emitConsensus(snapshot(0.72)); // …re-cross → fires
    expect(fired).toHaveLength(1);
  });

  it('PRICE_LOCK armed while the price is already beyond the threshold does NOT fire until a real cross', async () => {
    const { engine, emitConsensus } = await makeEngine();
    await engine.create({ wallet: 'W1', positionRef: 'pos-1', template: 'PRICE_LOCK', team: 'HOME', fraction: 0.5, threshold: 0.7, direction: 'ABOVE' });
    const fired: RuleFiredFrame[] = [];
    engine.onFired((f) => fired.push(f));

    // First observed tick is already beyond: baseline only — an arm (or a
    // server restart) must never fire, or auto-submit a delegated tx, on a
    // cross that was never observed.
    await emitConsensus(snapshot(0.9, 'fx-1', 'pkt-already-beyond'));
    expect(fired).toHaveLength(0);
    await emitConsensus(snapshot(0.95, 'fx-1', 'pkt-still-beyond'));
    expect(fired).toHaveLength(0);
    expect((await engine.list('W1'))[0]?.firedAt).toBeNull();

    // Dip below and re-cross: this is the first actual cross — it fires.
    await emitConsensus(snapshot(0.6, 'fx-1', 'pkt-dip'));
    await emitConsensus(snapshot(0.75, 'fx-1', 'pkt-real-cross'));
    expect(fired).toHaveLength(1);
    expect(fired[0]?.event.packetId).toBe('pkt-real-cross');
  });

  it('a PRICE_LOCK whose preview returns a NON-VIABLE plan (no throw) consumes the cross without latching', async () => {
    let calls = 0;
    const notViable: HedgePreview = {
      ...FAKE_PREVIEW,
      plan: { ...FAKE_PREVIEW.plan, viable: false, reason: 'complement asks sum ≥ 1' },
      unsignedTxBase64: '',
      simulated: false,
    };
    const { engine, emitConsensus } = await makeEngine(async () => {
      calls += 1;
      return calls === 1 ? notViable : FAKE_PREVIEW;
    });
    await engine.create({ wallet: 'W1', positionRef: 'pos-1', template: 'PRICE_LOCK', team: 'HOME', fraction: 0.5, threshold: 0.7, direction: 'ABOVE' });
    const fired: RuleFiredFrame[] = [];
    engine.onFired((f) => fired.push(f));

    await emitConsensus(snapshot(0.6));
    await emitConsensus(snapshot(0.75)); // cross → plan not viable → no prompt, NOT latched
    expect(fired).toHaveLength(0);
    expect((await engine.list('W1'))[0]?.firedAt).toBeNull();

    await emitConsensus(snapshot(0.6)); // back below…
    await emitConsensus(snapshot(0.72)); // …re-cross with a viable plan → fires
    expect(fired).toHaveLength(1);
    expect(fired[0]?.preview.plan.viable).toBe(true);
  });

  it('remove is wallet-bound', async () => {
    const { engine } = await makeEngine();
    const rule = await engine.create({ wallet: 'W1', positionRef: 'pos-1', template: 'GOAL_LOCK', team: 'HOME', fraction: 1 });
    expect(await engine.remove(rule.id, 'W2')).toBe(false);
    expect(await engine.remove(rule.id, 'W1')).toBe(true);
    expect(await engine.list('W1')).toHaveLength(0);
  });
});
