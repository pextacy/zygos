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

function makeEngine(previewImpl?: () => Promise<HedgePreview>) {
  const listeners: Array<{ onEvent?: (e: MatchEvent) => void; onConsensus?: (s: ConsensusSnapshot) => void }> = [];
  const feed = { addListener: (l: (typeof listeners)[0]) => listeners.push(l) } as unknown as FeedService;
  const valuation = { getPosition: async () => POSITION } as unknown as ValuationService;
  const preview = vi.fn(previewImpl ?? (async () => FAKE_PREVIEW));
  const hedge = { preview } as unknown as HedgeOrchestrator;
  const engine = new RuleEngine(openDb(':memory:'), valuation, hedge, feed, silentLog);
  const emit = (e: MatchEvent) => Promise.all(listeners.map((l) => l.onEvent?.(e)));
  return { engine, emit, preview };
}

function goalEvent(team: 'HOME' | 'AWAY', fixtureId = 'fx-1'): MatchEvent {
  return { packetId: 'pkt-goal-1', sourceTs: Date.now() - 500, fixtureId, type: 'GOAL', team, inferred: false };
}

describe('RuleEngine v1 (PRD FR-4x)', () => {
  it('creates a rule bound to the position fixture with a deterministic intent hash', async () => {
    const { engine } = makeEngine();
    const rule = await engine.create({ wallet: 'W1', positionRef: 'pos-1', template: 'GOAL_LOCK', team: 'HOME', fraction: 0.7 });
    expect(rule.fixtureId).toBe('fx-1');
    expect(rule.fractionPpm).toBe(700_000);
    expect(rule.intentHash).toBe(intentHash(rule));
    expect(engine.list('W1')).toHaveLength(1);
    expect(engine.list('W2')).toHaveLength(0);
  });

  it('fires GOAL_LOCK on a goal by the position team, with the prebuilt preview and packet ref', async () => {
    const { engine, emit } = makeEngine();
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
    const { engine, emit } = makeEngine();
    await engine.create({ wallet: 'W1', positionRef: 'pos-1', template: 'GOAL_LOCK', team: 'HOME', fraction: 0.5 });
    const fired: RuleFiredFrame[] = [];
    engine.onFired((f) => fired.push(f));

    await emit(goalEvent('AWAY'));
    await emit(goalEvent('HOME', 'fx-OTHER'));
    await emit({ ...goalEvent('HOME'), type: 'RED_CARD' });
    expect(fired).toHaveLength(0);
  });

  it('RED_CARD_REDUCE fires only on red cards against the position side', async () => {
    const { engine, emit } = makeEngine();
    await engine.create({ wallet: 'W1', positionRef: 'pos-1', template: 'RED_CARD_REDUCE', team: 'HOME', fraction: 0.5 });
    const fired: RuleFiredFrame[] = [];
    engine.onFired((f) => fired.push(f));

    await emit({ ...goalEvent('HOME'), type: 'RED_CARD' });
    expect(fired).toHaveLength(1);
    expect(fired[0]?.template).toBe('RED_CARD_REDUCE');
  });

  it('a firing whose preview/simulation fails shows NO prompt (no frame emitted)', async () => {
    const { engine, emit } = makeEngine(async () => {
      throw new Error('simulation failed');
    });
    await engine.create({ wallet: 'W1', positionRef: 'pos-1', template: 'GOAL_LOCK', team: 'HOME', fraction: 1 });
    const fired: RuleFiredFrame[] = [];
    engine.onFired((f) => fired.push(f));
    await emit(goalEvent('HOME'));
    expect(fired).toHaveLength(0);
  });

  it('remove is wallet-bound', async () => {
    const { engine } = makeEngine();
    const rule = await engine.create({ wallet: 'W1', positionRef: 'pos-1', template: 'GOAL_LOCK', team: 'HOME', fraction: 1 });
    expect(engine.remove(rule.id, 'W2')).toBe(false);
    expect(engine.remove(rule.id, 'W1')).toBe(true);
    expect(engine.list('W1')).toHaveLength(0);
  });
});
