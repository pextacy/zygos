import { describe, expect, it } from 'vitest';
import {
  normalizePhase,
  parseMarket,
  phaseTransitionEvent,
  toActionEvent,
  toOddsTick,
  txOddsRecordSchema,
  txScoreRecordSchema,
} from '../src/txline/schema.js';

// Tests against the REAL TxLINE wire format (SCHEMA.md): Prices are decimal
// odds ×1000, Ts is ms epoch, records come from /api/odds/* and /api/scores/stream.
describe('parseMarket', () => {
  it('maps full-time result vocabulary variants to 1X2', () => {
    for (const t of ['1x2', 'Match Result', 'FULLTIME_RESULT', 'Moneyline', 'WDW']) {
      expect(parseMarket(t, null, null)).toEqual({ kind: '1X2' });
    }
  });

  it('maps totals with the line from MarketParameters', () => {
    expect(parseMarket('Total Goals', '2.5', 'FT')).toEqual({ kind: 'TOTAL', line: 2.5 });
    expect(parseMarket('OU', '3.25', '')).toEqual({ kind: 'TOTAL', line: 3.25 });
  });

  it('keeps the broad goal-total vocabulary (substring match), not just the short forms', () => {
    expect(parseMarket('Total Goals Over/Under', '2.5', 'FT')).toEqual({ kind: 'TOTAL', line: 2.5 });
    expect(parseMarket('Match Total', '2.5', 'FT')).toEqual({ kind: 'TOTAL', line: 2.5 });
    expect(parseMarket('Over Under Goals', '1.5', 'FT')).toEqual({ kind: 'TOTAL', line: 1.5 });
  });

  it('skips non-full-time periods and unknown market types', () => {
    expect(parseMarket('1x2', null, 'H1')).toBeNull();
    expect(parseMarket('Asian Handicap', '-0.5', null)).toBeNull();
    expect(parseMarket('Total Goals', 'NA', null)).toBeNull();
  });

  it('never maps non-goal totals (corners/cards) onto the goals TOTAL market', () => {
    expect(parseMarket('Total Corners', '9.5', 'FT')).toBeNull();
    expect(parseMarket('Total Cards', '4.5', 'FT')).toBeNull();
    expect(parseMarket('Total Bookings', '2.5', 'FT')).toBeNull();
  });
});

