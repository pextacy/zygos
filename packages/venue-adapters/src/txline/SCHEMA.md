# TxLINE wire schema notes

**Status: CONFIRMED from official docs + reference repo (July 16, 2026).**
Sources: `txline-docs.txodds.com` (Mintlify docs; ISP-blocked networks can read
them via the mirrored source in `github.com/txodds/tx-on-chain/documentation`)
and the runnable examples in `github.com/txodds/tx-on-chain` (Apache-2.0).

This file is the single record of everything known about real TxLINE payloads.
Update it in the same commit as any change to TxLINE parsing (CLAUDE.md §7).

## Hosts & networks

| Network | API origin | Program ID | Free service levels |
|---|---|---|---|
| Mainnet | `https://txline.txodds.com` | `9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA` | `1` (60s delay), `12` (real-time) — World Cup & Int. Friendlies |
| Devnet | `https://txline-dev.txodds.com` | `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J` | `1` (`samplingIntervalSec = 0` per current pricing matrix) |

TxL token mints: mainnet `Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL`,
devnet `4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG` (Token-2022).

## Auth flow (free tier, no TxL payment)

1. Wallet with SOL on the chosen network submits the on-chain
   `subscribe(serviceLevelId, durationWeeks)` instruction (Anchor program above).
2. `POST {origin}/auth/guest/start` → `{ token }` = short-lived guest JWT.
3. Wallet signs `${txSig}:${leagues.join(',')}:${jwt}` (standard bundle: `${txSig}::${jwt}`),
   base64 detached signature.
4. `POST {origin}/api/token/activate` `{txSig, walletSignature, leagues}` with
   `Authorization: Bearer {jwt}` → long-lived **API token**.
5. Data requests carry BOTH headers: `Authorization: Bearer {jwt}` (renewable
   via step 2 at any time) and `X-Api-Token: {apiToken}`.
6. On `401`/`403`: renew the guest JWT from the same host, keep the API token.

Implemented in `apps/server/scripts/txline-activate.ts` (adapter consumes
`TXLINE_ORIGIN` + `TXLINE_API_TOKEN`).

## Data endpoints (prefix `{origin}/api`)

| Endpoint | Purpose |
|---|---|
| `GET /fixtures/snapshot?competitionId=&startEpochDay=` | fixture list (30-day window from epoch day) |
| `GET /odds/snapshot/{fixtureId}[?asOf=ms]` | latest odds per fixture |
| `GET /odds/updates/{fixtureId}` | current 5-minute in-memory cache of updates |
| `GET /odds/stream` | **SSE** — all permitted odds updates, one record per data message |
| `GET /scores/stream` | **SSE** — score/action events |
| `GET /scores/historical/{fixtureId}` | replay for completed fixtures |
| `GET /odds/proof/...`, `/scores/proof/...` | Merkle proofs for on-chain validation |

SSE framing: data messages have `id: "timestamp:index"` and a JSON record in
`data`; heartbeats have `event: heartbeat` (e.g. `{"Ts": ...}`).

## Odds record (JSON, SSE + snapshot + updates)

```json
{
  "FixtureId": 17588320,        // int64
  "MessageId": "…",             // provenance id (our packetId)
  "Ts": 1784216000000,          // ms epoch (epochDay = Ts / 86_400_000)
  "Bookmaker": "…",
  "BookmakerId": 42,
  "SuperOddsType": "…",         // market vocabulary — branch from actual payloads
  "InRunning": true,
  "GameState": "H1",            // optional
  "MarketParameters": "2.5",    // optional (e.g. totals line)
  "MarketPeriod": "FT",         // optional
  "PriceNames": ["1","X","2"],
  "Prices": [2100, 3400, 3800], // **decimal odds ×1000** (README: three-decimal precision)
  "Pct": ["47.619", …]          // 3-dp strings or "NA" (quarter handicap lines)
}
```

Docs explicitly warn: do not assume a market exists for a fixture — inspect
`SuperOddsType` in actual responses. Our parser maps known full-time
result/totals vocabulary and reports (never guesses) anything else.

## Fixture record

`{Ts, StartTime, Competition, CompetitionId, FixtureGroupId, Participant1Id,
Participant1, Participant2Id, Participant2, FixtureId, Participant1IsHome}`

## Scores (soccer)

- Action records (lowercase field names): `{fixtureId, ts, action, gameState,
  participant (1|2), confirmed, participant1IsHome, id, seq, …}`.
- Game phases: `NS=1, H1=2, HT=3, H2=4, F=5, …, FET=10, FPE=13` — we derive
  KICKOFF (NS→H1), HT, FT transitions.
- Stat keys (for on-chain validation & settlement): 1/2 = P1/P2 goals,
  3/4 yellow cards, 5/6 red cards, 7/8 corners; period prefix ×1000.
- `confirmed: false` actions (e.g. VAR pending) never fire rules.

## Open items (verify at first live session)

- Exact `SuperOddsType` strings for World Cup fixtures (mapper vocabulary in
  `schema.ts` `parseMarket`; unknowns are logged by the adapter).
- Exact `PriceNames` spellings (current map: 1/X/2, Home/Draw/Away, Over/Under).
- Whether the odds SSE stream supports `Last-Event-ID` resume.

## Network access warning

Turkish ISP "Güvenli İnternet" family profiles block `*.txodds.com` at the TLS
level (observed July 16: `WRONG_VERSION_NUMBER` / block page). Activation and
live data need an unfiltered network or ISP profile change. Solana devnet RPC
(`api.devnet.solana.com`) is NOT blocked.
