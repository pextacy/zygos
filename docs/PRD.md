# Zygos — Product Requirements Document (PRD)

**Version:** 1.0
**Date:** July 16, 2026
**Status:** Approved for build
**Target:** TxODDS World Cup Hackathon — Trading Tools & Agents track (Superteam Earn)
**Submission deadline:** July 19, 2026
**Winner announcement:** July 29, 2026

---

## 1. Overview

### 1.1 One-liner

Zygos (ζυγός, Ancient Greek for "scale / balance") is a real-time cash-out and hedging engine for on-chain prediction markets, powered by TxODDS TxLINE live World Cup odds data on Solana.

### 1.2 Problem statement

In-play "cash out" is the single most-used feature in traditional sportsbooks: it lets a bettor close a live position at its current value, locking in profit or cutting losses mid-match. On-chain prediction markets do not have this feature. To exit a position mid-match, a user must:

1. Determine the *true* current value of their position (the on-chain order book price frequently lags real match state by tens of seconds during live play).
2. Manually compute the exact size of the opposing position that equalizes payout across outcomes.
3. Execute that trade before the price moves again.

During a live World Cup match, prices move by the second. Retail users cannot do this math in real time, so they either exit early at bad prices or ride positions to zero. This is a known, loudly voiced gap in the on-chain prediction market UX, and World Cup volume makes it maximally visible right now.

### 1.3 Solution

Zygos is a non-custodial web application that:

1. Reads a user's open positions on Solana prediction markets directly from their connected wallet.
2. Values every position in real time against the **TxLINE de-vigged multi-bookmaker consensus probability** — not against the (laggy) on-chain price — so the user always sees fair value.
3. Computes and executes a one-click hedge ("Lock In") that guarantees a chosen payout regardless of match outcome, including partial lock-ins.
4. Lets users define protective automation rules ("if my team scores, lock 70% of profit"; "if a red card is shown against my side, halve my exposure") triggered by TxLINE's live event and odds stream. Rules are user-authored and user-signed — Zygos is a tool, not an autonomous agent.

### 1.4 Why TxLINE is essential (not decorative)

A fair cash-out price can only be computed from a low-latency, manipulation-resistant probability source. On-chain prices lag live events; a cash-out engine driven by them would systematically fill users at stale prices. TxLINE's consensus odds across bookmakers, timestamped and anchored on Solana, is precisely the trust layer this product requires. TxLINE data is the **primary input** of the system (a hackathon eligibility requirement) and the product's reason to exist.

---

## 2. Goals and non-goals

### 2.1 Goals (hackathon scope, in priority order)

| # | Goal | Success signal |
|---|------|----------------|
| G1 | Live fair-value display of connected wallet's open positions using real TxLINE data | Position card updates within ≤3s of an odds change during a real live match |
| G2 | One-click full cash-out (hedge) executed on-chain (devnet acceptable; mainnet if venue liquidity allows) | Signed transaction confirmed; resulting payout matrix is outcome-independent within slippage tolerance |
| G3 | Partial lock-in (lock X% of current profit, keep the rest exposed) | Slider UI produces correct hedge size; verified by payout matrix |
| G4 | Rule engine v1: two rule templates (goal-triggered lock, red-card exposure reduction) | Rule fires from a real TxLINE event during a live match and produces a prepared, user-signable transaction |
| G5 | Demo video recorded against a real live World Cup match (matches available July 17–18) | 2–3 min video showing goal → valuation jump → one-click lock → on-chain confirmation |

### 2.2 Non-goals (explicitly out of scope for submission)

- Custody of user funds in any form. Zygos never holds assets; all transactions are signed by the user's wallet.
- Autonomous trading without a standing user-signed authorization.
- Support for non-Solana venues (e.g., Polygon-based markets) — adapter interface allows later addition, but not built now.
- Market making, order routing optimization across venues, or MEV protection beyond basic slippage limits.
- Mobile native apps (responsive web only).
- Fiat on-ramp, KYC, or account system beyond wallet connection.

### 2.3 No-mock policy

All data paths in the submitted build run against real services:

- **Odds/events:** live TxLINE API (hackathon credentials via the TxLINE Telegram channel).
- **Positions & execution:** real Solana RPC (Helius or Triton endpoint), real venue program accounts. Execution targets devnet if the chosen venue's mainnet liquidity or geo constraints make mainnet demo impractical; devnet still exercises the identical program interface.
- No fixture files, no seeded fake positions, no simulated price feeds in the demo build. Test suites may use recorded TxLINE payloads as fixtures (testing is exempt from the no-mock policy; the running product is not).

---

## 3. Users and use cases

### 3.1 Primary persona

**The in-play prediction market trader.** Holds 1–10 open positions on Solana prediction markets during World Cup matches. Comfortable with wallets and signing transactions. Frustrated that exiting mid-match requires manual math under time pressure. Currently uses a bookmaker's cash-out feature for fiat bets and wants the same UX on-chain.

### 3.2 Secondary persona

