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
| 3 — Polish & Submission | Jul 19 | Fixes, video, submit | G3 | 🟡 All writable deliverables done (README, submission text, video script, polish, no-mock audit). Pending: live-evidence criteria (video recording, live G1/G2 proof) + the Earn submission click |

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

## Phase 4 — v2: Delegated Execution & Post-Hackathon (after Jul 19)

**Objective:** ship the roadmap items the submission explicitly documents as
v2, without ever weakening the non-custodial model.

**Scope (from PRD US-4 "fully delegated execution is a documented v2 item",
DOCS §7, PRD §7 business model):**
- **Delegated rule execution (marquee item):** the user pre-signs the exact
  lock transaction at arm time, built on a **durable nonce** so it stays valid
  until the event; when the rule fires, the server *submits* the already-signed
  transaction — no signature at 3 a.m., and still zero key custody: the server
  can only ever land the one pre-agreed transaction, with slippage bounds
  baked in. Fallback to the one-tap prompt when submission fails or quotes
  moved beyond the signed bounds.
- Multi-venue: second `VenueAdapter` (Drift BET) behind the same interface.
- Ops: monitoring/alerting beyond /healthz, fee model wiring (per-lock bps).

**Gate G4:**
- [ ] Delegated flow works end-to-end on devnet: arm → nonce setup → pre-sign → event → server-submitted lock confirmed on-chain, with prompt fallback proven.
- [ ] Security review of the stored pre-signed tx path (threat: DB leak ⇒ early submission of the pre-agreed lock only — document and bound).
- [ ] Second venue adapter passing the same integration suite.

**Status:** 🟡 delegated-execution core implemented and tested; security review done (`security-review-delegation.md` — verdict: acceptable with 3 pre-mainnet requirements). Second venue adapter deliberately deferred to the liquidity-gate outcome (venue-selection.md — unverifiable SDK guesswork rejected). On-chain E2E pending the same externals as G1–G3.

---

## Cross-phase invariants (never cut, any phase)

From PLAN.md §5 and CLAUDE.md §2:

1. No mock data in runtime code — ever.
2. Non-custodial: no server-side keys, no auto-signing.
3. Staleness lockout: no stale price shown as live.
4. Simulate before sign.
5. Live TxLINE valuation, one-click full lock with on-chain confirmation, the demo video, and the STALE lockout are exempt from the cut list.

## Status log

