# Zygos — Technical Documentation

**Audience:** engineers building/reviewing Zygos, hackathon judges reading the repo.
**Companions:** PRD.md (requirements), PLAN.md (schedule), CLAUDE.md (repo rules).

---

## 1. System overview

Zygos turns the TxODDS TxLINE live odds feed into a real-time **fair-value oracle** for a user's on-chain prediction-market positions, and compresses the "cash out mid-match" workflow into one signed Solana transaction.

```
                 ┌───────────────────────────── server (Fastify, Node 20) ─────────────────────────────┐
                 │                                                                                      │
 TxLINE feed ───▶│ TxLineAdapter ──▶ Consensus Engine ──▶ Valuation Service ──▶ WS fanout ──▶           │──▶ apps/web (Next.js)
 (WS or REST     │  (schema, retry)   (de-vig, blend)      (positions × probs)    /ws/valuations        │     terminal UI,
  polling)       │        │                                        ▲                                    │     wallet adapter,
                 │        ▼                                        │                                    │     signing
 Solana RPC ────▶│  Packet Audit Log (SQLite)          VenueAdapter.getPositions                        │
 (Helius)        │                                     VenueAdapter.getQuote / buildHedgeTx             │
                 └──────────────────────────────────────────────────────────────────────────────────────┘
                                                    │
                                                    ▼
                                     Solana: venue program (positions, orders)
                                             + Memo program (lock commitments)
```

Design principles:

1. **All financial math is pure** (`packages/core`): no I/O, injected time, exhaustively tested.
2. **All external schemas are quarantined in adapters** (`packages/venue-adapters`): when TxLINE or the venue changes shape, exactly one directory changes.
3. **Provenance everywhere:** every displayed probability traces to TxLINE packet ids in the audit log; every executed lock writes an on-chain memo commitment.
4. **Fail loud, fail safe:** stale feed → visible STALE state + lock-in disabled; failed simulation → no signature prompt; failed send → no state change.

---

## 2. Repository & stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Monorepo | pnpm workspaces | zero-config, fast |
| Web | Next.js 14 (App Router), Tailwind, `@solana/wallet-adapter` | speed of build, wallet ecosystem support |
| Server | Fastify + `ws`, pino logging | low-latency WS fanout, minimal ceremony |
| Chain | `@solana/web3.js` v1.x + venue SDK/IDL (Anchor client) | standard |
| Persistence | SQLite via Drizzle ORM | audit log + rules store, zero-ops |
| Validation | Zod at every external boundary | runtime safety for third-party payloads |
| Tests | Vitest + fast-check (property tests) | see CLAUDE.md §6 |

Directory layout: see CLAUDE.md §3. Dependency direction is enforced by ESLint import rules: `core` imports nothing internal; `venue-adapters` may import `core`; `server` imports both; `web` imports only its own code and talks to `server` over HTTP/WS.

---

## 3. TxLINE integration (`packages/venue-adapters/txline/`)

> **Schema disclaimer:** exact endpoint paths, message shapes, and market taxonomies come from the TxLINE hackathon documentation issued with API credentials (via the TxLINE Telegram channel). This section defines Zygos's *internal* contract; `TxLineAdapter` is the single translation point, and `SCHEMA.md` in the adapter directory must be updated whenever real payloads are learned (CLAUDE.md §7). Nothing outside the adapter may assume TxLINE wire formats.

### 3.1 Internal contract

```ts
// packages/venue-adapters/types.ts
export interface OddsTick {
  packetId: string;          // TxLINE packet identifier (provenance)
  receivedAt: number;        // server monotonic ms
  sourceTs: number;          // TxLINE timestamp (ms epoch)
  fixtureId: string;         // TxLINE fixture id
  market: MarketKey;         // e.g. { kind: '1X2' } | { kind: 'TOTAL', line: 2.5 }
  bookmakerId: string;
  outcomes: Array<{ outcome: OutcomeKey; decimalOdds: number }>;
}

export interface MatchEvent {
  packetId: string;
  sourceTs: number;
  fixtureId: string;
  type: 'GOAL' | 'RED_CARD' | 'KICKOFF' | 'HT' | 'FT';
  team: 'HOME' | 'AWAY' | null;
  inferred: boolean;         // true if derived from odds discontinuity (§6)
}

export interface OddsFeedAdapter {
  connect(): Promise<void>;
  subscribe(fixtureIds: string[]): Promise<void>;
  onTick(cb: (t: OddsTick) => void): void;
  onEvent(cb: (e: MatchEvent) => void): void;   // no-ops if feed tier lacks events; §6 fills in
  health(): { connected: boolean; lastTickAgeMs: Record<string, number> };
  disconnect(): Promise<void>;
}
```

