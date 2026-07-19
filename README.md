# Zygos — ζυγός, "the scale"

**Real-time cash-out and hedging terminal for Solana prediction markets, priced
by TxODDS TxLINE consensus odds.**

In-play "cash out" is the single most-used feature of traditional sportsbooks.
On-chain prediction markets don't have it: mid-match, the on-chain price lags
real events by tens of seconds, and exiting requires manual hedge math under
time pressure. Zygos values every position against TxLINE's de-vigged
multi-bookmaker consensus — the fair price — and compresses the exit to one
signed transaction, telling you plainly whether the lock fills **above or
below fair value and by how many probability points**.

Built for the TxODDS World Cup Hackathon (Trading Tools & Agents track).
Non-custodial, no mock data anywhere in the runtime, every price traceable to
its TxLINE source packets.

> **Status:** all software complete and behavior-proven (105 tests incl. an
> end-to-end pipeline integration and fast-check property tests). Live-fire
> and deployment steps: `docs/runbook-matchday.md`. Phase tracking:
> `docs/phases.md`.

## Quickstart

```bash
pnpm install
cp apps/server/.env.example apps/server/.env    # fill in (see below)
pnpm -F server txline:activate                  # one-time: on-chain free-tier subscription → API token
pnpm dev                                        # server :8080 + web :3000
```

Checks: `pnpm test` · `pnpm typecheck` · `pnpm lint` · `pnpm audit:nomock`
(runtime code must contain no mock/faker/fixture data — CI enforces all four).

## Architecture

```
                ┌───────────────────────── apps/server (Fastify) ─────────────────────────┐
                │                                                                          │
 TxLINE feed ──▶│ TxLineAdapter ──▶ Consensus ──▶ Valuation ──▶ WS /ws ────────────────────│──▶ apps/web (Next.js)
 (SSE streams,  │  (real schema,     (de-vig,      (positions ×   CONSENSUS/VALUATION/      │    terminal UI,
  guest JWT +   │   backoff,         recency       consensus)     EVENT/FEED_HEALTH/        │    wallet adapter,
  X-Api-Token)  │   audit-first)     blend,                       RULE_FIRED                │    signing only
                │        │           outliers)         ▲                                    │
 Solana RPC ───▶│        ▼               │             │          HTTP: /positions/:wallet  │
                │  Packet audit log      ▼        VenueAdapter    /hedge/preview|confirm    │
                │  (Neon Postgres,  Event inference (Jupiter       /rules CRUD              │
                │   before parse)   (odds jumps §6)  Predict)      /locks/:wallet (ledger)  │
                └──────────────────────────────────────────────────────────────────────────┘
                                             │
                                             ▼
                            Solana: venue program (positions, orders)
                                    + Memo program (lock + rule-intent commitments)
```

- **`packages/core`** — pure financial math, zero I/O, injected time: de-vig,
  recency-weighted consensus with outlier guard, valuation with staleness
  lockout, hedge planning (close-vs-synthetic route, exact integer payout
  matrices), odds-discontinuity event inference. Property-tested.
- **`packages/venue-adapters`** — every external schema quarantined:
  `txline/` (feed) and `jupiter/` (venue). When a wire format changes, exactly
  one directory changes.
- **`apps/server`** — ingest, audit log, WS fanout, hedge orchestration
  (preview → **mandatory simulate** → unsigned tx → post-verify → memo),
  rule engine (event templates GOAL_LOCK / RED_CARD_REDUCE plus the
  price-triggered PRICE_LOCK: one-shot take-profit/stop fired when TxLINE
  consensus crosses an armed threshold), lock ledger (every verified lock
  persisted with the edge it captured vs fair value, plan fields taken from
  the server-cached preview the user actually signed), signed-message auth,
  CORS allowlist for the deployed web origin (`WEB_ORIGIN`).
- **`apps/web`** — trading terminal (light professional fintech design; Geist +
  JetBrains Mono). Four views — Terminal (match feed, live consensus timeline,
  positions, quick rules), Portfolio (fair-value totals, TxLINE-lead, lock
  ledger with per-lock edge captured and CSV export,
  allocation), Automation (rule + delegation management), Analytics (market
  provenance table, system status from `/healthz`). Talks HTTP/WS only; TxLINE
  credentials never reach the browser. First load 234 kB (budget 300 kB).

## TxLINE integration (the product's reason to exist)

