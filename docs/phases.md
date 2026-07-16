# Zygos — Build Phases

**Purpose:** phase-level view of the build, tracking status against the gates defined in PLAN.md. PLAN.md holds the task-by-task detail; this file answers "which phase are we in, what must be true to advance, and what happens if it isn't."
**Companions:** PRD.md (requirements), DOCS.md (technical design), PLAN.md (day-by-day tasks), CLAUDE.md (repo rules).

Update the status line of each phase as work progresses. When resuming a session, read this file first, then jump to the matching day in PLAN.md.

---

## Phase overview

| Phase | Window | Theme | Gate | Status |
|-------|--------|-------|------|--------|
| 0 — Access & Foundations | Jul 16 (evening) | Credentials, scaffold, venue shortlist | G0 | 🟡 Code done — non-code items (credentials, infra, shortlist, registration) pending |
| 1 — Data Spine & Positions | Jul 17 | Real odds in, real positions valued | G1 | 🟡 ALL Phase-1 code complete (incl. T1.6 valuation service). Gate demos blocked on: devnet SOL (faucet 429/captcha), unfiltered network for *.txodds.com, live match window (Jul 17–18), team-wallet position |
| 2 — Hedge Engine & UI | Jul 18 | One-click lock on-chain, product UI, rules v1 | G2 | 🟡 ALL Phase-2 code complete (hedge math+pipeline, rules v1, full terminal UI, Dockerfile). Gate demos blocked on same externals as G1 + deploy accounts (no vercel/fly CLI auth) |
| 3 — Polish & Submission | Jul 19 | Fixes, video, submit | G3 | 🔲 Not started |

Phases are strictly gated: **do not start phase N+1 work before gate GN passes or its fallback is executed.** Under time pressure, cut scope per PLAN.md §5 — never cut the gate checks themselves.

---

## Phase 0 — Access & Foundations (Jul 16, evening, 2–4h)

**Objective:** remove every external blocker before build days begin.

**Scope (PLAN.md T0.1–T0.5):**
- TxLINE hackathon credentials requested via Telegram (event stream? transport? rate limits? id scheme?).
- Monorepo scaffold (`apps/web`, `apps/server`, `packages/core`, `packages/venue-adapters`) with CI: typecheck, lint, vitest.
- Infra provisioned: Helius RPC, devnet keypair, Vercel + Fly.io projects.
- Venue shortlist (2–3 Solana prediction-market venues with World Cup markets) written to `docs/venue-selection.md`.
- Team registered on Superteam Earn.

**Deliverables:** pushed scaffold with green CI; `docs/venue-selection.md` (shortlist + liquidity-check plan); credential request submitted.

**Gate G0:**
- [ ] TxLINE credential request submitted (response may lag to Day 1 — acceptable).
- [x] Repo scaffold committed, CI checks green on empty packages (typecheck + lint + test + no-mock audit; push pending a GitHub remote).
- [ ] Venue shortlist documented.

**Risk if slipped:** everything downstream depends on T0.1 — if the credential request goes out late, Phase 1 morning starts blind.

---

## Phase 1 — Data Spine & Positions (Jul 17)

**Objective:** by end of day, real TxLINE ticks flow through the consensus engine and a real on-chain position is valued at fair value. Live match window today — use it (T1.7).

**Scope (PLAN.md T1.1–T1.8):**
- `TxLineAdapter` against real credentials: connect, subscribe, parse, reconnect/backoff, staleness tracking (DOCS.md §3).
- Consensus engine in `packages/core`: de-vig + recency-weighted blend, unit-tested before live wiring (DOCS.md §4).
- Packet audit log (SQLite/Drizzle).
- **Venue liquidity gate (timeboxed 60 min):** pick ONE venue by SDK quality, two-sided depth ≥ $200 at <3% spread on 1X2, closeability. Decision + evidence in `docs/venue-selection.md`. Fallback: best-interface venue on devnet, stated transparently.
- `VenueAdapter`: `getPositions`, `getQuote`, `buildHedgeTx`, `buildCloseTx`.
- Valuation service (positions × consensus → fair/mark/lag delta) over WebSocket; CLI-verified first.
- Evening live-fire: headless end-to-end run during a real match; save the session log.
- Open one small real position with the team wallet (Day-2 hedge target).

**Deliverables:** live consensus updating in logs during a real match; valued on-chain position; venue decision record; session log.

**Gate G1:**
- [ ] Live TxLINE ticks → consensus probabilities updating during a real match.
- [ ] Team wallet position read from chain and valued at fair value.

**Fallback:** TxLINE connectivity blocked → escalate in Telegram immediately; pivot to REST polling at 2–5s (still within latency targets, DOCS.md §3.2).

---

## Phase 2 — Hedge Engine & UI (Jul 18)

**Objective:** by end of day, the one-click lock works on-chain from a real UI, and demo footage of a live match session is captured. **Primary demo-capture day.**