### 3.2 Transport & resilience

- Preferred transport: streaming (WebSocket) if the hackathon tier provides it; fallback: REST polling at 2s intervals per subscribed fixture (still within PRD latency targets). The adapter hides which one is active.
- Reconnect: exponential backoff 1s → 30s cap, resubscribe on reconnect, and emit a synthetic health transition so the valuation service can mark markets STALE during the gap.
- Every raw packet is hashed (sha256) and its `{packetId, sourceTs, fixtureId, hash}` row inserted into the `packets` audit table before parsing continues — provenance survives even parser bugs.

### 3.3 Staleness policy

`lastTickAgeMs > 30_000` for a market ⇒ `FeedStaleError` from the valuation function ⇒ UI STALE banner, valuations frozen with a timestamp, Lock-In disabled for that market (PRD FR-14). There is no silent fallback.

---

## 4. Consensus engine — de-vig math (`packages/core/consensus.ts`)

Bookmaker odds embed margin ("vig"): implied probabilities sum to >1. Zygos removes it per bookmaker, then blends across books.

### 4.1 Per-bookmaker de-vig (multiplicative method)

For a market with outcomes *i = 1..n* and decimal odds *oᵢ* from one bookmaker:

```
qᵢ = 1 / oᵢ                    (raw implied probability)
B  = Σ qᵢ                      (booksum / overround, > 1)
pᵢ = qᵢ / B                    (de-vigged fair probability; Σ pᵢ = 1)
```

Multiplicative normalization is chosen over more elaborate methods (Shin, power) deliberately: it is standard, explainable in one tooltip, and robust across the odds ranges seen in 1X2 markets. The method is isolated behind `devig(odds[]): number[]` so it can be swapped without touching callers.

**Worked example (unit-test fixture):** home/draw/away decimal odds `2.10 / 3.40 / 3.80`:

```
q = [0.47619, 0.29412, 0.26316]   B = 1.03347
p = [0.46077, 0.28459, 0.25464]   Σ p = 1.0
```

### 4.2 Cross-book consensus

For each outcome, consensus probability is the **recency-weighted mean** of per-book de-vigged probabilities:

```
wᵦ = exp(-ageᵦ / τ)        τ = 20s during live play
P(outcome) = Σᵦ wᵦ · pᵦ,outcome / Σᵦ wᵦ
```

Books with `ageᵦ > 60s` are dropped from the blend. If fewer than 2 books remain, the market is flagged `LOW_CONFIDENCE` in the UI (valuation shown, lock-in allowed, badge displayed). Outlier guard: a book deviating >10 probability points from the unweighted median is excluded from that tick's blend and logged.

The engine is a pure fold: `(state, OddsTick) → state`, with `state` holding per-book latest quotes per market. Snapshots are emitted to the valuation service on every change.

---

## 5. Hedge engine (`packages/core/hedge.ts`)

Positions are quantities of outcome shares that pay **1 unit** of the venue's quote token if the outcome occurs, else 0 (the standard prediction-market share model; the venue adapter converts if its native representation differs).

### 5.1 Full lock, binary market

User holds `S` shares of outcome A. Complement B has ask price `p_B` (per share, fee-inclusive via adapter quote).

Buy `H = S` shares of B. Final wealth from here, net of hedge cost `S·p_B`:

```
if A occurs:  S · 1 − S·p_B = S(1 − p_B)
if B occurs:  S · 1 − S·p_B = S(1 − p_B)      ⇒ guaranteed payout G = S(1 − p_B)
```

**Invariant (property-tested):** post-hedge payout is identical across outcomes to within 1e-9 relative tolerance for randomized `S, p_B, fees`.

### 5.2 Partial lock (fraction f)

Semantics: guarantee the floor on a fraction `f ∈ (0,1]` of the position; keep `(1−f)·S` exposed.

