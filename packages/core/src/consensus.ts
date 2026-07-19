import { devig } from './devig.js';
import type { ConsensusSnapshot, MarketKey, OddsTick, OutcomeKey } from './types.js';

/**
 * Cross-book consensus (DOCS.md §4.2), implemented as a pure fold:
 * (state, OddsTick) → state, with snapshots computed on demand at an
 * injected `nowMs`. No clocks, no I/O (CLAUDE.md §5).
 */

export interface ConsensusConfig {
  /** Recency weight time constant: wᵦ = exp(-age/τ). */
  recencyTauMs: number;
  /** Books older than this are dropped from the blend entirely. */
  dropBookAfterMs: number;
  /** A book deviating more than this (in probability) from the unweighted median is excluded. */
  outlierMaxDeviation: number;
  /** Fewer contributing books than this ⇒ LOW_CONFIDENCE. */
  minBooks: number;
}

/** Live-play defaults (DOCS.md §4.2). */
export const DEFAULT_CONSENSUS_CONFIG: ConsensusConfig = {
  recencyTauMs: 20_000,
  dropBookAfterMs: 60_000,
  outlierMaxDeviation: 0.1,
  minBooks: 2,
};

export interface BookQuote {
  bookmakerId: string;
  packetId: string;
  sourceTs: number;
  probs: Partial<Record<OutcomeKey, number>>;
}

export interface MarketConsensusState {
  fixtureId: string;
  market: MarketKey;
  /** Latest de-vigged quote per bookmaker. */
  books: ReadonlyMap<string, BookQuote>;
}

/** Stable key for a market within a fixture, e.g. `1X2` or `TOTAL:2.5`. */
export function marketKeyString(market: MarketKey): string {
  return market.kind === '1X2' ? '1X2' : `TOTAL:${market.line}`;
}

/**
 * Inverse of `marketKeyString`. Lives beside the serializer so a new market
 * kind cannot update one without the other — a parser that lags the
 * serializer silently drops persisted rows keyed by the new format.
 */
export function parseMarketKey(s: string): MarketKey | null {
  if (s === '1X2') return { kind: '1X2' };
  const m = /^TOTAL:(\d+(?:\.\d+)?)$/.exec(s);
  if (m) return { kind: 'TOTAL', line: Number(m[1]) };
  return null;
}

/**
 * Valid outcome keys per market kind — the single vocabulary behind binding
 * validation and outcome pickers. (The web mirrors this table in
 * `MarketBindingsPanel` — it talks to the server over HTTP only and cannot
 * import this package.)
 */
export const OUTCOMES_BY_KIND: Record<MarketKey['kind'], readonly string[]> = {
  '1X2': ['HOME', 'DRAW', 'AWAY'],
  TOTAL: ['OVER', 'UNDER'],
};

/** Fold one tick into (possibly fresh) market state. Ticks older than the book's current quote are ignored. */
export function applyTick(state: MarketConsensusState | undefined, tick: OddsTick): MarketConsensusState {
  const previous = state?.books.get(tick.bookmakerId);
  if (previous && previous.sourceTs >= tick.sourceTs) {
    return state as MarketConsensusState;
  }

  const probs = devig(tick.outcomes.map((o) => o.decimalOdds));
  const quote: BookQuote = {
    bookmakerId: tick.bookmakerId,
    packetId: tick.packetId,
    sourceTs: tick.sourceTs,
    probs: Object.fromEntries(tick.outcomes.map((o, i) => [o.outcome, probs[i]])),
  };

  const books = new Map(state?.books ?? []);
  books.set(tick.bookmakerId, quote);
  return { fixtureId: tick.fixtureId, market: tick.market, books };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const lo = sorted[mid - 1];
  const hi = sorted[mid];
  return sorted.length % 2 === 0 && lo !== undefined && hi !== undefined ? (lo + hi) / 2 : (sorted[mid] as number);
}

/**
 * Compute the consensus snapshot at `nowMs`. Returns null when no book is
 * fresh enough to contribute — callers must treat that as "no price", never
 * fall back silently (CLAUDE.md §2.3).
 */
export function snapshot(
  state: MarketConsensusState,
  nowMs: number,
  cfg: ConsensusConfig = DEFAULT_CONSENSUS_CONFIG,
): ConsensusSnapshot | null {
  const fresh = [...state.books.values()].filter((b) => nowMs - b.sourceTs <= cfg.dropBookAfterMs);
  if (fresh.length === 0) return null;

  // Outlier guard (DOCS.md §4.2): only meaningful with ≥3 books.
  const excluded = new Set<string>();
  if (fresh.length >= 3) {
    const outcomes = new Set<OutcomeKey>();
    for (const book of fresh) {
      for (const key of Object.keys(book.probs) as OutcomeKey[]) outcomes.add(key);
    }
    for (const outcome of outcomes) {
      const values = fresh.map((b) => b.probs[outcome]).filter((v): v is number => v !== undefined);
      if (values.length < 3) continue;
      const med = median(values);
      for (const book of fresh) {
        const p = book.probs[outcome];
        if (p !== undefined && Math.abs(p - med) > cfg.outlierMaxDeviation) {
          excluded.add(book.bookmakerId);
        }
      }
    }
  }

  const contributing = fresh.filter((b) => !excluded.has(b.bookmakerId));
  if (contributing.length === 0) return null;

  const weights = contributing.map((b) => Math.exp(-(nowMs - b.sourceTs) / cfg.recencyTauMs));
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  const probs: Partial<Record<OutcomeKey, number>> = {};
  const outcomeKeys = new Set<OutcomeKey>();
  for (const book of contributing) {
    for (const key of Object.keys(book.probs) as OutcomeKey[]) outcomeKeys.add(key);
  }
  for (const outcome of outcomeKeys) {
    let acc = 0;
    for (let i = 0; i < contributing.length; i++) {
      const p = contributing[i]?.probs[outcome];
      // A book missing this outcome contributes its weight to others via renormalization below.
      if (p !== undefined) acc += (weights[i] as number) * p;
    }
    probs[outcome] = acc / totalWeight;
  }
  // Renormalize so Σp = 1 even if some books quote a subset of outcomes.
  const total = Object.values(probs).reduce((a, b) => a + (b ?? 0), 0);
  if (total > 0) {
    for (const key of Object.keys(probs) as OutcomeKey[]) {
      probs[key] = (probs[key] as number) / total;
    }
  }

  return {
    fixtureId: state.fixtureId,
    market: state.market,
    probs,
    bookCount: contributing.length,
    confidence: contributing.length >= cfg.minBooks ? 'OK' : 'LOW_CONFIDENCE',
    excludedBookIds: [...excluded],
    packetIds: contributing.map((b) => b.packetId),
    asOf: Math.max(...contributing.map((b) => b.sourceTs)),
  };
}