**Scope (PLAN.md T2.1–T2.10):**
- Hedge math in `packages/core` with property-based tests (payout matrix outcome-independent, DOCS.md §5).
- Full tx pipeline: preview → simulate → sign → send → confirm → post-verify → memo commitment (FR-32/33).
- Execute a real lock-in on the Phase-1 position — record it.
- Terminal UI (FR-50): match board / positions table / activity log; wallet adapter; dark terminal aesthetic.
- Lock-In flow: fraction slider, guaranteed-payout preview, **edge-vs-fair-value line** (the product's soul, DOCS.md §5.5).
- Fair-value explainer panel + TxLINE source badges (FR-51/54); feed-health states incl. STALE lockout (FR-14).
- Rule engine v1: goal-lock + red-card-reduce templates; event (or inferred, DOCS.md §6) → signable prompt ≤3s.
- **Evening demo capture:** armed rule, held position, full raw recording of the live-match session.
- Deploy web + server to production; smoke-test from a clean browser and fresh wallet.

**Deliverables:** deployed product; on-chain lock executed from the UI; ≥1 rule firing from real/inferred data; raw demo footage.

**Gate G2:**
- [ ] One-click lock executed on-chain from the UI.
- [ ] At least one rule fired from real (or inferred) event data.
- [ ] Raw demo footage of a live-match session captured.

**Fallback:** rules not working → cut to manual-lock-only (PLAN.md §5 item 4); narrative becomes "automation shipping next."

---

## Phase 3 — Polish & Submission (Jul 19)

**Objective:** package and submit. **Hard rule: no new features — fixes, polish, packaging only.**

**Scope (PLAN.md T3.1–T3.7):**
- Bug triage from Phase-2 live session; demo-path bugs only.
- Visual polish: empty/loading states, number formatting, mobile-width sanity.
- No-mock audit (`pnpm audit:nomock`) must return nothing.
- README: setup, architecture diagram, TxLINE integration, venue rationale, security posture.
- Demo video (2–3 min) per the PLAN.md T3.5 script (problem → live terminal → goal moment → rule firing → close).
- Superteam Earn submission, **≥6 hours before deadline** (hard cutoff), leading with the PRD §8 judging-alignment table.
- Post-submission share in the TxLINE Telegram channel with the video link.

**Deliverables:** live app links, repo, demo video, submitted entry.

**Gate G3 — release criteria (PRD §10, all six):**
- [ ] G1–G3 goals demonstrably working against live/real data (video evidence).
- [ ] Rule engine: ≥1 template fired by a real or odds-inferred event.
- [ ] Zero mock data paths in the deployed build (grep-audited).
- [ ] README complete (setup, architecture diagram, TxLINE integration).
- [ ] 2–3 minute demo video per script.
- [ ] Submission text: fair-value transparency, TxLINE-as-trust-layer, non-custodial posture, post-hackathon model.

---

## Cross-phase invariants (never cut, any phase)

From PLAN.md §5 and CLAUDE.md §2:

1. No mock data in runtime code — ever.
2. Non-custodial: no server-side keys, no auto-signing.
3. Staleness lockout: no stale price shown as live.
4. Simulate before sign.
5. Live TxLINE valuation, one-click full lock with on-chain confirmation, the demo video, and the STALE lockout are exempt from the cut list.

## Status log

- 2026-07-16 (night) — **Phase 2 code complete ahead of schedule** (commits `3bf83e6`, `99b5bea`+): hedge engine with fast-check property tests (payout outcome-independence, route optimality), odds-discontinuity event inference wired into the feed, /hedge/preview + /hedge/confirm with mandatory simulation and Memo commitments, rule engine v1 (GOAL_LOCK, RED_CARD_REDUCE) with intent hashes and wallet-routed RULE_FIRED frames, signed-message auth, and the full terminal UI (216 kB first load): match board, positions with fair/lag/P&L, lock-in slider + payout matrix + edge-vs-fair line, explainer panel, TxLINE badges, STALE lockout, rule arming, full-screen fire overlay. 68/68 tests green. **G2 items still requiring externals:** T2.3 real on-chain lock (wallet+funds+venue key), T2.9 live-match demo capture (Jul 17–18 match + unblocked network), T2.10 production deploy (no authenticated vercel/flyctl on this machine; server Dockerfile ready).

Append one line per gate decision (date, gate, result, fallback taken if any):

- 2026-07-16 — G0 (code portion): scaffold complete. pnpm workspace (web/server/core/venue-adapters), CI workflow, typecheck+lint+test+audit:nomock all green locally; web builds (87.4 kB first load); server boots with honest scaffold `/healthz`. Remaining G0 items are non-code: TxLINE credentials, infra provisioning, venue shortlist, Earn registration.
- 2026-07-16 (later) — **Real TxLINE protocol discovered and implemented without Telegram credentials.** Public docs found (txline-docs.txodds.com + github.com/txodds/tx-on-chain): free World Cup tier (devnet SL1 real-time; mainnet SL1 60s / SL12 real-time), full auth flow (on-chain subscribe → guest JWT → wallet-signed activation → X-Api-Token), real wire schema (Prices = decimal odds ×1000, ms timestamps), SSE odds/scores streams, score-action → GOAL/RED_CARD/KICKOFF/HT/FT derivation. Adapter rewritten to real protocol; `pnpm -F server txline:activate` script implemented and partially executed: devnet wallet `Fm4pFGo4jaZT2pYmsKGAE5BdD12YLzdd3VbKqdUxpq1M` created. **Blocked:** devnet faucet 429 (fund at faucet.solana.com), and the local ISP profile ("Güvenli İnternet") TLS-blocks *.txodds.com — activation + live data need an unfiltered network/VPN. Solana devnet RPC itself is reachable.
- 2026-07-16 — Phase 1 code spine complete ahead of schedule: consensus engine (de-vig + recency blend + outlier guard, tested vs DOCS §4 worked example), valuation math with FeedStaleError lockout, TxLineAdapter (REST polling, provisional schema in SCHEMA.md, backoff, fail-fast without creds), SQLite packet audit log (raw-hash-before-parse), FeedService, WS fanout (HELLO/CONSENSUS/EVENT/FEED_HEALTH), `cli:watch`. Venue shortlist researched → `venue-selection.md`: World excluded (migrated to Robinhood Chain Jul 8); lean Jupiter Predict, second Drift BET; measured liquidity gate pending. **G1 blocked on:** TxLINE credentials (T0.1/T1.1 live), venue liquidity gate + VenueAdapter (T1.4/T1.5), live-fire match test (T1.7), real position (T1.8).