```
H = f·S            floor  G_f = f·S(1 − p_B)
if A: G_f + (1−f)·S        (upside retained)
if B: G_f                  (floor)
```

The preview modal renders this full payout matrix — floor and retained upside — never just one number.

### 5.3 Close vs synthetic hedge

If the venue supports selling the held outcome directly at bid `p_A^bid`, closing yields `f·S·p_A^bid` guaranteed. Zygos computes both routes and executes the better:

```
route = argmax( p_A^bid , 1 − p_B^ask )   applied to f·S
```

Both quotes come from `VenueAdapter.getQuote` with size-aware pricing (walking the book / AMM curve), so depth and slippage are priced in before preview.

### 5.4 Multi-outcome markets (1X2)

Holding `S` of outcome 1; complements 2 and 3 at asks `p₂, p₃`. Buy `H₂ = H₃ = S` (scaled by `f` for partial):

```
G = S(1 − p₂ − p₃)         identical across all three outcomes (same cancellation as §5.1)
```

Lock-in is only offered when `p₂ + p₃ < 1` after fees at executable size — otherwise the "hedge" would lock a worse outcome than holding, and the UI explains this instead of offering the button.

### 5.5 Fair-value comparison line (the product's soul)

Every preview states the implied exit probability vs TxLINE consensus:

```
implied_exit = route price (e.g. 1 − p₂ − p₃, or p_A^bid)
edge_pts = (implied_exit − P_consensus(A)) × 100
```

Rendered as: **"This lock fills you at 61.2% — 2.8 pts above TxLINE fair value (58.4%)."** Positive = better than fair. This transparency is the differentiator over bookmaker cash-out (PRD §6).

### 5.6 Execution pipeline (server + web)

```
quote → buildHedgeTx (venue adapter, slippage bound baked in)
      → simulateTransaction (reject on failure: no signature prompt)
      → preview modal (payout matrix, fees, edge_pts, TxLINE packet refs)
      → wallet signature (user)
      → send + confirm ('confirmed' commitment)
      → post-verify: re-read position accounts; assert matrix within tolerance
      → memo commitment: sha256(fixtureId|market|side|f|packetIds) via Memo program
      → activity log entry with explorer link
```

Any failure before `send` is a clean no-op. Failure after `send` (rare: confirm timeout) triggers a re-read loop until account state is unambiguous; the UI never shows "LOCKED" before post-verification passes.

---

## 6. Event inference fallback (`packages/core/eventInfer.ts`)

If the hackathon feed tier lacks an explicit event stream, match events are inferred from consensus-probability discontinuities — still 100% real data, no simulation:

```
Trigger: |ΔP(outcome)| ≥ 0.08 within a 60s window, sustained for ≥ 2 consecutive ticks
Classify: large jump for HOME win prob ⇒ GOAL(HOME) candidate (symmetrically AWAY);
          jump concentrated in draw/total markets refines classification.
Emit: MatchEvent { inferred: true, ... }
```

Inferred events are visually tagged ("⚡ inferred from odds move") in the ticker and rule-firing log. Thresholds are constants in one file with the rationale documented next to them. The heuristic's honesty is part of the submission narrative — judges from TxODDS will recognize an odds-discontinuity detector as domain-literate.

---

## 7. Rule engine v1 (`apps/server/src/rules/`)

- Rule shape: `{ id, wallet, positionRef, template: 'GOAL_LOCK' | 'RED_CARD_REDUCE', params: { team, fraction }, createdAt, intentHash }`.
- Storage: server SQLite keyed by wallet (the hosted demo also keeps a client mirror in memory; browser storage APIs are not used).
- On creation, `intentHash = sha256(canonicalJson(rule))` is written as an on-chain memo — a pre-commitment proving the rule predated the event it later fires on.
- Firing: `MatchEvent` stream → matcher → server pre-builds and simulates the transaction → pushes a `RULE_FIRED` frame over WS → web shows a full-screen one-tap signing prompt (PRD FR-42; median ≤3s from event). v1 is deliberately human-in-the-loop; delegated session-key execution is documented as v2 in the PRD non-goals.

---

## 8. Server API surface

### HTTP (Fastify)

