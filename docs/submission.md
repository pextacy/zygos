# Superteam Earn submission — Zygos

**Track:** Trading Tools & Agents — TxODDS World Cup Hackathon
**Links:** [Live app](TODO-vercel-url) · [Repo](TODO-github-url) · [Demo video](TODO-video-url)
_(fill the three TODO links before submitting; submit ≥6h before the deadline — Earn cutoffs are hard)_

---

## What judges care about, answered first

| Judge concern | Zygos answer |
|---|---|
| **Is TxLINE the primary input?** | Yes — fair valuation, hedge pricing sanity, and rule triggers all derive from TxLINE's de-vigged multi-book consensus; the product is inoperable without it. Every displayed number carries a TxLINE badge tracing to source packet ids, hashed into an audit log before parsing. |
| **Functional build, no vaporware?** | Live app + on-chain transactions + demo recorded on a real match. 72 automated tests including fast-check property tests on the hedge math and an end-to-end pipeline integration test. Zero mock data in runtime code (CI-enforced grep audit). |
| **Why Solana?** | Sub-second finality makes in-play hedging viable; TxLINE anchors its packets on Solana; the target venue is Solana-native. Lock commitments and rule-intent hashes are written via the Memo program — the lock event itself is timestamped on-chain. |
| **Life after the hackathon?** | Per-lock fee (5–15 bps of locked notional) or free locks + subscription for the automation layer. Bookmaker cash-out usage proves the demand at massive scale. Zygos is also a native commercial showcase for TxLINE-as-pricing-oracle — a data-partnership path with TxODDS. |
| **Regulatory smell test** | Non-custodial analytics + self-directed execution. No odds-making, no fund custody, no counterparty risk; rules are user-authored, user-signed. Venue jurisdiction is disclaimed at connect. |

## The problem

In-play **cash out** is the most-used feature in traditional sportsbooks.
On-chain prediction markets don't have it. Exiting mid-match means: know the
true current value (the on-chain book lags real events by tens of seconds),
compute the exact opposing position that equalizes payout across outcomes, and
execute before the price moves. Retail users can't do that math live — they
exit early at bad prices or ride positions to zero.

## What Zygos does

1. **Reads your positions** from the venue with your connected wallet.
2. **Values them at fair value** — TxLINE's timestamped, de-vigged,
   recency-weighted multi-bookmaker consensus — not the laggy on-chain mark.
   The gap ("lag delta") is on screen, live.
3. **One-click Lock In**: computes the cheaper of direct close vs synthetic
   hedge, shows the guaranteed payout matrix and — the product's soul — a
   plain sentence: *"This lock fills you at 61.2% — 2.8 pts above TxLINE fair
   value (58.4%)."* Partial locks via a slider. Simulate before sign, always.
4. **Protective rules**: "if my team scores, lock 70%". When TxLINE's event
   stream (or our odds-discontinuity inference — still 100% real data) fires,
   a pre-built, pre-simulated transaction appears full-screen for one tap.
   Rules pre-commit their intent hash on-chain at creation — provably armed
   *before* the event they fire on.

## Why this beats bookmaker cash-out

Bookmakers embed opaque margin in cash-out quotes. Zygos shows the fair value,
the quote, and the signed difference in probability points — the user always
knows which side of fair they're on. Non-custodial, auditable end to end:
displayed price → TxLINE packet ids → on-chain anchors; executed lock →
Memo-program commitment.

## Technical highlights

- Consensus engine: multiplicative de-vig → recency-weighted blend (τ=20s),
  60s book expiry, median outlier guard — pure functions, injected time.
- Hedge engine: closed-form, exact bigint payout matrices, property-tested
  invariant: post-hedge payout is outcome-independent.
- Staleness is a hard lockout at three layers (core throws, tx preview
  refuses, UI disables) — never a stale price shown as live.
- TxLINE free-tier activation is fully on-chain (`subscribe` → guest JWT →
  wallet-signed activation), automated in one script.
- Stack: pnpm monorepo, TS strict, Fastify + SSE ingest + WS fanout, SQLite
  audit log, Next.js terminal UI, wallet-adapter (Phantom/Solflare/Backpack).

## Honest limitations

Venue market-binding (TxLINE fixture ↔ venue market) is populated per-fixture
at match time; unmapped positions are shown unvalued rather than guessed.
Post-verify v1 confirms position reduction; strict on-chain matrix
re-verification is next. If our venue's mainnet World Cup depth proves thin,
we demo on devnet with identical program interfaces and say so.

## Team & post-hackathon

Shipping next: delegated session-key execution for rules (v2, documented),
multi-venue routing, and the TxODDS data-partnership conversation this product
is designed to start.
