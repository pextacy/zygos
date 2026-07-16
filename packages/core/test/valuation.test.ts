import { describe, expect, it } from 'vitest';
import { FeedStaleError } from '../src/errors.js';
import { PRICE_SCALE, probToScaledPrice, valuePosition } from '../src/valuation.js';
import type { ConsensusSnapshot } from '../src/types.js';

const T0 = 1_700_000_000_000;

function snap(probHome: number, asOf = T0): ConsensusSnapshot {
  return {
    fixtureId: 'fx-1',
    market: { kind: '1X2' },
    probs: { HOME: probHome, DRAW: (1 - probHome) / 2, AWAY: (1 - probHome) / 2 },
    bookCount: 3,
    confidence: 'OK',
    excludedBookIds: [],
    packetIds: ['pkt-1', 'pkt-2'],
    asOf,
  };
}

describe('valuePosition (PRD FR-21/22)', () => {
  it('fair = size × prob, mark = size × bid, lag = fair − mark (hand-computed)', () => {
    // 10 USDC of shares (µUSDC), consensus 50%, on-chain bid 0.45
    const v = valuePosition({
      size: 10_000_000n,
      outcome: 'HOME',
      snapshot: snap(0.5),
      markPrice: 450_000n,
      nowMs: T0 + 1000,
    });
    expect(v.fairValue).toBe(5_000_000n);
    expect(v.markValue).toBe(4_500_000n);
    expect(v.lagDelta).toBe(500_000n);
    expect(v.consensusProb).toBe(0.5);
    expect(v.packetIds).toEqual(['pkt-1', 'pkt-2']);
    expect(v.feedAgeMs).toBe(1000);
  });

  it('subtracts the venue exit fee estimate from fair value', () => {
    const v = valuePosition({
      size: 10_000_000n,
      outcome: 'HOME',
      snapshot: snap(0.5),
      markPrice: null,
      exitFeeBps: 100,
      nowMs: T0,
    });
    expect(v.exitFeeApplied).toBe(50_000n);
    expect(v.fairValue).toBe(4_950_000n);
    expect(v.markValue).toBeNull();
    expect(v.lagDelta).toBeNull();
  });

  // Required staleness test (CLAUDE.md §6): past the threshold the valuation
  // function must throw, never serve a stale price.
  it('throws FeedStaleError when the snapshot is older than 30s', () => {
    expect(() =>
      valuePosition({
        size: 1_000_000n,
        outcome: 'HOME',
        snapshot: snap(0.5, T0),
        markPrice: null,
        nowMs: T0 + 30_001,
      }),
    ).toThrow(FeedStaleError);
  });

  it('valuates exactly at the threshold boundary (30s is not yet stale)', () => {
    const v = valuePosition({
      size: 1_000_000n,
      outcome: 'HOME',
      snapshot: snap(0.5, T0),
      markPrice: null,
      nowMs: T0 + 30_000,
    });
    expect(v.fairValue).toBe(500_000n);
  });

  it('rejects an outcome absent from the snapshot', () => {
    expect(() =>
      valuePosition({ size: 1n, outcome: 'OVER', snapshot: snap(0.5), markPrice: null, nowMs: T0 }),
    ).toThrow(RangeError);
  });

  it('probToScaledPrice rounds to PRICE_SCALE and validates range', () => {
    expect(probToScaledPrice(0.4607692)).toBe(460_769n);
    expect(probToScaledPrice(1)).toBe(PRICE_SCALE);
    expect(probToScaledPrice(0)).toBe(0n);
    expect(() => probToScaledPrice(1.2)).toThrow(RangeError);
    expect(() => probToScaledPrice(NaN)).toThrow(RangeError);
  });
});