describe('toOddsTick', () => {
  const base = {
    FixtureId: 17588320,
    MessageId: 'msg-abc-1',
    Ts: 1_784_216_000_000,
    Bookmaker: 'sharpbook',
    BookmakerId: 42,
    SuperOddsType: '1x2',
    InRunning: true,
    GameState: 'H1',
    MarketParameters: null,
    MarketPeriod: 'FT',
    PriceNames: ['1', 'X', '2'],
    Prices: [2100, 3400, 3800], // decimal odds ×1000 → 2.10 / 3.40 / 3.80
    Pct: ['47.619', '29.412', '26.316'],
  };

  it('translates a real-format record: Prices/1000 become decimal odds', () => {
    const rec = txOddsRecordSchema.parse(base);
    const { tick } = toOddsTick(rec, 1_784_216_000_500);
    expect(tick).not.toBeNull();
    expect(tick?.fixtureId).toBe('17588320');
    expect(tick?.packetId).toBe('msg-abc-1');
    expect(tick?.bookmakerId).toBe('sharpbook');
    expect(tick?.outcomes).toEqual([
      { outcome: 'HOME', decimalOdds: 2.1 },
      { outcome: 'DRAW', decimalOdds: 3.4 },
      { outcome: 'AWAY', decimalOdds: 3.8 },
    ]);
  });

  it('maps Over/Under price names for totals', () => {
    const rec = txOddsRecordSchema.parse({
      ...base,
      SuperOddsType: 'Total Goals',
      MarketParameters: '2.5',
      PriceNames: ['Over', 'Under'],
      Prices: [1850, 1950],
    });
    const { tick } = toOddsTick(rec, 0);
    expect(tick?.market).toEqual({ kind: 'TOTAL', line: 2.5 });
    expect(tick?.outcomes[0]).toEqual({ outcome: 'OVER', decimalOdds: 1.85 });
  });

  it('returns a reason instead of guessing on unknown vocabulary', () => {
    const unknownOutcome = toOddsTick(txOddsRecordSchema.parse({ ...base, PriceNames: ['Yes', 'No', 'Maybe'] }), 0);
    expect(unknownOutcome.tick).toBeNull();
    expect(unknownOutcome.reason).toContain('unmapped outcome');

    const unknownMarket = toOddsTick(txOddsRecordSchema.parse({ ...base, SuperOddsType: 'Corners Race' }), 0);
    expect(unknownMarket.tick).toBeNull();
    expect(unknownMarket.reason).toContain('unmapped market');
  });

  it('rejects prototype-chain outcome names — feed strings must miss, not resolve', () => {
    const { tick, reason } = toOddsTick(txOddsRecordSchema.parse({ ...base, PriceNames: ['1', 'constructor', '2'] }), 0);
    expect(tick).toBeNull();
    expect(reason).toContain('unmapped outcome');
  });

  it('rejects duplicate outcome names (they would collapse in the consensus fold)', () => {
    const { tick, reason } = toOddsTick(txOddsRecordSchema.parse({ ...base, PriceNames: ['1', '1', '2'] }), 0);
    expect(tick).toBeNull();
    expect(reason).toContain('outcome set');
  });

  it('rejects a 2-way record on a 3-way 1X2 market (different probability space)', () => {
    const { tick, reason } = toOddsTick(txOddsRecordSchema.parse({ ...base, PriceNames: ['1', '2'], Prices: [1900, 1900] }), 0);
    expect(tick).toBeNull();
    expect(reason).toContain('outcome set');
  });

  it('rejects odds at or below 1.000 (price ≤ 1000)', () => {
    const { tick, reason } = toOddsTick(txOddsRecordSchema.parse({ ...base, Prices: [1000, 3400, 3800] }), 0);
    expect(tick).toBeNull();
    expect(reason).toContain('price');
  });

  it('rejects mismatched name/price arrays', () => {
    const { tick } = toOddsTick(txOddsRecordSchema.parse({ ...base, Prices: [2100, 3400] }), 0);
    expect(tick).toBeNull();
  });
});

describe('score records → match events', () => {
  const base = {
    fixtureId: 17588320,
    ts: 1_784_216_100_000,
    action: 'Goal',
    gameState: 'H1',
    participant: 1,
    confirmed: true,
    participant1IsHome: true,
    id: 991,
  };

  it('confirmed goal by home side → GOAL/HOME', () => {
    const event = toActionEvent(txScoreRecordSchema.parse(base));
    expect(event).toMatchObject({ type: 'GOAL', team: 'HOME', fixtureId: '17588320', inferred: false });
  });

  it('away participant resolves via participant1IsHome', () => {
    const event = toActionEvent(txScoreRecordSchema.parse({ ...base, participant: 2 }));
    expect(event?.team).toBe('AWAY');
    const flipped = toActionEvent(txScoreRecordSchema.parse({ ...base, participant: 2, participant1IsHome: false }));
    expect(flipped?.team).toBe('HOME');
  });

  it('unconfirmed or disallowed goals never fire', () => {
    expect(toActionEvent(txScoreRecordSchema.parse({ ...base, confirmed: false }))).toBeNull();
    expect(toActionEvent(txScoreRecordSchema.parse({ ...base, action: 'Goal disallowed (VAR)' }))).toBeNull();
  });

  it('red card action → RED_CARD', () => {
    const event = toActionEvent(txScoreRecordSchema.parse({ ...base, action: 'Red Card', participant: 2 }));
    expect(event).toMatchObject({ type: 'RED_CARD', team: 'AWAY' });
  });

  it('phase transitions map NS→H1 as KICKOFF, →HT, →F as FT (name or numeric id)', () => {
    const rec = txScoreRecordSchema.parse({ ...base, action: null });
    expect(normalizePhase('H1')).toBe('H1');
    expect(normalizePhase(5)).toBe('F');
    expect(phaseTransitionEvent(rec, 'NS', 'H1')?.type).toBe('KICKOFF');
    expect(phaseTransitionEvent(rec, 'H1', 'HT')?.type).toBe('HT');
    expect(phaseTransitionEvent(rec, 'H2', 'F')?.type).toBe('FT');
    expect(phaseTransitionEvent(rec, 'H1', 'H1')).toBeNull();
  });
});