| Method & path | Purpose |
|---|---|
| `GET /healthz` | feed connection, per-fixture tick age, RPC height, DB ok |
| `GET /fixtures` | subscribed World Cup fixtures with live consensus snapshot |
| `GET /positions/:wallet` | venue positions + valuations (also streamed over WS) |
| `POST /hedge/preview` | `{wallet, positionRef, fraction}` → payout matrix, route, fees, edge_pts, unsigned tx (base64) |
| `POST /hedge/confirm` | `{signature}` → post-verification result + memo tx id |
| `POST /rules` / `GET /rules/:wallet` / `DELETE /rules/:id` | rule CRUD (creation returns memo commitment tx id) |

### WebSocket `/ws`

Frames (Zod-validated, discriminated union on `type`):
`HELLO`, `SUBSCRIBE {wallet, fixtureIds}`, `VALUATION {positionRef, fair, mark, lagMs, packetIds}`, `CONSENSUS {fixtureId, market, probs, bookCount, confidence}`, `EVENT {MatchEvent}`, `RULE_FIRED {ruleId, unsignedTx}`, `FEED_HEALTH {fixtureId, state: LIVE|DEGRADED|STALE}`.

All mutating HTTP endpoints require a signed-message auth challenge (wallet signs a nonce) so rules and previews are bound to wallet ownership — no accounts, no passwords.

---

## 9. Security & trust model

| Threat | Mitigation |
|---|---|
| Server compromise steals funds | Impossible by construction: server never holds keys; worst case is bad previews — which post-verification (§5.6) and client-side matrix recomputation both catch |
| Stale/manipulated pricing fills user badly | Multi-book consensus + outlier guard (§4.2), staleness lockout (§3.3), edge_pts disclosure (§5.5), slippage bounds in every tx |
| Malicious unsigned tx substituted in `RULE_FIRED` | Client re-simulates and re-derives the payout matrix independently before showing the signing prompt; mismatch ⇒ red warning, no sign |
| Credential leakage | TxLINE keys server-only (CLAUDE.md §9); `.env*` gitignored; logs scrub secrets and truncate wallets |
| Replay/forged rule firing | Rules bound to wallet via signed-message auth; firings logged with TxLINE packet provenance; intent hash pre-committed on-chain |

Compliance posture (restating PRD §5): Zygos custodies nothing, makes no odds, takes no counterparty risk; it is decision-support plus self-directed execution tooling. Venue availability/geo constraints are the venue's domain and are disclaimed at wallet connect.

---

## 10. Deployment & operations

- **Web:** Vercel (Next.js), env: `NEXT_PUBLIC_SERVER_WS_URL`, `NEXT_PUBLIC_CLUSTER`.
- **Server:** Fly.io single region (fra — close to European match-data origins), Dockerfile in `apps/server`, SQLite on a Fly volume. One machine is sufficient for hackathon load; WS fanout is trivial at this scale.
- **RPC:** Helius (free tier); `CLUSTER` must match the venue adapter's deployment (mainnet-beta or devnet per PLAN.md Day-1 gate).
- **Monitoring:** `/healthz` polled by UptimeRobot; pino logs to Fly's log sink; a `cli:watch` headless mode doubles as an ops probe during matches.
- **Runbook (match day):** start `cli:watch` for the fixture 15 min before kickoff → confirm tick flow and consensus movement → confirm `/healthz` LIVE → open terminal UI with team wallet → record.

---

## 11. Glossary

| Term | Meaning |
|---|---|
| **Zygos (ζυγός)** | "scale/balance" — the hedge balances the payout matrix |
| **De-vig** | removing bookmaker margin from implied probabilities (§4.1) |
| **Consensus probability** | recency-weighted, de-vigged blend across bookmakers (§4.2) |
| **Fair value** | position size × consensus probability of the held outcome |
| **Mark value** | position valued at current on-chain bid |
| **Lag delta** | fair − mark; visible measure of on-chain price staleness in-play |
| **Lock-in / cash-out** | trade(s) making final payout outcome-independent (§5) |
| **edge_pts** | implied exit probability − consensus probability, in points (§5.5) |
| **Intent hash** | on-chain pre-commitment of an automation rule (§7) |
| **Steam move** | abrupt cross-book odds shift from concentrated informed money |
