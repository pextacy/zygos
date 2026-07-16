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