**The casual fan-bettor.** Placed one position before the match, watches the game, panics or celebrates at goals. Wants a single green button that says "take the money." The rule engine ("lock profit automatically if we score") is built for this user.

### 3.3 Core user stories

| ID | Story | Acceptance criteria |
|----|-------|---------------------|
| US-1 | As a trader, I connect my wallet and see all my open World Cup positions with live fair value | Positions detected from on-chain accounts within 5s of connect; each shows: market, side, size, entry price, on-chain mark price, TxLINE fair value, unrealized P&L at fair value |
| US-2 | As a trader, I click "Lock In" on a profitable position and receive a guaranteed payout regardless of outcome | Hedge order preview shows guaranteed payout, fee, and slippage bound; after signing, payout matrix across all outcomes is equal within tolerance |
| US-3 | As a trader, I lock only 50% of my profit | Slider from 0–100%; hedge size scales linearly; preview updates in real time |
| US-4 | As a fan, I set a rule "if my team scores, lock 70%" before kickoff | Rule stored locally + on-chain intent hash; when TxLINE emits the goal event, app surfaces a pre-built transaction within 3s for one-tap signing (v1) — fully delegated execution is a documented v2 item |
| US-5 | As a user, I see why the fair value differs from the market price | Tooltip/panel showing per-bookmaker odds from TxLINE, the de-vig computation, and on-chain price lag in seconds |

---

## 4. Functional requirements

### 4.1 Data ingestion (FR-1x)

- **FR-10:** Subscribe to TxLINE live odds for all World Cup fixtures (match-winner / 1X2, and totals if available in the feed tier granted to hackathon participants).
- **FR-11:** Subscribe to TxLINE match event stream (goals, red cards, match start/end, period markers) where the feed provides it; otherwise infer state transitions from odds discontinuities (documented heuristic, still real data).
- **FR-12:** Normalize incoming odds into decimal format and compute **de-vigged consensus probabilities** per market using multiplicative vig removal across quoted bookmakers (see DOCS.md §4 for the exact formula), refreshed on every tick.
- **FR-13:** Persist every consumed TxLINE packet's identifier/timestamp so any displayed fair value can be traced to its source packets (auditability; aligns with TxLINE's on-chain timestamping value proposition).
- **FR-14:** Feed health indicator in the UI: last-tick age per subscribed match; degrade to explicit "STALE" state (with valuations frozen and lock-in disabled) if no tick for >30s. Never silently serve stale prices.

### 4.2 Position engine (FR-2x)

- **FR-20:** On wallet connect, enumerate the user's open positions on the integrated venue by reading program accounts via RPC (venue adapter interface; launch adapter targets one Solana prediction-market venue selected on Day 1 after liquidity check — see PLAN.md Day 1 gate).
- **FR-21:** For each position, compute: fair value = size × consensus probability of the held outcome (minus venue exit fee estimate); mark value = size × current on-chain bid; lag delta = fair − mark, with the on-chain quote's age in seconds.
- **FR-22:** Re-valuate all open positions on every TxLINE tick affecting their market; UI updates ≤3s end-to-end.

### 4.3 Hedge engine (FR-3x)

- **FR-30:** For a binary market position of size `S` at held-outcome on-chain ask/bid, compute the opposing-outcome quantity `H` that equalizes payout across outcomes for a chosen lock fraction `f ∈ [0,1]` (closed-form; see DOCS.md §5). Where the venue supports direct position reduction (sell/close), prefer close over synthetic hedge and compute equivalently.
- **FR-31:** Preview before signing: guaranteed payout per outcome, total fees, worst-case slippage at configured tolerance, and the TxLINE fair value used. The preview must state whether the offered lock price is **better or worse than fair value** and by how many probability points.
- **FR-32:** Build, simulate (`simulateTransaction`), and submit the transaction only after explicit wallet signature. On failure, no partial state: either the hedge lands or nothing changes.
- **FR-33:** Post-execution verification: re-read accounts, display realized guaranteed payout, and write a compact commitment memo on-chain (market id, direction, fraction, TxLINE packet refs hash) so the lock event itself is timestamped and auditable.

### 4.4 Rule engine v1 (FR-4x)

- **FR-40:** Two rule templates: (a) `ON goal_for(my_team) LOCK f%`; (b) `ON red_card(opponent_of_my_side = false)` i.e. red card against my side → `REDUCE exposure to 50%`.
- **FR-41:** Rules are created per position, stored client-side (localStorage is prohibited in the hosted artifact context — use in-memory + optional export; in the self-hosted production build, rules persist in the app database) and hashed into an on-chain memo at creation time (intent commitment).
- **FR-42:** When a TxLINE event matches a rule, the app immediately surfaces a prepared transaction with a full-screen prompt; execution requires one tap to sign. Median event-to-prompt latency ≤3s.
- **FR-43:** Every rule firing is logged with the triggering TxLINE packet reference.

### 4.5 UI (FR-5x)

