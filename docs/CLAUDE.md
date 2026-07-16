# CLAUDE.md — Zygos Repository Instructions

Instructions for Claude Code (and any AI coding assistant) working in this repository. Read PRD.md for product intent and PLAN.md for the build sequence before making changes. DOCS.md is the technical source of truth; if code and DOCS.md disagree, flag it — do not silently pick one.

---

## 1. What this project is

Zygos is a **non-custodial, real-time cash-out and hedging terminal** for Solana prediction markets. Fair values come from the TxODDS TxLINE live odds feed (de-vigged multi-bookmaker consensus). Users connect a wallet, see live fair value of their open World Cup positions, and lock in profit with one signed transaction. Built for the TxODDS World Cup Hackathon, Trading Tools & Agents track. Deadline: **July 19, 2026** — bias every decision toward shipping.

## 2. Hard rules (violating these fails the hackathon or harms users)

1. **NO MOCK DATA in runtime code.** No fixtures, faker, hardcoded odds, or simulated positions anywhere under `apps/` or `packages/` outside `*.test.ts`. Recorded TxLINE payloads are permitted only in test files. If you cannot reach a real service during development, stop and say so rather than stubbing it.
2. **Non-custodial, always.** Never write code that handles, stores, or requests private keys server-side. All transactions are built server- or client-side but signed exclusively by the user's wallet adapter. No auto-signing.
3. **Never show a stale price as live.** Every valuation must carry feed-age metadata; if the feed is >30s stale for a market, the UI must enter the STALE state and disable lock-in for it. Do not "helpfully" fall back to the last known price without the STALE banner.
4. **Simulate before sign.** Every transaction goes through `simulateTransaction` and a human-readable preview before a signature is requested. Failed simulation = no signature prompt.
5. **TxLINE credentials live only in server env vars** (`TXLINE_API_KEY` etc.). Never import them into `apps/web`, never log them, never commit `.env*`.
6. **No betting-operator framing** in user-facing copy. Zygos is "position risk management for prediction markets," not a betting product. Don't add odds-making, bankroll-boosting, or gambling-encouragement language or features.

## 3. Repository layout

```
zygos/
├── apps/
│   ├── web/          # Next.js 14 (App Router) + Tailwind + wallet-adapter. UI only.
│   └── server/       # Node 20 + Fastify. TxLINE ingest, consensus engine host,
│                     # valuation WebSocket, tx building endpoints, SQLite audit log.
├── packages/
│   ├── core/         # Pure TypeScript, zero I/O: de-vig math, consensus,
│   │                 # hedge sizing, payout matrices, types. Most tests live here.
│   └── venue-adapters/
│       ├── types.ts  # VenueAdapter + OddsFeedAdapter interfaces
│       ├── txline/   # TxLINE feed adapter (ALL TxLINE schema knowledge is here)
│       └── <venue>/  # Chosen Solana venue adapter (see docs/venue-selection.md)
├── docs/             # venue-selection.md, session logs, decision records
├── PRD.md  PLAN.md  DOCS.md  CLAUDE.md  README.md
```

Dependency direction: `web → server (HTTP/WS only)`, `server → core + venue-adapters`, `core → nothing`. Never import server code into web; never add I/O to `core`.

## 4. Commands

```bash
pnpm install                 # workspace install
pnpm dev                     # web:3000 + server:8080 concurrently
pnpm -F server dev           # server only (needs .env with TXLINE_*, RPC_URL)
pnpm -F web dev              # web only
pnpm test                    # vitest across workspace — must pass before any commit
pnpm typecheck && pnpm lint  # must pass before any commit
pnpm -F server cli:watch <fixtureId>   # headless: print live consensus for a fixture
pnpm audit:nomock            # greps runtime code for mock/faker/fixture — must be empty
```

## 5. Code conventions

- TypeScript strict mode everywhere; no `any` (use `unknown` + narrowing). Zod-validate every external payload (TxLINE ticks, RPC account data, user input) at the boundary; internal code trusts types.
- All odds handled as **decimal odds** internally; convert at the adapter boundary. All probabilities are `number` in [0,1]. All money in integer base units (venue token lamports/µUSDC) — never floats for balances or sizes. Use `bigint`.
- Financial math in `packages/core` must be pure functions with explicit inputs — no reading globals, clocks, or env. Time is always an injected parameter.
- Errors: use typed error classes (`FeedStaleError`, `InsufficientDepthError`, `SimulationFailedError`); never throw strings; server maps them to structured HTTP/WS errors.
- Logging: pino, structured. Every log line about a valuation or trade includes `fixtureId`, `market`, and TxLINE `packetId` refs. Never log secrets or full wallet addresses (truncate to 4+4).
- React: server components by default; client components only for wallet, live tables, and forms. No `localStorage`/`sessionStorage` — in-memory state + optional export (see PRD FR-41).
- Comments explain *why*, not *what*. Keep them sparse and current.

## 6. Testing requirements

- `packages/core` target ≥90% line coverage. Non-negotiable tests:
  - De-vig: multiplicative normalization vs hand-computed cases (DOCS.md §4 worked example).
  - Hedge sizing: **property test** — for randomized size/prices/fees/lock-fraction, post-hedge payout across outcomes is equal within 1e-9 relative tolerance (DOCS.md §5 invariant).
  - Staleness: valuation function throws `FeedStaleError` past the threshold.
- Adapters: integration tests may hit devnet and recorded TxLINE payloads (the one sanctioned use of recordings).
- Do not weaken or delete a failing test to make CI green. Fix the code or flag the spec conflict.

## 7. Things Claude should proactively do

- Run `pnpm test && pnpm typecheck` after every substantive change; run `pnpm audit:nomock` before declaring any task complete.
- When touching TxLINE parsing, update the schema notes in `packages/venue-adapters/txline/SCHEMA.md` in the same commit.
- When adding any user-visible number, wire its TxLINE packet provenance (FR-13/54) — provenance is a feature, not overhead.
- Prefer deleting scope over adding scope; consult PLAN.md §5 cut list when time-pressured and say which cut you're proposing.

## 8. Things Claude must never do

- Introduce mock/simulated runtime data (rule 2.1) or auto-signing (rule 2.2).
- Add new heavyweight dependencies without justification in the PR description (bundle budget: web ≤ 300KB gz first load).
- Change hedge or de-vig formulas without updating DOCS.md §4–5 and their tests in the same commit.
- Rewrite git history on `main`, force-push, or commit `.env*`, keypairs, or `docs/session-logs/*` containing credentials.
- Add gambling-solicitation copy, dark patterns (fake urgency, hidden fees), or telemetry that tracks wallet identity beyond anonymous usage counts.

## 9. Environment variables (server only)

```
TXLINE_API_KEY=        # from TxLINE hackathon Telegram channel
TXLINE_BASE_URL=       # per TxLINE docs
RPC_URL=               # Helius/Triton mainnet or devnet endpoint
CLUSTER=               # 'mainnet-beta' | 'devnet' — must match venue adapter deployment
DATABASE_URL=          # SQLite file path, default ./data/zygos.db
COMMITMENT_MEMO=true   # write on-chain lock commitments (FR-33)
```

`apps/web` receives only `NEXT_PUBLIC_SERVER_WS_URL` and `NEXT_PUBLIC_CLUSTER`.

## 10. Current status & priorities

Track live status in PLAN.md gates (G0–G3). When resuming a session: read the latest entry in `docs/session-logs/`, run the test suite, then continue from the first unchecked task of the current day in PLAN.md. If a gate's fallback condition has triggered, follow the fallback — do not attempt the failed path again without new information.
