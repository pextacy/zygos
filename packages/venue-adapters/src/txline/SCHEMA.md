# TxLINE wire schema notes

**Status: awaiting hackathon credentials and feed documentation (PLAN.md T0.1).**

This file is the single record of everything learned about real TxLINE payloads:
endpoint paths, message shapes, market taxonomy, id schemes, rate limits, and
transport (WS vs REST polling). Update it in the same commit as any change to
TxLINE parsing (CLAUDE.md §7).

Nothing outside `packages/venue-adapters/src/txline/` may assume TxLINE wire
formats — the adapter translates to the internal `OddsTick` / `MatchEvent`
contract (DOCS.md §3.1).

## Open questions (asked in the TxLINE Telegram channel)

1. Does the hackathon tier include a match **event** stream (goals/cards), or odds only?
2. Transport: WebSocket, REST polling, or on-chain reads?
3. Rate limits per credential?
4. Fixture and market id scheme?

## Confirmed facts

_(none yet — fill in as credentials arrive)_

## Provisional working schema (UNCONFIRMED — replace on first real payload)

Until real docs arrive, `schema.ts` codes against this guess so the rest of the
pipeline can be built and tested. Every assumption is quarantined in
`schema.ts` + `TxLineAdapter.ts`; payloads failing validation are counted and
dropped, never guessed at.

- Transport assumed: REST polling `GET {TXLINE_BASE_URL}/v1/fixtures/{fixtureId}/live`,
  `Authorization: Bearer {TXLINE_API_KEY}`, 2s interval (within PRD latency targets).
  WS transport slots in behind `OddsFeedAdapter` once streaming is confirmed.
- Response assumed: `{ odds: WireOddsMessage[], events: WireEventMessage[] }`.
- `WireOddsMessage`: `{ packet_id, ts (ms epoch), fixture_id, market, bookmaker, prices: [{outcome, odds}] }`.
- `WireEventMessage`: `{ packet_id, ts, fixture_id, event: GOAL|RED_CARD|KICKOFF|HT|FT, team: HOME|AWAY|null }`.
- Market codes accepted: `1X2`, `MATCH_WINNER`, `OU_2_5`/`TOTAL_2.5`-style totals.
  Outcome codes accepted: `HOME/DRAW/AWAY/OVER/UNDER` and `1/X/2`.
- Dedup by `packet_id` (poll responses may repeat recent packets).
