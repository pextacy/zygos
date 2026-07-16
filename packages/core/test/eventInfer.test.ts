import { describe, expect, it } from 'vitest';
import { createInferenceState, inferFromSnapshot, JUMP_THRESHOLD, SUSTAIN_TICKS } from '../src/eventInfer.js';
import type { ConsensusSnapshot } from '../src/types.js';

const T0 = 1_700_000_000_000;

function snap(home: number, asOf: number, fixtureId = 'fx-1'): ConsensusSnapshot {
  return {
    fixtureId,
    market: { kind: '1X2' },
    probs: { HOME: home, DRAW: 0.25, AWAY: 1 - home - 0.25 },
    bookCount: 4,
    confidence: 'OK',
    excludedBookIds: [],
    packetIds: [`pkt-${asOf}`],
    asOf,
  };
}

describe('event inference (DOCS.md §6)', () => {
  it('emits GOAL(HOME) after a sustained ≥8pt upward jump', () => {
    const state = createInferenceState();
    expect(inferFromSnapshot(state, snap(0.45, T0))).toBeNull();
    expect(inferFromSnapshot(state, snap(0.46, T0 + 2_000))).toBeNull(); // drift, below threshold
    expect(inferFromSnapshot(state, snap(0.56, T0 + 4_000))).toBeNull(); // jump tick 1 — not yet sustained
    const event = inferFromSnapshot(state, snap(0.57, T0 + 6_000)); // jump tick 2 — sustained
    expect(event).toMatchObject({ type: 'GOAL', team: 'HOME', fixtureId: 'fx-1', inferred: true });
  });

  it('does not emit for slow drift that accumulates outside the 60s window', () => {
    const state = createInferenceState();
    // +2pts every 30s: never ≥8pts within any 60s window baseline
    for (let i = 0; i < 10; i++) {
      const event = inferFromSnapshot(state, snap(0.45 + i * 0.02, T0 + i * 30_000));
      expect(event).toBeNull();
    }
  });

  it('does not emit twice for the same move, and resets baseline after emitting', () => {
    const state = createInferenceState();
    inferFromSnapshot(state, snap(0.45, T0));
    inferFromSnapshot(state, snap(0.56, T0 + 2_000));
    const first = inferFromSnapshot(state, snap(0.57, T0 + 4_000));
    expect(first?.type).toBe('GOAL');
    // Probability stays at the new level: no further events.
    expect(inferFromSnapshot(state, snap(0.575, T0 + 6_000))).toBeNull();
    expect(inferFromSnapshot(state, snap(0.57, T0 + 8_000))).toBeNull();
  });

  it('a single-tick blip does not fire (SUSTAIN_TICKS guard)', () => {
    expect(SUSTAIN_TICKS).toBeGreaterThanOrEqual(2);
    const state = createInferenceState();
    inferFromSnapshot(state, snap(0.45, T0));
    inferFromSnapshot(state, snap(0.45 + JUMP_THRESHOLD + 0.01, T0 + 2_000)); // blip up
    const event = inferFromSnapshot(state, snap(0.45, T0 + 4_000)); // returns to baseline
    expect(event).toBeNull();
  });

  it('emits GOAL(AWAY) for the away side symmetrically', () => {
    const state = createInferenceState();
    const away = (a: number, ts: number): ConsensusSnapshot => ({
      ...snap(1 - a - 0.25, ts),
      probs: { HOME: 1 - a - 0.25, DRAW: 0.25, AWAY: a },
    });
    inferFromSnapshot(state, away(0.3, T0));
    inferFromSnapshot(state, away(0.42, T0 + 2_000));
    const event = inferFromSnapshot(state, away(0.43, T0 + 4_000));
    expect(event).toMatchObject({ type: 'GOAL', team: 'AWAY', inferred: true });
  });

  it('ignores non-1X2 markets', () => {
    const state = createInferenceState();
    const total: ConsensusSnapshot = { ...snap(0.5, T0), market: { kind: 'TOTAL', line: 2.5 } };
    expect(inferFromSnapshot(state, total)).toBeNull();
  });
});