- **FR-50:** Single-page terminal layout: (left) live match board with consensus probabilities and event ticker; (center) positions table with fair value, lag delta, P&L, Lock In button + fraction slider; (right) activity log (locks executed, rules armed/fired, feed health).
- **FR-51:** Fair-value explainer panel per market (per-bookmaker odds, de-vig math, lag).
- **FR-52:** Wallet adapter supporting Phantom, Solflare, Backpack.
- **FR-53:** Responsive down to 380px width; the demo video is desktop.
- **FR-54:** Every displayed number that originates from TxLINE carries a subtle "TxLINE" source badge with packet timestamp on hover — sponsor visibility by design, honestly earned.

---

## 5. Non-functional requirements

| Category | Requirement |
|----------|-------------|
| Latency | TxLINE tick → UI valuation update: p50 ≤1.5s, p95 ≤3s. Rule trigger → signable prompt: ≤3s. |
| Reliability | Feed reconnect with exponential backoff (max 30s); position engine resyncs from chain on every reconnect; stale-state lockout per FR-14. |
| Security | Non-custodial only. No private keys server-side. All transactions simulated before signature request. Slippage cap enforced program-side where the venue allows, client-side otherwise. TxLINE credentials only in server environment variables, never shipped to the browser. |
| Correctness | Hedge math covered by property-based tests (payout matrix equality across outcomes for random S, prices, f). De-vig covered by unit tests against hand-computed cases. |
| Compliance posture | Zygos is analytics + self-directed execution tooling. It takes no counterparty risk, holds no funds, and offers no odds of its own. Copy in the app avoids "betting" framing; positioning is "position risk management for prediction markets." Jurisdictional availability of the underlying venues is the venue's responsibility and is surfaced to the user in a disclaimer on connect. |
| Observability | Structured logs (pino) with TxLINE packet ids; /healthz endpoint reporting feed age, RPC health, and last block seen. |

---

## 6. Competitive landscape & differentiation

- **Bookmaker cash-out (bet365 et al.):** proves demand at massive scale; custodial, fiat, opaque pricing (house margin embedded in cash-out quotes). Zygos differentiates on transparency: the user sees the fair value and whether the quote beats it.
- **On-chain portfolio dashboards:** show positions but value them at on-chain marks (stale in-play) and offer no hedge execution.
- **Manual hedging:** possible today, practically unusable in-play. Zygos's entire value is compressing that workflow to one signed click at a provably fair reference price.

The defensible core is the pricing source: fair value from TxLINE's timestamped multi-book consensus, with an auditable trail from displayed price to source packets.

---

## 7. Business model (post-hackathon)

- Per-lock fee (5–15 bps of locked notional) collected in the hedge transaction, or
- Free lock-ins + subscription for the automation rule layer and multi-position risk dashboard.
- Data partnership path: Zygos is a native commercial showcase for TxLINE-as-pricing-oracle; a revenue-share or licensed-feed arrangement with TxODDS is the natural continuation — worth stating in the submission narrative.

---

## 8. Judging alignment checklist

| Judge concern | Zygos answer |
|---------------|--------------|
| Is TxLINE the primary input? | Yes — fair valuation, hedge pricing sanity, and rule triggers all derive from TxLINE; the product is inoperable without it. |
| Functional build, no vaporware? | Live app + on-chain transactions + demo recorded on a real match. |
| Why Solana? | Sub-second finality makes in-play hedging viable; TxLINE anchors its packets on Solana; target venues are Solana-native. |
| Life after the hackathon? | Clear fee/subscription model, existing user demand proven by bookmaker cash-out usage. |
| Regulatory smell test | Non-custodial analytics + self-directed execution; no odds-making, no fund custody. |

---

## 9. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| TxLINE feed tier lacks event stream (goals/cards) | Medium | Rule engine v1 weakened | Fall back to odds-discontinuity event inference (large step move in consensus = scoring event); document the heuristic; keep FR-40 templates unchanged |
| Chosen venue has thin World Cup liquidity | Medium | Mainnet demo hedges get bad fills | Day-1 liquidity gate (PLAN.md): pick venue by measured depth; devnet fallback preserves full functionality claim with real program interfaces |
| No live match window during final build hours | Low (fixtures on Jul 17–18) | Demo video quality | Record valuation/lock flow during Jul 17 match as backup footage even if build is unfinished-polish; re-record Jul 18 if possible |
| TxLINE schema differs from assumptions | Medium | Rework in ingest layer | Ingest isolated behind `OddsFeedAdapter` interface; only the adapter changes |
| Hedge math edge cases (venue fees, tick sizes) | Medium | Incorrect guaranteed payout | Property tests + on-chain post-verification (FR-33) before showing "LOCKED" state |

---

## 10. Release criteria (submission gate, July 19)

1. All G1–G3 demonstrably working against live/real data (video evidence).
2. G4 working with at least one rule template fired by a real or odds-inferred event.
3. Zero mock data paths in the deployed build (grep-audited: no `fixtures/`, `mock`, `faker` imports in `src/`).
4. README with setup, architecture diagram, and TxLINE integration description.
5. 2–3 minute demo video per PLAN.md Day 3 script.
6. Submission text emphasizing: fair-value transparency, TxLINE-as-trust-layer, non-custodial posture, post-hackathon model.
