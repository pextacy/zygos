/** Money is µUSD strings from the server (1_000_000 = $1). */
export function usd(micro: string | null | undefined): string {
  if (micro === null || micro === undefined) return '—';
  const n = Number(micro) / 1_000_000;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function pct(p: number | null | undefined, digits = 1): string {
  if (p === null || p === undefined) return '—';
  return `${(p * 100).toFixed(digits)}%`;
}

/** Integer percent from a ppm-of-1.0 value (fractions, thresholds): 700000 → "70%". */
export function ppmPct(ppm: number | null | undefined): string {
  if (ppm === null || ppm === undefined) return '—';
  return `${Math.round(ppm / 10_000)}%`;
}

export function signedPts(pts: number): string {
  return `${pts >= 0 ? '+' : ''}${pts.toFixed(1)} pts`;
}

export function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-GB', { hour12: false });
}

export function ageLabel(ms: number): string {
  if (!Number.isFinite(ms)) return 'no data';
  if (ms < 1_000) return '<1s';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}
