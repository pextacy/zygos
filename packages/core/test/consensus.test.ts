import { describe, expect, it } from 'vitest';
import { DEFAULT_CONSENSUS_CONFIG, applyTick, marketKeyString, snapshot } from '../src/consensus.js';
import type { MarketConsensusState } from '../src/consensus.js';
import type { OddsTick } from '../src/types.js';

const T0 = 1_700_000_000_000; // fixed epoch base — core never reads a clock

function tick(bookmakerId: string, odds: [number, number, number], sourceTs: number, packetId = `pkt-${bookmakerId}-${sourceTs}`): OddsTick {
  return {
    packetId,
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
  };
}

function fold(ticks: OddsTick[]): MarketConsensusState {
  return ticks.reduce<MarketConsensusState | undefined>((s, t) => applyTick(s, t), undefined) as MarketConsensusState;
}

describe('consensus engine (DOCS.md §4.2)', () => {
  it('single fresh book: consensus equals its de-vigged probabilities, flagged LOW_CONFIDENCE', () => {
    const state = fold([tick('bookA', [2.1, 3.4, 3.8], T0)]);
    const snap = snapshot(state, T0);
    expect(snap).not.toBeNull();
    expect(snap?.probs.HOME).toBeCloseTo(0.46077, 5);
    expect(snap?.confidence).toBe('LOW_CONFIDENCE');
    expect(snap?.bookCount).toBe(1);
    expect(snap?.packetIds).toEqual([`pkt-bookA-${T0}`]);
  });

  it('two fresh books at equal age: consensus is the plain mean, confidence OK', () => {
    // bookA HOME ≈ 0.46077, bookB quotes 2.00/3.40/4.20 → HOME = 0.5/B
    const state = fold([tick('bookA', [2.1, 3.4, 3.8], T0), tick('bookB', [2.0, 3.4, 4.2], T0)]);
    const snap = snapshot(state, T0);
    const bB = 1 / 2.0 + 1 / 3.4 + 1 / 4.2;
    const expectedHome = (0.460769 + 0.5 / bB) / 2;
    expect(snap?.probs.HOME).toBeCloseTo(expectedHome, 4);
    expect(snap?.confidence).toBe('OK');
    const sum = Object.values(snap?.probs ?? {}).reduce((a, b) => a + (b ?? 0), 0);
    expect(sum).toBeCloseTo(1, 12);
  });

  it('recency weighting: an older book contributes with weight exp(-age/τ)', () => {
    const tau = DEFAULT_CONSENSUS_CONFIG.recencyTauMs;
    const state = fold([tick('fresh', [2.0, 3.5, 4.0], T0), tick('old', [2.5, 3.5, 3.2], T0 - tau)]);
    const snap = snapshot(state, T0);

    const pFresh = (1 / 2.0) / (1 / 2.0 + 1 / 3.5 + 1 / 4.0);
    const pOld = (1 / 2.5) / (1 / 2.5 + 1 / 3.5 + 1 / 3.2);
    const w = Math.exp(-1); // age exactly τ
    const expected = (pFresh + w * pOld) / (1 + w);
    expect(snap?.probs.HOME).toBeCloseTo(expected, 10);
  });

  it('drops books older than 60s from the blend', () => {
    const state = fold([tick('fresh', [2.1, 3.4, 3.8], T0), tick('stale', [1.2, 8.0, 15.0], T0 - 61_000)]);
    const snap = snapshot(state, T0);
    expect(snap?.bookCount).toBe(1);
    expect(snap?.probs.HOME).toBeCloseTo(0.46077, 5);
    expect(snap?.confidence).toBe('LOW_CONFIDENCE');
  });

  it('returns null when every book is stale — no silent fallback', () => {
    const state = fold([tick('a', [2.1, 3.4, 3.8], T0 - 90_000), tick('b', [2.0, 3.4, 4.2], T0 - 75_000)]);
    expect(snapshot(state, T0)).toBeNull();
  });

  it('outlier guard: a book >10pts from the median is excluded and reported', () => {
    // HOME probs ≈ a: 0.4607, b: 0.4788, outlier: 0.7307 → deviation ≈ 0.26 from median
    const state = fold([
      tick('a', [2.1, 3.4, 3.8], T0),
      tick('b', [2.0, 3.6, 4.0], T0),
      tick('outlier', [1.3, 6.0, 11.0], T0),
    ]);
    const snap = snapshot(state, T0);
    expect(snap?.excludedBookIds).toEqual(['outlier']);
    expect(snap?.bookCount).toBe(2);
    expect(snap?.packetIds).not.toContain(`pkt-outlier-${T0}`);
    expect(snap?.probs.HOME).toBeLessThan(0.5);
  });

  it('a newer tick replaces the same book; an out-of-order older tick is ignored', () => {
    const s1 = fold([tick('a', [2.1, 3.4, 3.8], T0), tick('a', [2.3, 3.3, 3.5], T0 + 1000)]);
    const snapNew = snapshot(s1, T0 + 1000);
    expect(snapNew?.probs.HOME).toBeCloseTo((1 / 2.3) / (1 / 2.3 + 1 / 3.3 + 1 / 3.5), 10);

    const s2 = applyTick(s1, tick('a', [9.0, 9.0, 1.1], T0 - 5000));
    expect(snapshot(s2, T0 + 1000)?.probs.HOME).toEqual(snapNew?.probs.HOME);
  });

  it('marketKeyString distinguishes market variants', () => {
    expect(marketKeyString({ kind: '1X2' })).toBe('1X2');
    expect(marketKeyString({ kind: 'TOTAL', line: 2.5 })).toBe('TOTAL:2.5');
  });
});
