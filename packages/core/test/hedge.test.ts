import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { planHedge, type HedgeInput } from '../src/hedge.js';
import { PRICE_SCALE } from '../src/valuation.js';

/**
 * First-principles payout recomputation, independent of planHedge's formulas
 * (CLAUDE.md §6 property test): shares × indicator − cost + proceeds.
 */
function firstPrinciplesMatrix(input: HedgeInput, hedgeSize: bigint, route: 'CLOSE' | 'HEDGE') {
  const askSum = input.complementAsks.reduce((a, c) => a + c.price, 0n);
  if (route === 'HEDGE') {
    const cost = (hedgeSize * askSum) / PRICE_SCALE;
    return [
      { outcome: input.holdOutcome, total: input.size - cost }, // all S hold shares pay
      ...input.complementAsks.map((c) => ({ outcome: c.outcome, total: hedgeSize - cost })),
    ];
  }
  const proceeds = (hedgeSize * (input.holdBid as bigint)) / PRICE_SCALE;
  return [
    { outcome: input.holdOutcome, total: input.size - hedgeSize + proceeds }, // remaining hold shares + banked sale
    ...input.complementAsks.map((c) => ({ outcome: c.outcome, total: proceeds })),
  ];
}

const priceArb = fc.bigInt({ min: 1n, max: PRICE_SCALE - 1n });
const sizeArb = fc.bigInt({ min: 1n, max: 1_000_000_000_000n });
const fractionArb = fc.integer({ min: 1, max: 1_000_000 }).map((n) => n / 1_000_000);

describe('planHedge (DOCS.md §5) — property tests', () => {
  it('post-hedge payout is outcome-independent across all non-hold outcomes, and fully flat at f=1', () => {
    fc.assert(
      fc.property(
        sizeArb,
        fractionArb,
        fc.array(priceArb, { minLength: 1, maxLength: 2 }),
        fc.option(priceArb, { nil: null }),
        (size, fraction, complementPrices, holdBid) => {
          const input: HedgeInput = {
            size,
            fraction,
            holdOutcome: 'HOLD',
            complementAsks: complementPrices.map((price, i) => ({ outcome: `C${i}`, price })),
            holdBid,
            consensusProb: 0.5,
          };
          const plan = planHedge(input);
          if (!plan.viable) return true;

          // Independent recomputation must match exactly (integer math).
          const expected = firstPrinciplesMatrix(input, plan.hedgeSize, plan.route);
          expect(plan.payoutMatrix).toEqual(expected);

          // All complement outcomes yield the identical floor.
          const complementTotals = plan.payoutMatrix.slice(1).map((r) => r.total);
          for (const t of complementTotals) expect(t).toBe(plan.guaranteedFloor);

          // Full lock ⇒ matrix flat across every outcome (within 1 base unit of rounding).
          if (fraction === 1) {
            const holdRow = plan.payoutMatrix[0]?.total as bigint;
            const diff = holdRow - plan.guaranteedFloor;
            expect(diff >= -1n && diff <= 1n).toBe(true);
          }
          return true;
        },
      ),
      { numRuns: 500 },
    );
  });

  it('picks the route with the higher guaranteed floor', () => {
    fc.assert(
      fc.property(sizeArb, fc.array(priceArb, { minLength: 1, maxLength: 2 }), priceArb, (size, complementPrices, holdBid) => {
        const askSum = complementPrices.reduce((a, b) => a + b, 0n);
        const plan = planHedge({
          size,
          fraction: 1,
          holdOutcome: 'HOLD',
          complementAsks: complementPrices.map((price, i) => ({ outcome: `C${i}`, price })),
          holdBid,
          consensusProb: 0.5,
        });
        if (!plan.viable) return true;
        const closeFloor = holdBid;
        const hedgeFloor = PRICE_SCALE - askSum;
        expect(plan.route).toBe(closeFloor >= hedgeFloor ? 'CLOSE' : 'HEDGE');
        return true;
      }),
      { numRuns: 300 },
    );
  });

  it('is not viable exactly when neither route has a positive floor', () => {
    fc.assert(
      fc.property(sizeArb, fc.array(priceArb, { minLength: 1, maxLength: 2 }), fc.option(priceArb, { nil: null }), (size, complementPrices, holdBid) => {
        const askSum = complementPrices.reduce((a, b) => a + b, 0n);
        const plan = planHedge({
          size,
          fraction: 0.5,
          holdOutcome: 'HOLD',
          complementAsks: complementPrices.map((price, i) => ({ outcome: `C${i}`, price })),
          holdBid,
          consensusProb: 0.5,
        });
        const bestFloor = holdBid !== null && holdBid >= PRICE_SCALE - askSum ? holdBid : PRICE_SCALE - askSum;
        expect(plan.viable).toBe(bestFloor > 0n);
        return true;
      }),
      { numRuns: 300 },
    );
  });
});

