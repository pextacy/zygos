import { z } from 'zod';
import type { MarketKey, MatchEvent, OddsTick, OutcomeKey } from '@zygos/core';

/**
 * REAL TxLINE wire schema, from the official docs (txline-docs.txodds.com)
 * and the txodds/tx-on-chain reference repo. Key facts (see SCHEMA.md):
 * - `Prices` are decimal odds ×1000 (README §trading: "decimal odds,
 *   multiplied by 1000 to preserve a three-decimal point precision").
 * - `Ts` is a millisecond epoch (epochDay = ts / 86_400_000 in official code).
 * - Odds records arrive via GET /api/odds/snapshot/{fixtureId},
 *   /api/odds/updates/{fixtureId}, and the /api/odds/stream SSE feed.
 * - Score actions arrive via /api/scores/stream SSE.
 * Market/outcome VOCABULARY (SuperOddsType values, PriceNames spellings) is
 * fixture-dependent per the docs ("branch from the actual odds payload") —
 * unknown vocabulary is skipped and reported, never guessed.
 */

export const txOddsRecordSchema = z
  .object({
    FixtureId: z.number().int(),
    MessageId: z.string().min(1),
    Ts: z.number().int().positive(),
    Bookmaker: z.string().min(1),
    BookmakerId: z.number().int(),
    SuperOddsType: z.string().min(1),
    InRunning: z.boolean(),
    GameState: z.string().nullish(),
    MarketParameters: z.string().nullish(),
    MarketPeriod: z.string().nullish(),
    PriceNames: z.array(z.string()).default([]),
    Prices: z.array(z.number().int()).default([]),
    Pct: z.array(z.string()).nullish(),
  })
  .passthrough();

export type TxOddsRecord = z.infer<typeof txOddsRecordSchema>;

export const txFixtureSchema = z
  .object({
    Ts: z.number().int(),
    StartTime: z.number().int(),
    Competition: z.string(),
    CompetitionId: z.number().int(),
    FixtureGroupId: z.number().int().optional(),
    Participant1Id: z.number().int(),
    Participant1: z.string(),
    Participant2Id: z.number().int(),
    Participant2: z.string(),
    FixtureId: z.number().int(),
    Participant1IsHome: z.boolean(),
  })
  .passthrough();

export type TxFixture = z.infer<typeof txFixtureSchema>;

/** Soccer action record from /api/scores/stream (loose: only fields we consume are validated). */
export const txScoreRecordSchema = z
  .object({
    fixtureId: z.number().int(),
    ts: z.number().int(),
    action: z.string().nullish(),
    gameState: z.union([z.string(), z.number()]).nullish(),
    participant: z.number().int().nullish(),
    confirmed: z.boolean().nullish(),
    participant1IsHome: z.boolean().nullish(),
    id: z.number().int().nullish(),
    seq: z.number().int().nullish(),
  })
  .passthrough();

export type TxScoreRecord = z.infer<typeof txScoreRecordSchema>;

const FULL_TIME_PERIODS = new Set(['', 'ft', 'full', 'fulltime', 'full time', 'match', '0']);

/** SuperOddsType → MarketKey. Vocabulary confirmed lazily from live payloads; unknown → null. */
export function parseMarket(superOddsType: string, marketParameters: string | null | undefined, marketPeriod: string | null | undefined): MarketKey | null {
  const period = (marketPeriod ?? '').trim().toLowerCase();
  if (!FULL_TIME_PERIODS.has(period)) return null; // PRD scope: full-time markets only

  const t = superOddsType.toLowerCase().replace(/[\s_\-/]/g, '');
  if (['1x2', 'matchresult', 'fulltimeresult', 'ftresult', 'result', 'matchodds', 'moneyline', 'ml', 'wdw'].includes(t)) {
    return { kind: '1X2' };
  }
  // Goals totals only — 'Total Corners'/'Total Cards' etc. are different markets
  // and must never blend into the goals consensus. Substring match keeps the
  // broad goal-total vocabulary ('Total Goals Over/Under', 'Match Total', …);
  // the explicit blocklist carries the non-goals exclusion.
  const isTotalVocab = t === 'ou' || t.includes('total') || t.includes('overunder') || t.includes('goalsou');
  if (isTotalVocab && !NON_GOAL_TOTAL.test(t)) {
    const line = Number.parseFloat(marketParameters ?? '');
    if (Number.isFinite(line) && line > 0) return { kind: 'TOTAL', line };
  }
  return null;
}

/** Total markets that are NOT goal totals — never blended into the goals consensus. */
const NON_GOAL_TOTAL = /corner|card|booking|foul|offside|shot|throw|penalt/;

// Map, not object literal: feed-controlled names like 'constructor'/'__proto__'
// must miss instead of resolving through the prototype chain.
const OUTCOME_NAMES = new Map<string, OutcomeKey>([
  ['1', 'HOME'],
  ['home', 'HOME'],
  ['h', 'HOME'],
  ['x', 'DRAW'],
  ['draw', 'DRAW'],
  ['d', 'DRAW'],
  ['2', 'AWAY'],
  ['away', 'AWAY'],
  ['a', 'AWAY'],
  ['over', 'OVER'],
  ['o', 'OVER'],
  ['under', 'UNDER'],
  ['u', 'UNDER'],
]);

const PRICE_SCALE_DIVISOR = 1000; // Prices are decimal odds ×1000

