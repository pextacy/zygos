import { z } from 'zod';
import type { MarketKey, MatchEvent, OddsTick, OutcomeKey } from '@zygos/core';

/**
 * PROVISIONAL TxLINE wire schema — see SCHEMA.md in this directory.
 *
 * The real shapes come with the hackathon credentials (PLAN.md T0.1). This
 * module is the ONLY place that assumes TxLINE wire formats; when real docs
 * arrive, this file and SCHEMA.md change in the same commit (CLAUDE.md §7).
 * A payload that fails validation is counted and dropped — never guessed at.
 */

export const wireOddsMessageSchema = z.object({
  packet_id: z.string().min(1),
  ts: z.number().int().positive(), // ms epoch
  fixture_id: z.string().min(1),
  market: z.string().min(1),
  bookmaker: z.string().min(1),
  prices: z
    .array(z.object({ outcome: z.string().min(1), odds: z.number().finite() }))
    .min(2),
});

export const wireEventMessageSchema = z.object({
  packet_id: z.string().min(1),
  ts: z.number().int().positive(),
  fixture_id: z.string().min(1),
  event: z.enum(['GOAL', 'RED_CARD', 'KICKOFF', 'HT', 'FT']),
  team: z.enum(['HOME', 'AWAY']).nullable(),
});

export type WireOddsMessage = z.infer<typeof wireOddsMessageSchema>;
export type WireEventMessage = z.infer<typeof wireEventMessageSchema>;

const OUTCOME_MAP: Record<string, OutcomeKey> = {
  HOME: 'HOME',
  DRAW: 'DRAW',
  AWAY: 'AWAY',
  OVER: 'OVER',
  UNDER: 'UNDER',
  '1': 'HOME',
  X: 'DRAW',
  '2': 'AWAY',
};

/** `1X2` → match winner; `OU_2_5` / `TOTAL_2.5` → totals. Unknown markets return null (skipped, logged upstream). */
export function parseMarketKey(market: string): MarketKey | null {
  if (market === '1X2' || market === 'MATCH_WINNER') return { kind: '1X2' };
  const total = /^(?:OU|TOTAL)[_:]?(\d+)(?:[._](\d))?$/.exec(market);
  if (total?.[1] !== undefined) {
    const line = Number(`${total[1]}.${total[2] ?? '0'}`);
    return { kind: 'TOTAL', line };
  }
  return null;
}

/** Translate a validated wire odds message to the internal OddsTick, or null when untranslatable. */
export function toOddsTick(msg: WireOddsMessage, receivedAt: number): OddsTick | null {
  const market = parseMarketKey(msg.market);
  if (market === null) return null;

  const outcomes: OddsTick['outcomes'] = [];
  for (const p of msg.prices) {
    const outcome = OUTCOME_MAP[p.outcome.toUpperCase()];
    if (outcome === undefined) return null;
    outcomes.push({ outcome, decimalOdds: p.odds });
  }

  return {
    packetId: msg.packet_id,
    receivedAt,
    sourceTs: msg.ts,
    fixtureId: msg.fixture_id,
    market,
    bookmakerId: msg.bookmaker,
    outcomes,
  };
}

export function toMatchEvent(msg: WireEventMessage): MatchEvent {
  return {
    packetId: msg.packet_id,
    sourceTs: msg.ts,
    fixtureId: msg.fixture_id,
    type: msg.event,
    team: msg.team,
    inferred: false,
  };
}
