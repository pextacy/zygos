import { describe, expect, it } from 'vitest';
import { parseMarketKey, toOddsTick, wireOddsMessageSchema } from '../src/txline/schema.js';

// Wire-format translation tests against the PROVISIONAL schema (SCHEMA.md).
// When real TxLINE docs land these fixtures are replaced with recorded
// payloads — the one sanctioned use of recordings (CLAUDE.md §6).
describe('parseMarketKey', () => {
  it('maps match-winner variants', () => {
    expect(parseMarketKey('1X2')).toEqual({ kind: '1X2' });
    expect(parseMarketKey('MATCH_WINNER')).toEqual({ kind: '1X2' });
  });

  it('maps totals with line variants', () => {
    expect(parseMarketKey('OU_2_5')).toEqual({ kind: 'TOTAL', line: 2.5 });
    expect(parseMarketKey('TOTAL_2.5')).toEqual({ kind: 'TOTAL', line: 2.5 });
    expect(parseMarketKey('OU_3')).toEqual({ kind: 'TOTAL', line: 3 });
  });

  it('returns null for unknown markets instead of guessing', () => {
    expect(parseMarketKey('CORRECT_SCORE')).toBeNull();
    expect(parseMarketKey('')).toBeNull();
  });
});

describe('toOddsTick', () => {
  const base = {
    packet_id: 'pkt-123',
    ts: 1_700_000_000_000,
    fixture_id: 'fx-9',
    market: '1X2',
    bookmaker: 'book-a',
    prices: [
      { outcome: '1', odds: 2.1 },
      { outcome: 'X', odds: 3.4 },
      { outcome: '2', odds: 3.8 },
    ],
  };

  it('translates a valid wire message, mapping 1/X/2 to HOME/DRAW/AWAY', () => {
    const msg = wireOddsMessageSchema.parse(base);
    const tick = toOddsTick(msg, 1_700_000_000_500);
    expect(tick).not.toBeNull();
    expect(tick?.packetId).toBe('pkt-123');
    expect(tick?.receivedAt).toBe(1_700_000_000_500);
    expect(tick?.outcomes).toEqual([
      { outcome: 'HOME', decimalOdds: 2.1 },
      { outcome: 'DRAW', decimalOdds: 3.4 },
      { outcome: 'AWAY', decimalOdds: 3.8 },
    ]);
  });

  it('returns null on unknown outcome codes instead of inventing a mapping', () => {
    const msg = wireOddsMessageSchema.parse({
      ...base,
      prices: [
        { outcome: 'YES', odds: 1.8 },
        { outcome: 'NO', odds: 2.0 },
      ],
    });
    expect(toOddsTick(msg, 0)).toBeNull();
  });

  it('wire schema rejects malformed messages at the boundary', () => {
    expect(wireOddsMessageSchema.safeParse({ ...base, prices: [] }).success).toBe(false);
    expect(wireOddsMessageSchema.safeParse({ ...base, ts: -1 }).success).toBe(false);
    expect(wireOddsMessageSchema.safeParse({ ...base, packet_id: '' }).success).toBe(false);
  });
});