- 2026-07-19 — **.env loading fixed (real gap) + local env bootstrapped.** `loadEnv()` never actually read the documented `.env` file — it only parsed `process.env`, so the "copy .env.example to .env" flow silently did nothing. Now loads `./.env` via Node's built-in `process.loadEnvFile` (real env vars win; missing file fine for CI/Fly), and empty-string values (blank keys in a copied example) are treated as unset instead of failing the one-char-minimum validation at boot. Verified live: boot with the new `.env` → `/healthz` reports `rpc.configured: true`. Local `.env` + `.env.local` created (enc key generated, devnet RPC set). TxLINE activation attempted: project wallet `Fm4pFGo4jaZT2pYmsKGAE5BdD12YLzdd3VbKqdUxpq1M` created under `apps/server/data/`, but devnet faucet 429'd (needs manual funding at faucet.solana.com) and `*.txodds.com` is TLS-blocked from this network (script's own filtered-ISP note) — re-run `pnpm -F server txline:activate` funded + on an unfiltered network; state resumes from the recorded step. 124/124 tests, typecheck, lint, no-mock green.

- 2026-07-18 — **Round 3: market-key grammar consolidated into core + live boot re-verified.** `parseMarketKey` and `OUTCOMES_BY_KIND` moved to `@zygos/core` beside `marketKeyString` (server re-exports for existing importers; web mirror in `MarketBindingsPanel` documented) — adding a market kind now updates serializer, parser and outcome vocabulary in one file, closing the silent-binding-drop drift. New core tests: parse↔serialize round-trip + vocabulary shape. Credential-less boot smoke-tested live post-fixes: `/healthz` honest (feed-not-configured, db configured), `/bindings` serves from DB, invalid auth → 401, malformed wallet → 400, SIGTERM → 'graceful shutdown started' → 'shutdown complete' → port released. 124/124 tests, typecheck, lint, no-mock, build (234 kB) green.

- 2026-07-18 — **Review round 2: remaining plausible findings + drift-prevention closed.** (a) TxLINE odds records without an attributable FixtureId are now reported (`onParseError`) but never persisted — the account-wide stream can no longer grow `raw_packets` with unattributable `'*'` rows that `/verify/odds` could never serve anyway. (b) `storeDelegation` now mirrors the client's pre-sign check server-side (no System-program instruction after the leading nonce advance) so the two checks can't drift; delegation test fixtures switched to a realistic non-System venue instruction and a new adversarial case covers the hidden-transfer rejection. (c) The `unmapped:` fixture marker is now defined once per side: `UNMAPPED_FIXTURE_PREFIX`/`unmappedMarketIdOf` exported from `@zygos/venue-adapters` (adapter + server valuation) with a documented mirror in `apps/web/src/lib/positions.ts` (web can't import the package) consumed by PositionsTable and Terminal. (d) ppm→percent rendering unified behind `ppmPct()` (format.ts) and `thresholdLabel` exported/shared — rule cards, Automation IF/THEN table and the ledger can no longer disagree on the same number; ledger CSV keeps its numeric column. (e) README bundle figure trued up (234 kB). 122/122 tests, typecheck, lint, no-mock, build green.

- 2026-07-18 — **Adversarial production-readiness review: 15 confirmed findings fixed (correctness, security, efficiency).** A multi-angle review of the uncommitted tree confirmed and closed: (1) **PRICE_LOCK fired without a cross** when the first observed tick was already beyond the threshold (fresh arm or restart wiping the in-memory `lastProb`) — first tick now only sets the baseline; with a delegated pre-signed tx armed this could have auto-submitted on a never-observed cross. (2) **A non-viable preview latched `firedAt`** (returned without throwing) — now consumes the cross without latching, like the thrown path. (3) **`/hedge/confirm` fabricated verified locks**: a never-existing positionRef read as "closed" (`before===null && after===null → shrunk`) letting any authed wallet write junk 'unknown' ledger rows — verification now requires `before !== null`. (4) **Confirm ignored the preview's fraction**, pairing another fraction's floor/edge with the submitted fractionPpm in the ledger — plan is now matched on wallet+positionRef+fraction. (5) **Packet audit inserts were fire-and-forget** while frames fanned out synchronously (client-cited packetId could 404 at `/verify/odds`; crash lost provenance) — ticks now process on a serialized audited chain (`flushTicks()` for tests/shutdown). (6) **PUT /bindings 500'd on non-string bodies** and persisted unbounded `note` — typed runtime checks in `BindingRegistry.upsert` (400s). (7) **`postgres://localhost` forced TLS** (regex required `user@`) — host now URL-parsed. (8) **Secret-less Fly deploy silently ran on ephemeral PGlite** — loud production boot warning + fly.toml documents `DELEGATION_ENC_KEY`/volume requirement. (9) **TOTAL vocabulary regression**: closed allowlist dropped 'Total Goals Over/Under'/'Match Total' — back to substring matching with an explicit non-goals blocklist (corners/cards/etc.); SCHEMA.md updated. (10) **Revoke signed without simulation** — revoke tx now shape-checked (exactly one decoded nonce-advance, this wallet's authority) and simulated before any signature prompt; the arm-time client check upgraded from a keys[0] heuristic to `decodeNonceAdvance` (blocks WithdrawNonce/AuthorizeNonce spoofs). Efficiency: per-tick rules SELECT gated by an in-memory armed-PRICE_LOCK index, `/locks` double query collapsed, hedge quotes fetched concurrently, `/rules` delegation N+1 → one `inArray` query, ledger refetch only on RULE_EXECUTED. Trade logs now carry full fixtureId/market/packetId provenance. 122/122 tests green (5 new regressions: arm-while-beyond, non-viable no-latch, fabricated-positionRef, fraction-mismatch, non-string bindings + broad goal-total vocab); typecheck/lint/no-mock/build green.

- 2026-07-18 — **Delegation security requirements closed + FR-33 audit chain completed (prod-readiness push):** all three `security-review-delegation.md` pre-mainnet requirements shipped. (1) **Revoke**: `POST /rules/:id/revoke` erases the stored pre-signed tx immediately and returns an unsigned `nonceAdvance` the wallet signs to void leaked copies on-chain; Revoke buttons in Quick Rules + Automation; status pill shows Revoked. (2) **Client-side pre-sign check** (bounded): fee payer, leading nonceAdvance on the declared nonce, no extra System-program instructions. (3) **At-rest encryption**: AES-256-GCM over stored pre-signed txs via `DELEGATION_ENC_KEY` (self-describing `enc:v1:` blobs, no migration needed; boot warns when unset). Plus the memo audit gap: `locks.memo_sig` column, `/hedge/confirm` returns `lockId`, `PATCH /locks/:id/memo` persists the memo signature (wallet-bound), ledger UI links the memo tx and CSV export includes it. 117/117 tests green (5 new: revoke shape/no-re-execution/wallet-binding, ciphertext-at-rest + transparent decrypt, crypto unit, memo attach ownership); typecheck/lint/no-mock green.

- 2026-07-17 — **DB layer migrated to Postgres for Neon deployment:** persistence moved from better-sqlite3 to the Drizzle **pg dialect** with driver selection by `DATABASE_URL` — `postgres://…` → node-postgres pool with TLS (Neon, production), a directory path → embedded PGlite (zero-setup local dev, the new default `./data/pglite`), `memory://` → in-memory PGlite (tests/CI). One schema and one idempotent boot migration for all three (ms-epoch timestamps now BIGINT; `ADD COLUMN IF NOT EXISTS` replaces the sqlite pragma migration). All DB call sites converted to async (ledger, rules, bindings, routes; feed audit inserts are fire-and-forget off the tick path); `BindingRegistry` gains an async `open()` factory. `.env.example`/CLAUDE.md §9 document the Neon URL; Dockerfile now expects `DATABASE_URL` as a Fly secret (PGlite-on-volume fallback without it). Note: old local SQLite files (`./data/zygos.db`) are not auto-migrated — dev-only data. 105/105 tests green on PGlite; typecheck/lint/no-mock audit green.
- 2026-07-17 — **Production-readiness sweep (no-mock + deployability):** deep mock audit beyond `audit:nomock` came back clean (no mock/stub/placeholder data, no TODO/FIXME, no stray `console.log` outside the CLI, no hardcoded values beyond well-known program ids/USDC mint; UI `placeholder=` attributes and "no stub mode" comments are the only pattern hits — not data). Hardening shipped: **graceful shutdown** on SIGTERM/SIGINT (terminate WS clients, close TxLINE stream, close Fastify, 10s hard deadline — verified live: boot → SIGTERM → 'shutdown complete' → port released), missing `apps/web/.env.example` added (the only two NEXT_PUBLIC_ vars, per CLAUDE.md §9), `ADMIN_WALLETS` documented in the server env example, stale README bundle figure corrected (229 kB). Credential-less boot smoke-tested: `/healthz` reports honest feed-not-configured, `/bindings` serves from the DB. 105/105 tests, typecheck, lint, no-mock audit green. Delegation's three pre-mainnet items (revoke, instruction diff, at-rest encryption) remain tracked v2.1 per `security-review-delegation.md` — gated on mainnet delegation, not this deploy.
- 2026-07-17 — **PRICE_LOCK rule template + ledger CSV export shipped (new feature, closes the "no price/edge triggers" gap and the FR-41 export gap):** the rule engine gains its first price-triggered template — `PRICE_LOCK` fires when the de-vigged TxLINE consensus probability of the position's outcome crosses an armed threshold (`ABOVE` = take-profit, `BELOW` = cut), edge-triggered on the crossing tick and one-shot (latched `firedAt`, persisted; a failed preview consumes the cross silently and re-arms on re-cross — no per-tick spam, never an unsimulated prompt). Fires through the same preview→simulate→`RULE_FIRED` path as event rules, with a `PRICE_CROSS` trigger (`{outcome, prob, threshold, direction, packetId}`) as provenance; delegated pre-signed execution works unchanged. Intent hash folds `{thresholdPpm, direction}` in for PRICE_LOCK only — event-template hashes stay byte-identical so prior on-chain commitments still recompute. DB: additive `threshold`/`direction`/`fired_at` columns with pragma-guarded migration. UI: third template in Arm Rule (direction select + threshold slider seeded from live consensus), price-target fire overlay, threshold shown in Quick Rules/Automation, fired-state marker. Plus Lock Ledger **Export CSV** (RFC-4180, client-side blob — closes FR-41's "optional export"). 105/105 tests green (6 new in `rules.test.ts`: validation, hash stability, cross+latch, BELOW direction, fixture/market isolation, failed-preview re-arm); typecheck/lint/no-mock audit green; web first load 228 kB (budget 300 kB).
- 2026-07-17 — **Market binding registry shipped (new feature, closes README known-limitation #1):** the TxLINE fixture ↔ Jupiter market mapping is now a persistent, managed registry instead of an empty in-memory map with no population path. New `market_bindings` table + `BindingRegistry` (validated upserts: market key parsing, outcome-per-market-kind checks); the registry's live map is shared by reference with `JupiterPredictAdapter`, so bindings apply to position mapping and quote routing immediately, and `ValuationService.refreshAllWallets()` re-maps cached `UNMAPPED_OUTCOME` positions on every change. Endpoints: `GET /bindings`, `GET /bindings/candidates` (unbound marketIds seen on real positions + tracked fixtures/markets), `PUT`/`DELETE /bindings/:marketId` (wallet-signed; optional `ADMIN_WALLETS` env restricts writers). Analytics view gained a Market Bindings panel (candidate-fed form, signed writes, live table). 6 new tests in `bindings.test.ts` (registry CRUD/validation/persistence, adapter live-propagation, UNMAPPED→mapped valuation transition); typecheck/lint/no-mock audit green.

- 2026-07-17 — **Lock ledger shipped (new feature, closes the FR-33 persistence gap):** every verified executed lock is now recorded server-side (`locks` table) with route, guaranteed floor, edge vs TxLINE fair value at signature time, tx signature, source (manual / rule prompt / delegated) and packet provenance. Plan fields come only from a server-cached preview looked up by `previewId` at `/hedge/confirm` — client-supplied numbers are never trusted. Delegated submissions record with the trigger packet as provenance. New `GET /locks/:wallet` (history + cumulative stats: count, Σ floors secured, avg edge); Portfolio view gained a Lock Ledger panel with per-lock edge, explorer links and TxLINE badges. 93/93 tests green (6 new in `ledger.test.ts`: ledger unit, preview→confirm recording incl. unverified-no-record, RULE-source tagging, delegated recording); typecheck/lint/no-mock audit green; web first load 226 kB (budget 300 kB).
- 2026-07-16 (late night) — **Phase 3 writable deliverables complete two days ahead of schedule:** README finalized (T3.4: quickstart, architecture diagram, TxLINE integration, security posture, honest limitations), Superteam Earn submission text drafted leading with the judging-alignment table (T3.6 — three TODO links to fill: app/repo/video), shot-by-shot demo video script mapped to runbook captures (T3.5 writing), UI polish + demo-path bug triage (T3.1/T3.2: post-lock client position refresh — real bug fixed; loading/refresh states; mobile overflow). No-mock audit green (T3.3). **G3 remaining:** the six release criteria's live-evidence items (video recording, live-data proof of G1/G2) and the physical submission — all downstream of the same externals as G1/G2.
- 2026-07-16 (night) — **Phase 2 code complete ahead of schedule** (commits `3bf83e6`, `99b5bea`+): hedge engine with fast-check property tests (payout outcome-independence, route optimality), odds-discontinuity event inference wired into the feed, /hedge/preview + /hedge/confirm with mandatory simulation and Memo commitments, rule engine v1 (GOAL_LOCK, RED_CARD_REDUCE) with intent hashes and wallet-routed RULE_FIRED frames, signed-message auth, and the full terminal UI (216 kB first load): match board, positions with fair/lag/P&L, lock-in slider + payout matrix + edge-vs-fair line, explainer panel, TxLINE badges, STALE lockout, rule arming, full-screen fire overlay. 68/68 tests green. **G2 items still requiring externals:** T2.3 real on-chain lock (wallet+funds+venue key), T2.9 live-match demo capture (Jul 17–18 match + unblocked network), T2.10 production deploy (no authenticated vercel/flyctl on this machine; server Dockerfile ready).

Append one line per gate decision (date, gate, result, fallback taken if any):

- 2026-07-16 — G0 (code portion): scaffold complete. pnpm workspace (web/server/core/venue-adapters), CI workflow, typecheck+lint+test+audit:nomock all green locally; web builds (87.4 kB first load); server boots with honest scaffold `/healthz`. Remaining G0 items are non-code: TxLINE credentials, infra provisioning, venue shortlist, Earn registration.
- 2026-07-16 (later) — **Real TxLINE protocol discovered and implemented without Telegram credentials.** Public docs found (txline-docs.txodds.com + github.com/txodds/tx-on-chain): free World Cup tier (devnet SL1 real-time; mainnet SL1 60s / SL12 real-time), full auth flow (on-chain subscribe → guest JWT → wallet-signed activation → X-Api-Token), real wire schema (Prices = decimal odds ×1000, ms timestamps), SSE odds/scores streams, score-action → GOAL/RED_CARD/KICKOFF/HT/FT derivation. Adapter rewritten to real protocol; `pnpm -F server txline:activate` script implemented and partially executed: devnet wallet `Fm4pFGo4jaZT2pYmsKGAE5BdD12YLzdd3VbKqdUxpq1M` created. **Blocked:** devnet faucet 429 (fund at faucet.solana.com), and the local ISP profile ("Güvenli İnternet") TLS-blocks *.txodds.com — activation + live data need an unfiltered network/VPN. Solana devnet RPC itself is reachable.
- 2026-07-16 — Phase 1 code spine complete ahead of schedule: consensus engine (de-vig + recency blend + outlier guard, tested vs DOCS §4 worked example), valuation math with FeedStaleError lockout, TxLineAdapter (REST polling, provisional schema in SCHEMA.md, backoff, fail-fast without creds), SQLite packet audit log (raw-hash-before-parse), FeedService, WS fanout (HELLO/CONSENSUS/EVENT/FEED_HEALTH), `cli:watch`. Venue shortlist researched → `venue-selection.md`: World excluded (migrated to Robinhood Chain Jul 8); lean Jupiter Predict, second Drift BET; measured liquidity gate pending. **G1 blocked on:** TxLINE credentials (T0.1/T1.1 live), venue liquidity gate + VenueAdapter (T1.4/T1.5), live-fire match test (T1.7), real position (T1.8).
