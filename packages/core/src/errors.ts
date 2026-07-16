/** Typed error classes (CLAUDE.md §5) — never throw strings. */

/** Feed older than the staleness threshold: valuation must refuse, UI goes STALE (FR-14). */
export class FeedStaleError extends Error {
  constructor(
    public readonly fixtureId: string,
    public readonly ageMs: number,
    public readonly thresholdMs: number,
  ) {
    super(`feed stale for fixture ${fixtureId}: ${ageMs}ms > ${thresholdMs}ms`);
    this.name = 'FeedStaleError';
  }
}

/** Malformed odds at the adapter boundary (non-finite or ≤ 1.0 decimal odds). */
export class InvalidOddsError extends Error {
  constructor(public readonly odds: number) {
    super(`invalid decimal odds: ${odds} (must be finite and > 1)`);
    this.name = 'InvalidOddsError';
  }
}

/** Venue book/pool too thin to fill the requested size within tolerance. */
export class InsufficientDepthError extends Error {
  constructor(
    public readonly market: string,
    public readonly requestedSize: bigint,
  ) {
    super(`insufficient depth on ${market} for size ${requestedSize}`);
    this.name = 'InsufficientDepthError';
  }
}

/** simulateTransaction failed: no signature prompt may be shown (CLAUDE.md §2.4). */
export class SimulationFailedError extends Error {
  constructor(public readonly reason: string) {
    super(`transaction simulation failed: ${reason}`);
    this.name = 'SimulationFailedError';
  }
}
