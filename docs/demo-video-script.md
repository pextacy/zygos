# Demo video script (2:45) — shot-by-shot

Target: PLAN.md T3.5. Record everything raw during the Jul 17–18 match
sessions (capture checklist in `runbook-matchday.md` §6), then cut to this
script. Desktop capture at 1080p+; keep the wallet visible for authenticity.

| # | Time | Scene | Footage source | On-screen | Voiceover |
|---|------|-------|----------------|-----------|-----------|
| 1 | 0:00–0:20 | **Cold open: the problem** | Live session — a position's fair value dropping tick by tick | Positions table, red P&L, lag delta visible | "Cash-out is the most used feature in sportsbooks. On-chain prediction markets don't have it. This position is losing value right now — and the on-chain price hasn't even noticed yet." |
| 2 | 0:20–1:00 | **The terminal, live** | Match board + positions during live play | Consensus probabilities ticking, TxLINE badges, LIVE badge, lag delta | "Zygos values every position against TxLINE's de-vigged consensus across bookmakers — timestamped, anchored on Solana. The venue price lags real match state; that gap is the lag delta, and you're seeing it live." |
| 3 | 1:00–1:45 | **The goal moment** | Day-2 capture: goal → fair value jumps → lock | Fair value jump, Lock In click, fraction slider, payout matrix, edge line ("+X pts above fair"), wallet sign, explorer confirmation | "Goal. Fair value jumps instantly — the on-chain book is still catching up. One click: choose your fraction, see the guaranteed payout for every outcome, and the line that matters: this lock fills 2.8 points above fair value. Sign. Confirmed on Solana, with a commitment memo — the lock itself is now auditable on-chain." |
| 4 | 1:45–2:15 | **Rules** | Armed rule firing on the event | Rule arm modal → full-screen GOAL overlay → one-tap sign | "Set it before kickoff: if my team scores, lock seventy percent. The rule's intent hash was committed on-chain when it was armed — provably before the goal. It fires in under three seconds with a pre-simulated transaction. One tap. You sign; Zygos never holds keys." |
| 5 | 2:15–2:45 | **Close** | Terminal wide shot → logo | STALE-lockout flash (optional), logo card: "The scale balances." | "Fair value from TxLINE's multi-book consensus. Non-custodial. Every lock auditable on Solana. Per-lock fee or subscription — demand already proven by every sportsbook's cash-out button. The scale balances — Zygos." |

## Cut notes

- Scene 3 is the money shot: do NOT trim the sign→explorer sequence; judges
  need to see the wallet popup and the confirmed tx.
- If the rule fires on an ⚡ inferred event, keep the tag visible and say
  "inferred from the odds move — still real data" (domain literacy signal).
- Backup plan: if Jul 18 footage fails, Scene 1–2 from Jul 17's headless +
  UI session; Scenes 3–4 re-shot on devnet with the caveat stated on screen.
- Export: 1080p, ≤3:00, burned-in captions (judges often watch muted).
