# Match-day runbook (Jul 17–18)

Everything below is the exact unblock path from the current state (all code
shipped; see phases.md). Steps 1–3 are one-time; 4–7 repeat per match.

## 0. Prerequisites (human, ~15 min)

1. **Network:** `*.txodds.com` is TLS-blocked on the Güvenli İnternet ISP
   profile. Change the profile (Türk Telekom online işlemler) or connect
   through a VPN. Test: `curl -s https://txline-dev.txodds.com/auth/guest/start -X POST` should return JSON, not an SSL error.
2. **Devnet SOL:** fund `Fm4pFGo4jaZT2pYmsKGAE5BdD12YLzdd3VbKqdUxpq1M` at
   https://faucet.solana.com (captcha). ~0.1 SOL is plenty.
   (Or wait: the CLI faucet rate limit resets daily; the activate script retries it.)
3. **Venue key:** create a Jupiter Predict API key (developers.jup.ag) → `JUPITER_API_KEY`.

## 1. Activate TxLINE (one command)

```bash
pnpm -F server txline:activate            # devnet; prints TXLINE_API_TOKEN
# → paste TXLINE_ORIGIN + TXLINE_API_TOKEN into apps/server/.env
```

Mainnet real-time instead: `pnpm -F server txline:activate --network mainnet-beta --service-level 12`
(needs mainnet SOL for fees; free tier, no TxL).

## 2. First live data check

```bash
pnpm -F server cli:watch list             # find World Cup fixture ids
pnpm -F server cli:watch <fixtureId>      # consensus lines should move
```

On first real payloads: verify `SuperOddsType` / `PriceNames` vocabulary
against `packages/venue-adapters/src/txline/SCHEMA.md` open items; adjust
`schema.ts` mappings in the same commit if new vocabulary appears (watch for
"unmapped market" warnings — expected for props/corners, wrong for 1X2).

## 3. Open the Day-1 position (T1.8)

Small real position on Jupiter Predict with the team wallet (the wallet you
will connect in the UI), on a covered World Cup market.

## 4. Run the terminal

```bash
pnpm dev            # server :8080 + web :3000
```

Connect wallet → positions load → fair values tick. Confirm `/healthz` shows
feed LIVE and the UI badges agree.

## 5. Live-fire (G1) + lock (G2)

- Watch consensus react to match events in the match board (G1 evidence —
  screen-record it).
- Execute one full Lock In from the UI; keep the explorer link (G2 evidence).
- Arm a GOAL_LOCK rule before a likely-scoring phase; when it fires, the
  full-screen prompt appears — one tap, sign, capture the whole sequence.

## 6. Demo capture checklist (T2.9 — record raw, trim later)

- [ ] tick-driven valuation movement
- [ ] goal → fair value jumps while venue price lags (lag Δ visible)
- [ ] one-click lock: slider → matrix → edge line → sign → explorer confirmation
- [ ] rule firing → one-tap lock
- [ ] `/healthz` + STALE lockout demo (kill network briefly) — optional

## 7. Deploy (T2.10)

```bash
npm i -g vercel @flyio/flyctl   # or brew install flyctl
fly auth login && cd apps/server && fly launch --no-deploy --copy-config
fly volumes create zygos_data --region fra --size 1
fly secrets set TXLINE_ORIGIN=... TXLINE_API_TOKEN=... JUPITER_API_KEY=... RPC_URL=... CLUSTER=devnet
fly deploy
cd ../web && vercel --prod    # set NEXT_PUBLIC_SERVER_WS_URL=wss://zygos-server.fly.dev/ws, NEXT_PUBLIC_CLUSTER
```

Smoke-test from a clean browser + fresh wallet (T2.10 definition of done).