TxLINE is the **primary input**: fair valuation, hedge pricing sanity, and
rule triggers all derive from it; the product is inoperable without it.

- Free World Cup tier, activated fully on-chain: `subscribe()` on the TxLINE
  oracle program → guest JWT → wallet-signed activation → `X-Api-Token`
  (`pnpm -F server txline:activate` automates all of it, devnet or mainnet).
- Live odds and score-action **SSE streams** + snapshot endpoints; prices are
  decimal odds ×1000; every record carries a `MessageId` used as the
  provenance packet id.
- Every raw payload is sha256-hashed into the audit log **before parsing**, so
  any displayed fair value traces back to source packets — matching TxLINE's
  own on-chain anchoring story. UI numbers carry a TxLINE badge with packet
  ids on hover.
- Full wire-schema documentation: `packages/venue-adapters/src/txline/SCHEMA.md`.
- If the feed tier lacks explicit events, goals are inferred from sustained
  ≥8-point consensus jumps (still 100% real data) and visibly tagged
  "⚡ inferred" (`packages/core/src/eventInfer.ts`).

## Venue

Selection research and the measured liquidity gate: `docs/venue-selection.md`.
Current lean: **Jupiter Predict** (adapter implemented against the documented
API: positions, size-aware quotes, hedge = opposite-side buy, DELETE-to-close).
Drift BET is the runner-up; the `VenueAdapter` interface makes switching a
one-directory change.

## Security posture

- **Non-custodial by construction.** No private keys server-side, ever. All
  transactions are built unsigned and signed exclusively in the user's wallet.
  Rules never auto-execute: a firing produces a prepared, simulated
  transaction and a one-tap signing prompt.
- **Simulate before sign.** No `simulateTransaction` pass ⇒ no signature
  prompt, including for rule firings. The client independently re-checks the
  payout matrix before enabling the sign button.
- **Never a stale price as live.** Feed >30s old ⇒ STALE banner, valuations
  frozen visibly, lock-in disabled — enforced in core (`FeedStaleError`), at
  the tx layer (preview refuses), and in the UI.
- **Auditability.** Locks write an on-chain memo commitment
  (`sha256(fixture|market|side|fraction|packetIds)`) whose signature is
  persisted on the lock-ledger row; rules pre-commit their intent hash
  on-chain at creation; every firing logs its triggering packet.
- **Delegation stays revocable and encrypted.** A delegated rule can be
  revoked at any time (stored pre-signed tx erased + a user-signed nonce
  advance voids leaked copies on-chain); stored pre-signed txs are
  AES-256-GCM encrypted at rest (`DELEGATION_ENC_KEY`), and the client
  independently verifies the tx shape before pre-signing.
- Mutating endpoints require a wallet-signed challenge (`zygos:{action}:{nonce}`,
  replay-guarded). TxLINE credentials live only in server env vars.

Zygos is position risk management for prediction markets: it takes no
counterparty risk, holds no funds, and offers no odds. Venue availability by
jurisdiction is the venue's responsibility and is disclaimed at wallet connect.

## Known limitations (stated, not hidden)

- The Jupiter market-binding registry (TxLINE fixture ↔ venue market) starts
  empty; bindings are entered at the liquidity gate through the persistent
  registry (Analytics → Market Bindings, or `PUT /bindings/:marketId`,
  wallet-signed, `ADMIN_WALLETS`-restrictable) and apply live — until then,
  unmapped positions surface as `UNMAPPED_OUTCOME` rather than being silently
  valued. Automated fixture↔market matching remains manual-first by design:
  a wrong auto-binding would mis-value real money.
- Post-execution verification v1 confirms the position shrank/closed; strict
  payout-matrix re-verification against chain state lands with live-venue
  testing.
- Per-bookmaker rows in the fair-value explainer join once live payloads
  confirm the per-book feed shape; the de-vig walkthrough and provenance are
  fully real today.

## Documentation map

| File | Contents |
|---|---|
| `docs/PRD.md` / `docs/DOCS.md` / `docs/PLAN.md` | requirements / technical design / schedule with gates |
| `docs/phases.md` | phase status against the G0–G3 gates |
| `docs/venue-selection.md` | venue shortlist, criteria, evidence |
| `docs/runbook-matchday.md` | exact live-fire + deploy steps |
| `docs/submission.md` | Superteam Earn submission text |
| `docs/demo-video-script.md` | shot-by-shot demo video plan |
| `docs/CLAUDE.md` | repo rules for AI-assisted development |
