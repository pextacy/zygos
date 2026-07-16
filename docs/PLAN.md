# Zygos — Execution Plan

**Window:** July 16 (evening) → July 19, 2026 (submission deadline on Superteam Earn)
**Track:** Trading Tools & Agents — TxODDS World Cup Hackathon
**Companion docs:** PRD.md (what/why), DOCS.md (how), CLAUDE.md (repo conventions for AI-assisted development)

Read this file top to bottom before writing any code. The plan is gated: each day ends with a hard gate that must pass before the next day's work begins. If a gate fails, execute its fallback — do not improvise scope.

---

## 0. Ground rules

1. **No mocks in the product.** Every runtime data path hits real TxLINE, real Solana RPC, real venue programs. Recorded payloads are allowed **only** inside the test suite.
2. **Working > ambitious.** Any feature that endangers the Day 3 demo gets cut in the order defined in §5 (cut list).
3. **Record early, record often.** Any time the app does something impressive during a live match, capture screen footage immediately. Demo footage is a deliverable, not an afterthought.
4. **Commit discipline.** Small commits, imperative messages, every commit leaves `main` deployable. CI (typecheck + tests) must be green before merge.

---

## 1. Day 0 — Tonight, July 16 (2–4 hours): Access & decisions

### Tasks

- [ ] **T0.1** Join the TxLINE Telegram channel (linked from the track listing on Superteam Earn) and request hackathon API credentials. Ask explicitly: (a) does the hackathon tier include a match **event** stream (goals/cards) or odds only; (b) transport (WebSocket vs REST polling vs on-chain reads); (c) rate limits; (d) fixture/market id scheme. This unblocks everything — do it first.
- [ ] **T0.2** While waiting: scaffold the monorepo per DOCS.md §2 (pnpm workspaces: `apps/web`, `apps/server`, `packages/core`, `packages/venue-adapters`). CI pipeline: typecheck, lint, vitest.
- [ ] **T0.3** Provision infrastructure: Solana RPC endpoint (Helius free tier is sufficient), devnet keypair for testing, Vercel/Fly.io projects for web/server deploys.
- [ ] **T0.4** **Venue shortlist:** identify 2–3 Solana prediction-market venues currently carrying World Cup markets. For each, note: program id, SDK availability, order model (CLOB vs AMM vs parimutuel), and whether positions are directly closeable. (Verify current venues by research tonight — the landscape moves fast; do not rely on memory.)
- [ ] **T0.5** Register the team on Superteam Earn for the Trading Tools & Agents listing if not already done.

### Gate G0 (end of tonight)

- TxLINE credential request submitted (response may arrive tomorrow — acceptable).
- Repo scaffold pushed, CI green on empty packages.
- Venue shortlist written into `docs/venue-selection.md` with liquidity-check plan.

---

## 2. Day 1 — July 17: Data spine + position engine

**Theme: by tonight, real odds flow through the system and real positions are valued.**
A World Cup match window exists today — use it for live testing (T1.7).

### Morning (data spine)

- [ ] **T1.1** Implement `OddsFeedAdapter` interface + `TxLineAdapter` against the real credentials received. Handle: connect, subscribe per fixture, tick parsing, reconnect with backoff, heartbeat/staleness tracking. All schema knowledge lives in this one file (DOCS.md §3).
- [ ] **T1.2** Implement the consensus engine in `packages/core`: decimal-odds normalization → multiplicative de-vig per bookmaker → weighted consensus probability per outcome (DOCS.md §4). Unit tests against hand-computed cases **before** wiring to live data.
- [ ] **T1.3** Packet audit log: persist `{packetId, ts, fixtureId, market, rawHash}` for every consumed tick (SQLite via Drizzle on the server; ~zero ops).

### Afternoon (venue + positions)

- [ ] **T1.4** **Venue liquidity gate (decision point, timebox 60 min):** for shortlisted venues, read live order books / pools for 2–3 World Cup markets. Selection criteria: (1) SDK or IDL quality, (2) two-sided depth ≥ $200 at <3% spread on at least the 1X2 market, (3) position closeability. Pick ONE. Record the decision and evidence in `docs/venue-selection.md`.
  - **Fallback:** if no venue passes depth on mainnet → target the venue with the best program interface on **devnet**, and state this transparently in the submission (interfaces identical; liquidity is the only difference).
- [ ] **T1.5** Implement `VenueAdapter` for the chosen venue: `getPositions(wallet)`, `getQuote(market, side, size)`, `buildHedgeTx(...)`, `buildCloseTx(...)` where supported.
- [ ] **T1.6** Position valuation service: join wallet positions × consensus probabilities → fair value, mark value, lag delta (PRD FR-21/22). Expose over a WebSocket to the (not yet built) frontend; verify with a CLI printout first.

### Evening (live-fire test)

- [ ] **T1.7** During today's live match: run the pipeline end-to-end headless. Watch consensus probabilities react to real match events in the CLI/log output. Fix parsing/latency issues now, not on demo day. Save the session log — it doubles as evidence of real-data operation.
- [ ] **T1.8** Open one small real position on the chosen venue (or devnet) with the team wallet so Day 2 has a genuine position to value and hedge.

### Gate G1 (end of Day 1)

- Live TxLINE ticks → consensus probabilities updating in logs during a real match. ✅/❌
- Team wallet position read from chain and valued at fair value. ✅/❌
- **If ❌ on TxLINE connectivity:** escalate in the Telegram channel immediately; pivot Day 2 morning to REST polling if streaming is the blocker. Polling at 2–5s intervals still satisfies latency targets.

