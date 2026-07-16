import { InvalidOddsError } from './errors.js';

/**
 * Multiplicative de-vig (DOCS.md §4.1): qᵢ = 1/oᵢ, B = Σqᵢ, pᵢ = qᵢ/B.
 *
 * Chosen over Shin/power methods deliberately: standard, explainable in one
 * tooltip, robust across 1X2 odds ranges. Callers depend only on this
 * signature, so the method can be swapped without touching them.
 */
export function devig(decimalOdds: readonly number[]): number[] {
  if (decimalOdds.length < 2) {
    throw new InvalidOddsError(decimalOdds[0] ?? NaN);
  }
  for (const o of decimalOdds) {
    if (!Number.isFinite(o) || o <= 1) {
      throw new InvalidOddsError(o);
    }
  }
  const q = decimalOdds.map((o) => 1 / o);
  const booksum = q.reduce((a, b) => a + b, 0);
  return q.map((x) => x / booksum);
}

/** Booksum/overround for diagnostics and the fair-value explainer panel (FR-51). */
export function overround(decimalOdds: readonly number[]): number {
  return decimalOdds.reduce((acc, o) => {
    if (!Number.isFinite(o) || o <= 1) {
      throw new InvalidOddsError(o);
    }
    return acc + 1 / o;
  }, 0);
}
