import { describe, expect, it } from 'vitest';
import { devig, overround } from '../src/devig.js';
import { InvalidOddsError } from '../src/errors.js';

describe('devig (multiplicative, DOCS.md §4.1)', () => {
  // Worked example from DOCS.md §4.1 — the canonical unit-test fixture values.
  it('matches the hand-computed 2.10/3.40/3.80 example', () => {
    const p = devig([2.1, 3.4, 3.8]);
    expect(p[0]).toBeCloseTo(0.46077, 5);
    expect(p[1]).toBeCloseTo(0.28459, 5);
    expect(p[2]).toBeCloseTo(0.25464, 5);
  });

  it('always sums to 1', () => {
    for (const odds of [
      [1.5, 2.5],
      [2.1, 3.4, 3.8],
      [1.01, 15.0, 41.0],
      [9.0, 9.2, 1.12],
    ]) {
      const sum = devig(odds).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1, 12);
    }
  });

  it('reports the overround of the raw odds', () => {
    expect(overround([2.1, 3.4, 3.8])).toBeCloseTo(1.03347, 5);
  });

  it('rejects odds ≤ 1 or non-finite', () => {
    expect(() => devig([1.0, 3.4, 3.8])).toThrow(InvalidOddsError);
    expect(() => devig([2.1, NaN, 3.8])).toThrow(InvalidOddsError);
    expect(() => devig([2.1, Infinity, 3.8])).toThrow(InvalidOddsError);
    expect(() => devig([-2.1, 3.4, 3.8])).toThrow(InvalidOddsError);
  });

  it('rejects fewer than two outcomes', () => {
    expect(() => devig([2.1])).toThrow(InvalidOddsError);
    expect(() => devig([])).toThrow(InvalidOddsError);
  });
});
