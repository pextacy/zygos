import { describe, expect, it } from 'vitest';
import { FeedStaleError, SimulationFailedError } from '../src/errors.js';

// Scaffold sanity tests — replaced by real de-vig/hedge suites on Day 1–2
// (PLAN.md T1.2, T2.1). They exist so gate G0's "CI green" exercises vitest.
describe('typed errors', () => {
  it('FeedStaleError carries staleness metadata', () => {
    const err = new FeedStaleError('fixture-1', 31_000, 30_000);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('FeedStaleError');
    expect(err.ageMs).toBeGreaterThan(err.thresholdMs);
  });

  it('SimulationFailedError is a typed Error, not a string', () => {
    const err = new SimulationFailedError('insufficient funds for rent');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('simulation failed');
  });
});