/**
 * Translate a validated TxLINE odds record to the internal OddsTick.
 * Returns null (reason via second tuple slot) when vocabulary is unmapped —
 * the caller logs it so live sessions surface new vocabulary immediately.
 */
export function toOddsTick(rec: TxOddsRecord, receivedAt: number): { tick: OddsTick | null; reason?: string } {
  const market = parseMarket(rec.SuperOddsType, rec.MarketParameters, rec.MarketPeriod);
  if (market === null) {
    return { tick: null, reason: `unmapped market SuperOddsType=${rec.SuperOddsType} period=${rec.MarketPeriod ?? ''}` };
  }
  if (rec.PriceNames.length !== rec.Prices.length || rec.Prices.length < 2) {
    return { tick: null, reason: `price arrays mismatched (${rec.PriceNames.length} names / ${rec.Prices.length} prices)` };
  }

  const outcomes: OddsTick['outcomes'] = [];
  for (let i = 0; i < rec.PriceNames.length; i++) {
    const name = (rec.PriceNames[i] as string).trim().toLowerCase();
    const outcome = OUTCOME_NAMES.get(name);
    if (outcome === undefined) {
      return { tick: null, reason: `unmapped outcome name "${rec.PriceNames[i]}" in ${rec.SuperOddsType}` };
    }
    const raw = rec.Prices[i] as number;
    if (raw <= PRICE_SCALE_DIVISOR) {
      return { tick: null, reason: `non-positive-edge price ${raw} for ${rec.PriceNames[i]}` };
    }
    outcomes.push({ outcome, decimalOdds: raw / PRICE_SCALE_DIVISOR });
  }

  // The outcome set must be exactly the market's: duplicates collapse in the
  // consensus fold (silently destroying probability mass) and a 2-way record
  // blended into 3-way 1X2 lives in a different probability space.
  const expected: readonly OutcomeKey[] = market.kind === '1X2' ? ['HOME', 'DRAW', 'AWAY'] : ['OVER', 'UNDER'];
  const seen = new Set(outcomes.map((o) => o.outcome));
  if (seen.size !== outcomes.length || seen.size !== expected.length || !expected.every((o) => seen.has(o))) {
    return { tick: null, reason: `outcome set [${outcomes.map((o) => o.outcome).join(',')}] does not match ${market.kind}` };
  }

  return {
    tick: {
      packetId: rec.MessageId,
      receivedAt,
      sourceTs: rec.Ts,
      fixtureId: String(rec.FixtureId),
      market,
      bookmakerId: rec.Bookmaker,
      outcomes,
    },
  };
}

/** Soccer game-phase vocabulary (docs scores/soccer-feed): name and numeric id forms. */
const PHASE_BY_TOKEN = new Map<string, string>([
  ['ns', 'NS'],
  ['1', 'NS'],
  ['h1', 'H1'],
  ['2', 'H1'],
  ['ht', 'HT'],
  ['3', 'HT'],
  ['h2', 'H2'],
  ['4', 'H2'],
  ['f', 'F'],
  ['5', 'F'],
  ['fet', 'F'],
  ['10', 'F'],
  ['fpe', 'F'],
  ['13', 'F'],
]);

export function normalizePhase(gameState: string | number | null | undefined): string | null {
  if (gameState === null || gameState === undefined) return null;
  return PHASE_BY_TOKEN.get(String(gameState).trim().toLowerCase()) ?? null;
}

function eventTeam(rec: TxScoreRecord): 'HOME' | 'AWAY' | null {
  if (rec.participant !== 1 && rec.participant !== 2) return null;
  const p1Home = rec.participant1IsHome ?? true;
  return (rec.participant === 1) === p1Home ? 'HOME' : 'AWAY';
}

/**
 * Action-based events from a score record (GOAL / RED_CARD). Phase-transition
 * events (KICKOFF/HT/FT) are derived statefully by the adapter, which knows
 * the previous phase per fixture.
 */
export function toActionEvent(rec: TxScoreRecord): MatchEvent | null {
  if (rec.confirmed === false) return null; // VAR-pending or unconfirmed actions never fire rules
  const action = (rec.action ?? '').toLowerCase();
  if (!action) return null;

  let type: MatchEvent['type'] | null = null;
  if (action.includes('goal') && !/disallow|cancel|no goal|miss/.test(action)) type = 'GOAL';
  else if (action.includes('red') && action.includes('card')) type = 'RED_CARD';
  if (type === null) return null;

  return {
    packetId: `${rec.fixtureId}:${rec.id ?? rec.seq ?? rec.ts}`,
    sourceTs: rec.ts,
    fixtureId: String(rec.fixtureId),
    type,
    team: eventTeam(rec),
    inferred: false,
  };
}

export function phaseTransitionEvent(rec: TxScoreRecord, prevPhase: string | null, newPhase: string): MatchEvent | null {
  if (prevPhase === newPhase) return null;
  let type: MatchEvent['type'] | null = null;
  if (newPhase === 'H1' && (prevPhase === 'NS' || prevPhase === null)) type = 'KICKOFF';
  else if (newPhase === 'HT') type = 'HT';
  else if (newPhase === 'F') type = 'FT';
  if (type === null) return null;
  return {
    packetId: `${rec.fixtureId}:phase:${newPhase}:${rec.ts}`,
    sourceTs: rec.ts,
    fixtureId: String(rec.fixtureId),
    type,
    team: null,
    inferred: false,
  };
}
