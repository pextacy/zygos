# Zygos

Non-custodial, real-time cash-out and hedging terminal for Solana prediction markets.
Fair values come from the TxODDS **TxLINE** live odds feed (de-vigged multi-bookmaker
consensus) — not from laggy on-chain marks. Built for the TxODDS World Cup Hackathon,
Trading Tools & Agents track.

> **Status:** Phase 0 scaffold. See `docs/phases.md` for phase gates and
> `docs/PLAN.md` for the day-by-day build plan.

## Documentation

| File | Contents |
|------|----------|
| `docs/PRD.md` | Product requirements — what and why |
| `docs/DOCS.md` | Technical design — architecture, math, APIs |
| `docs/PLAN.md` | Build schedule with hard gates |
| `docs/phases.md` | Phase-level status tracking |
| `docs/CLAUDE.md` | Repository rules for AI-assisted development |

## Layout

```
apps/web/               Next.js 14 terminal UI (wallet, signing) — UI only
apps/server/            Fastify: TxLINE ingest, consensus, valuation WS, tx building
packages/core/          Pure TS financial math — de-vig, hedge sizing, types. No I/O.
packages/venue-adapters/ OddsFeedAdapter + VenueAdapter contracts; TxLINE + venue impls
```

Dependency direction: `web → server (HTTP/WS only)`, `server → core + venue-adapters`,
`core → nothing` — enforced by ESLint.

## Commands

```bash
pnpm install                 # workspace install
pnpm dev                     # web:3000 + server:8080
pnpm test                    # vitest across workspace
pnpm typecheck && pnpm lint  # must pass before any commit
pnpm audit:nomock            # no mock data in runtime code — must be empty
```

Server env: copy `apps/server/.env.example` to `apps/server/.env` and fill in
TxLINE credentials (hackathon Telegram channel) and an RPC endpoint. Credentials
are server-only and never reach the browser.

## Hard rules

No mock data in runtime code. Non-custodial always — no server-side keys, no
auto-signing. Never show a stale price as live. Simulate before sign.
Full list: `docs/CLAUDE.md` §2.
