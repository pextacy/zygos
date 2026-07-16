import { FeedStaleError } from './errors.js';
import type { ConsensusSnapshot, OutcomeKey } from './types.js';

/**
 * Position valuation (PRD FR-21/22). Money is bigint in venue base units;
 * prices are per-share and scaled by PRICE_SCALE, where PRICE_SCALE means
 * "full payout" (a share pays exactly 1 quote unit, DOCS.md §5).
 */

export const PRICE_SCALE = 1_000_000n;

/** Feed older than this for a market ⇒ STALE state, valuation refuses (FR-14). */
export const STALENESS_THRESHOLD_MS = 30_000;

/** Convert a probability in [0,1] to a PRICE_SCALE-scaled integer price. */
export function probToScaledPrice(p: number): bigint {
  if (!Number.isFinite(p) || p < 0 || p > 1) {
    throw new RangeError(`probability out of [0,1]: ${p}`);
  }
  return BigInt(Math.round(p * Number(PRICE_SCALE)));
}

export interface PositionValuationInput {
  /** Share quantity in venue base units. */
  size: bigint;
  /** The outcome the position holds. */
  outcome: OutcomeKey;
  snapshot: ConsensusSnapshot;
  /** Current on-chain bid per share, PRICE_SCALE-scaled; null when no quote is readable. */
  markPrice: bigint | null;
  /** Venue exit fee estimate in basis points, subtracted from fair value (FR-21). */
  exitFeeBps?: number;
  /** Injected clock (CLAUDE.md §5) — never read from Date inside core. */
  nowMs: number;
  stalenessThresholdMs?: number;
}

export interface PositionValuation {
  /** size × consensus probability − exit fee estimate, in quote base units. */
  fairValue: bigint;
  /** size × on-chain bid, or null when no readable quote. */
  markValue: bigint | null;
  /** fair − mark: the visible measure of on-chain lag (DOCS.md §11). */
  lagDelta: bigint | null;
  consensusProb: number;
  /** Provenance: packet ids behind the consensus used (FR-13). */
  packetIds: string[];
  /** Age of the consensus at valuation time. */
  feedAgeMs: number;
  exitFeeApplied: bigint;
}

export function valuePosition(input: PositionValuationInput): PositionValuation {
  const threshold = input.stalenessThresholdMs ?? STALENESS_THRESHOLD_MS;
  const feedAgeMs = input.nowMs - input.snapshot.asOf;
  if (feedAgeMs > threshold) {
    throw new FeedStaleError(input.snapshot.fixtureId, feedAgeMs, threshold);
  }

  const prob = input.snapshot.probs[input.outcome];
  if (prob === undefined) {
    throw new RangeError(`consensus snapshot has no probability for outcome ${input.outcome}`);
  }

  const grossFair = (input.size * probToScaledPrice(prob)) / PRICE_SCALE;
  const feeBps = BigInt(input.exitFeeBps ?? 0);
  const exitFeeApplied = (grossFair * feeBps) / 10_000n;
  const fairValue = grossFair - exitFeeApplied;

  const markValue = input.markPrice === null ? null : (input.size * input.markPrice) / PRICE_SCALE;
  const lagDelta = markValue === null ? null : fairValue - markValue;

  return {
    fairValue,
    markValue,
    lagDelta,
    consensusProb: prob,
    packetIds: input.snapshot.packetIds,
    feedAgeMs,
    exitFeeApplied,
  };
}