describe('planHedge — worked examples', () => {
  it('binary full lock: S=10, p_B=0.45 → G = S(1−p_B) = 5.5 (DOCS §5.1)', () => {
    const plan = planHedge({
      size: 10_000_000n,
      fraction: 1,
      holdOutcome: 'HOME',
      complementAsks: [{ outcome: 'AWAY', price: 450_000n }],
      holdBid: null,
      consensusProb: 0.5,
    });
    expect(plan.viable).toBe(true);
    expect(plan.route).toBe('HEDGE');
    expect(plan.guaranteedFloor).toBe(5_500_000n);
    expect(plan.cost).toBe(4_500_000n);
    expect(plan.impliedExitProb).toBeCloseTo(0.55, 9);
    expect(plan.edgePts).toBeCloseTo(5, 9); // 55% exit vs 50% fair = +5 pts
  });

  it('1X2 partial lock: f=0.5, p₂+p₃=0.8 → floor f·S·0.2, upside (1−f)·S (DOCS §5.4)', () => {
    const plan = planHedge({
      size: 10_000_000n,
      fraction: 0.5,
      holdOutcome: 'HOME',
      complementAsks: [
        { outcome: 'DRAW', price: 350_000n },
        { outcome: 'AWAY', price: 450_000n },
      ],
      holdBid: null,
      consensusProb: 0.25,
    });
    expect(plan.viable).toBe(true);
    expect(plan.guaranteedFloor).toBe(1_000_000n); // 5 × 0.2
    expect(plan.retainedUpside).toBe(5_000_000n);
    expect(plan.payoutMatrix[0]).toEqual({ outcome: 'HOME', total: 6_000_000n });
    expect(plan.edgePts).toBeCloseTo(-5, 9); // 20% exit vs 25% fair = worse by 5 pts, stated honestly
  });

  it('prefers direct close when the bid beats the synthetic hedge (DOCS §5.3)', () => {
    const plan = planHedge({
      size: 10_000_000n,
      fraction: 1,
      holdOutcome: 'HOME',
      complementAsks: [{ outcome: 'AWAY', price: 450_000n }],
      holdBid: 560_000n, // 0.56 > 1−0.45
      consensusProb: 0.5,
    });
    expect(plan.route).toBe('CLOSE');
    expect(plan.guaranteedFloor).toBe(5_600_000n);
    expect(plan.proceeds).toBe(5_600_000n);
  });

  it('refuses the lock when complements sum ≥ 1 after fees (DOCS §5.4)', () => {
    const plan = planHedge({
      size: 10_000_000n,
      fraction: 1,
      holdOutcome: 'HOME',
      complementAsks: [
        { outcome: 'DRAW', price: 500_000n },
        { outcome: 'AWAY', price: 520_000n },
      ],
      holdBid: null,
      consensusProb: 0.4,
    });
    expect(plan.viable).toBe(false);
    expect(plan.reason).toContain('no profitable exit');
  });

  it('rejects invalid fractions and sizes', () => {
    const base = {
      size: 1_000_000n,
      holdOutcome: 'HOME',
      complementAsks: [{ outcome: 'AWAY', price: 500_000n }],
      holdBid: null,
      consensusProb: 0.5,
    };
    expect(() => planHedge({ ...base, fraction: 0 })).toThrow(RangeError);
    expect(() => planHedge({ ...base, fraction: 1.5 })).toThrow(RangeError);
    expect(() => planHedge({ ...base, fraction: 1, size: 0n })).toThrow(RangeError);
  });
});