---

## 3. Day 2 — July 18: Hedge engine + terminal UI + rules v1

**Theme: by tonight, the one-click lock works on-chain and the app looks like a product.**
Live match window today — this is the primary demo-footage session.

### Morning (hedge engine)

- [ ] **T2.1** Implement hedge math in `packages/core` (closed-form, DOCS.md §5) with property-based tests: for random size/prices/fees/fraction, the post-hedge payout matrix must be outcome-independent within tolerance.
- [ ] **T2.2** Transaction flow: preview (quote + fees + slippage bound + fair-value comparison) → `simulateTransaction` → wallet signature → send → confirm → **post-verify** by re-reading accounts (PRD FR-32/33). Commitment memo write on success.
- [ ] **T2.3** Execute a full lock-in on the Day-1 position. This is the moment the product exists — screenshot/record it.

### Afternoon (UI)

- [ ] **T2.4** Terminal layout per PRD FR-50: match board / positions table / activity log. Next.js + Tailwind; wallet-adapter for Phantom/Solflare/Backpack. Read DOCS.md §7 design notes; dark terminal aesthetic, dense but legible.
- [ ] **T2.5** Lock-In flow UI: fraction slider, preview modal with guaranteed-payout matrix, "better/worse than fair value by X pts" line (this line is the product's soul — make it prominent).
- [ ] **T2.6** Fair-value explainer panel (per-book odds table + de-vig walkthrough) and TxLINE source badges (FR-51/54).
- [ ] **T2.7** Feed-health states incl. STALE lockout (FR-14).

### Evening (rules v1 + live-fire demo capture)

- [ ] **T2.8** Rule engine v1: the two templates (goal-lock, red-card-reduce), armed per position; TxLINE event (or odds-discontinuity inference, DOCS.md §6) → full-screen signable prompt ≤3s. Log every firing with packet refs.
- [ ] **T2.9** **Primary demo capture session during tonight's match:** arm a rule, hold a position, record the whole session (raw). Target moments: tick-driven valuation movement; a goal causing a fair-value jump while the venue price visibly lags; one-click lock; explorer confirmation.
- [ ] **T2.10** Deploy web + server to production hosts; smoke-test from a clean browser + fresh wallet.

### Gate G2 (end of Day 2)

- One-click lock executed on-chain from the UI. ✅/❌
- At least one rule fired from real (or inferred) event data. ✅/❌
- Raw demo footage of a live-match session captured. ✅/❌
- **If ❌ on rules:** cut to manual-lock-only per §5 cut list; the submission narrative shifts to "automation shipping next."

---

## 4. Day 3 — July 19: Polish, video, submission

**Hard rule: no new features today. Fixes, polish, packaging only.**

### Morning

- [ ] **T3.1** Bug triage from Day-2 live session; fix only demo-path bugs.
- [ ] **T3.2** Visual polish pass: empty states, loading states, number formatting, mobile-width sanity check.
- [ ] **T3.3** No-mock audit: `grep -ri "mock\|faker\|fixture" apps/ packages/ --include='*.ts' --include='*.tsx' | grep -v test` must return nothing.
- [ ] **T3.4** README finalization: setup, architecture diagram, TxLINE integration section, venue-selection rationale, security posture.

### Afternoon

- [ ] **T3.5** **Demo video (2–3 min), script:**
  1. (0:00–0:20) Problem: cash-out is the most-used sportsbook feature; on-chain markets don't have it. Cold open on a live position losing value.
  2. (0:20–1:00) Zygos terminal during a live match: TxLINE consensus updating, on-chain price lagging, the lag delta visible on screen.
  3. (1:00–1:45) Goal moment (Day-2 footage): fair value jumps, one click, fraction slider, guaranteed-payout preview, sign, Solana explorer confirmation, memo commitment shown.
  4. (1:45–2:15) Rule engine: armed rule fires on the event, one-tap lock.
  5. (2:15–2:45) Close: "Fair value from TxLINE's timestamped multi-book consensus. Non-custodial. Every lock auditable on Solana. The scale balances — Zygos." Business model one-liner.
- [ ] **T3.6** Submission text on Superteam Earn: lead with the judging-alignment table from PRD §8, links to live app, repo, video. Submit **no later than 6 hours before the deadline** — Earn deadlines are hard cutoffs.
- [ ] **T3.7** Post-submission: share in the TxLINE Telegram channel (judges watch it) with the video link.

### Gate G3 — Release criteria = PRD §10. All six items checked before clicking Submit.

---

## 5. Cut list (execute top-down under time pressure)

1. Rule engine template (b) red-card — keep only goal-lock.
2. Fair-value explainer panel → replace with static tooltip.
3. Partial lock slider → fixed 50% / 100% buttons.
4. Rule engine entirely → manual lock only ("automation: next release").
5. Multi-market support → 1X2 only.

**Never cut:** live TxLINE valuation, one-click full lock with on-chain confirmation, the demo video, feed staleness lockout.

---

## 6. Timeline at a glance

| Slot | Jul 16 (eve) | Jul 17 | Jul 18 | Jul 19 |
|------|--------------|--------|--------|--------|
| AM | — | TxLINE adapter + consensus engine | Hedge math + on-chain lock | Bug fixes + no-mock audit |
| PM | Access, scaffold, venue shortlist | Venue gate + positions engine | Terminal UI + lock flow | Video edit + submission |
| Eve | CI green | Live-match headless test + open position | Rules v1 + **live demo capture** | Buffer / Telegram share |
