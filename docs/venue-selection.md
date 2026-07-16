# Venue selection (PLAN.md T0.4 shortlist + T1.4 liquidity gate)

**Status:** shortlist complete (web research, July 16, 2026). The measured
liquidity gate (T1.4, timeboxed 60 min) is **pending**: it needs live order-book
/pool reads over RPC during a match window. Do not pick the final venue until
that check runs.

## Shortlist

### 1. Jupiter Predict (jup.ag/prediction) — primary candidate

- **World Cup markets:** live now — match markets plus knockout-specific
  markets ("Team to Advance", "Both Teams to Score") built for the 2026 World Cup.
- **Order model:** USDC binary contracts on Solana.
- **Integration surface:** public Prediction API covering market data, order
  creation, position tracking, and settlement flows — exactly the
  `getPositions/getQuote/buildHedgeTx` surface our `VenueAdapter` needs. A
  developer guide exists ("How to build a prediction market app on Solana").
- **Caveat to verify:** liquidity is described as aggregated from Polymarket
  and Kalshi; confirm that positions are held in a Solana program readable per
  wallet over RPC (FR-20), and where settlement actually occurs.
- **Closeability:** binary contracts with an order API imply sell/close is
  possible — verify fee and spread behavior in-play.

### 2. Drift BET — strong second

- **Order model:** hybrid DLOB (decentralized central limit order book) + dynamic
  AMM + JIT liquidity on Drift's existing derivatives infrastructure; deep
  protocol-level liquidity pool (~$500M claimed across Drift).
- **Integration surface:** Drift's mature TypeScript SDK; positions are
  program accounts readable over RPC. Best-in-class program interface of the
  candidates.
- **Caveat to verify:** whether BET currently lists 2026 World Cup match
  markets at all, and their in-play depth. If it does, its interface quality
  may beat Jupiter's.
- **Closeability:** yes (order book — positions can be sold).

### 3. Pool-style venues (Hunch, CallShot, Worm) — likely ineligible

Live match pools / exact-score / bracket predictions. Parimutuel-style pools
generally have **no closeable positions** (criterion 3 fails) — a hedge cannot
lock a payout. Keep only as a last-resort demo substrate if both CLOB venues
fail the depth gate; would force the synthetic-hedge-only path and weaken the
product story.

### Excluded: World (world.xyz)

Launched on Solana inside Phantom July 1, 2026 with World Cup markets, but
**announced migration to Robinhood Chain on July 8, 2026**. Not a Solana venue
anymore; migration mechanics for existing markets still undisclosed. Out.

## Liquidity gate plan (execute on Day 1, timebox 60 min)

For Jupiter Predict and Drift BET, on 2–3 live World Cup 1X2/match markets:

1. Read the live book/pool at match time via RPC (or venue API where the book
   is off-chain-matched): capture two-sided depth and spread.
2. **Pass criteria (PLAN.md T1.4):** (a) SDK/IDL quality; (b) two-sided depth
   ≥ $200 at <3% spread on the match-winner market; (c) direct closeability.
3. Record evidence (screenshots/JSON dumps + timestamps) in this file and pick ONE.
4. **Fallback:** if neither passes on mainnet → best program interface on
   devnet, stated transparently in the submission (identical interfaces;
   liquidity is the only difference).

## Decision

_Pending the liquidity gate. Current lean: Jupiter Predict if positions prove
RPC-readable on Solana; otherwise Drift BET if it lists World Cup markets._

## Sources

- [Solana Hub — 2026 World Cup onchain landscape](https://x.com/SolanaHub_/status/2073814162539491790)
- [Jupiter — FIFA World Cup prediction markets](https://jup.ag/prediction/sports/world-cup)
- [Jupiter Developers — How to build a prediction market app on Solana](https://developers.jup.ag/docs/guides/how-to-build-a-prediction-market-app-on-solana)
- [PolyMart — Jupiter Predict overview (USDC binary contracts)](https://polymart.app/jupiter)
- [SolanaFloor — Jupiter Predict volume / Forecast beta](https://solanafloor.com/news/jupiter-unveils-forecast-solana-s-first-native-prediction-market)
- [The Block — Drift launches prediction market](https://www.theblock.co/post/311888/solana-based-drift-protocol-launches-prediction-market)
- [Bitget — Drift BET DLOB/AMM architecture](https://web3.bitget.com/crypto-news/drift-bets-on-solana-prediction-markets)
- [CoinDesk — World unveiled as fully onchain prediction market (Jul 1)](https://www.coindesk.com/web3/2026/07/01/mysterious-solana-project-world-unveiled-as-fully-onchain-prediction-market)
- [Grafa — World leaves Solana for Robinhood Chain (Jul 8)](https://grafa.com/en/news/crypto/world-prediction-market-leaves-solana-for-robinhood)
- [KuCoin — World migrates to Robinhood Chain](https://www.kucoin.com/blog/world-prediction-market-moves-to-robinhood)
