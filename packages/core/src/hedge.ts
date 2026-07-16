import { PRICE_SCALE } from './valuation.js';

/**
 * Hedge engine (DOCS.md §5). Positions are outcome shares paying 1 quote unit
 * (PRICE_SCALE base units) if the outcome occurs. All prices are per-share,
 * PRICE_SCALE-scaled, and fee-inclusive (the venue adapter's size-aware
 * quotes bake fees and slippage in before this math runs).
 *
 * Pure functions, bigint money, no I/O (CLAUDE.md §5).
 */

export interface HedgeInput {
  /** Held shares in payout base units. */
  size: bigint;
  /** Lock fraction f ∈ (0, 1]. */
  fraction: number;
  /** Label of the held outcome (for the payout matrix rows). */
  holdOutcome: string;
  /** Fee-inclusive ask per share for EACH complement outcome (1 entry for binary, 2 for 1X2). */
  complementAsks: Array<{ outcome: string; price: bigint }>;
  /** Fee-inclusive bid for selling the held outcome directly, or null when the venue can't close. */
  holdBid: bigint | null;
  /** TxLINE consensus probability of the held outcome — the fair-value reference (DOCS.md §5.5). */
  consensusProb: number;
}

export interface PayoutRow {
  /** Which outcome occurs. */
  outcome: string;
  /** Total wealth change from now (payout − cost + proceeds), base units. */
  total: bigint;
}

export interface HedgePlan {
  viable: boolean;
  /** Why the lock is not offered (viable=false), e.g. complements price ≥ 1 after fees. */
  reason?: string;
  route: 'CLOSE' | 'HEDGE';
  /** Shares transacted: sold (CLOSE) or bought per complement (HEDGE), base units. */
  hedgeSize: bigint;
  /** Upfront cost of complement purchases (HEDGE), base units. */
  cost: bigint;
  /** Sale proceeds banked immediately (CLOSE), base units. */
  proceeds: bigint;
  /** Guaranteed floor across every outcome, base units. */
  guaranteedFloor: bigint;
  /** Extra payout if the held outcome wins: (1−f)·S. */
  retainedUpside: bigint;
  /** The exit price expressed as a probability. */
  impliedExitProb: number;
  /** (impliedExitProb − consensusProb) × 100 — positive = better than fair (DOCS.md §5.5). */
  edgePts: number;
  payoutMatrix: PayoutRow[];
}

function mulFraction(value: bigint, fraction: number): bigint {
  if (!(fraction > 0 && fraction <= 1)) {
    throw new RangeError(`lock fraction out of (0,1]: ${fraction}`);
  }
  return (value * BigInt(Math.round(fraction * Number(PRICE_SCALE)))) / PRICE_SCALE;
}

/**
 * Plan the lock-in for a chosen fraction, picking the better of the two
 * routes (DOCS.md §5.3): direct close at the hold bid vs synthetic hedge
 * (buying every complement). Returns viable=false instead of a bad lock.
 */
export function planHedge(input: HedgeInput): HedgePlan {
  if (input.size <= 0n) throw new RangeError(`position size must be positive: ${input.size}`);
  if (input.complementAsks.length < 1) throw new RangeError('at least one complement quote is required');
  for (const c of input.complementAsks) {
    if (c.price <= 0n) throw new RangeError(`non-positive complement ask for ${c.outcome}`);
  }

  const lockedShares = mulFraction(input.size, input.fraction);
  const retainedUpside = input.size - lockedShares;

  // Synthetic hedge: buy `lockedShares` of every complement.
  const askSum = input.complementAsks.reduce((acc, c) => acc + c.price, 0n);
  const hedgeFloorPerShare = PRICE_SCALE - askSum; // may be ≤ 0 ⇒ hedge locks a loss vs holding
  // Direct close: sell `lockedShares` at the hold bid.
  const closeFloorPerShare = input.holdBid ?? -1n;

  const useClose = closeFloorPerShare >= hedgeFloorPerShare;
  const floorPerShare = useClose ? closeFloorPerShare : hedgeFloorPerShare;

  if (floorPerShare <= 0n) {
    return {
      viable: false,
      reason:
        'no profitable exit: complement asks sum to ≥ 1 after fees' + (input.holdBid === null ? ' and the venue offers no direct close' : ' and the close bid is ≤ 0'),
      route: useClose ? 'CLOSE' : 'HEDGE',
      hedgeSize: 0n,
      cost: 0n,
      proceeds: 0n,
      guaranteedFloor: 0n,
      retainedUpside,
      impliedExitProb: Number(floorPerShare < 0n ? 0n : floorPerShare) / Number(PRICE_SCALE),
      edgePts: 0,
      payoutMatrix: [],
    };
  }

  const route: HedgePlan['route'] = useClose ? 'CLOSE' : 'HEDGE';
  const cost = useClose ? 0n : (lockedShares * askSum) / PRICE_SCALE;
  const proceeds = useClose ? (lockedShares * (input.holdBid as bigint)) / PRICE_SCALE : 0n;

  // Payout matrix from first principles in exact integer arithmetic
  // (DOCS.md §5.2): shares × indicator − cost + proceeds per outcome.
  //   HEDGE — hold wins: all S hold shares pay;  complement j wins: the f·S bought shares pay.
  //   CLOSE — f·S hold shares sold; remaining (1−f)·S pay only if hold wins.
  const holdRow = useClose ? retainedUpside + proceeds : input.size - cost;
  const complementRow = useClose ? proceeds : lockedShares - cost;
  const guaranteedFloor = complementRow;

  const payoutMatrix: PayoutRow[] = [
    { outcome: input.holdOutcome, total: holdRow },
    ...input.complementAsks.map((c) => ({ outcome: c.outcome, total: complementRow })),
  ];

  const impliedExitProb = Number(floorPerShare) / Number(PRICE_SCALE);
  const edgePts = (impliedExitProb - input.consensusProb) * 100;

  return {
    viable: true,
    route,
    hedgeSize: lockedShares,
    cost,
    proceeds,
    guaranteedFloor,
    retainedUpside,
    impliedExitProb,
    edgePts,
    payoutMatrix,
  };
}
