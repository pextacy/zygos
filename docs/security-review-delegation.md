# Security review — delegated rule execution (Phase 4 / G4 item 2)

**Scope:** the pre-signed durable-nonce path added in `1a67f73`:
`chain/nonce.ts`, `RuleEngine.prepareDelegation/storeDelegation/tryDelegatedExecution`,
`delegations` table, `/rules/:id/delegate` endpoints, `RuleArmModal` delegate flow.
**Reviewed:** 2026-07-16. **Verdict: acceptable for v2 rollout with the noted
operational requirements; no key custody is introduced anywhere in the path.**

## Design invariant

The server never holds a key and never constructs authority over funds. What
it holds is ONE fully-signed transaction whose contents the user approved in
their wallet: nonce-advance (their account) + the venue lock instructions with
slippage bounds baked in at arm time. The server's only new capability is
*when* to submit that exact transaction.

## Threat analysis

| # | Threat | Analysis | Disposition |
|---|--------|----------|-------------|
| 1 | **Server/DB compromise leaks the signed tx** | Attacker can submit it early — executing the pre-agreed lock at the pre-agreed bounds, or hold it. They cannot modify it (signature covers the message) or extract anything else. Loss bound: the user ends up locked earlier than intended. | Accepted, documented to the user in the arm dialog ("the server can only ever land this one pre-agreed transaction"). Mitigation available later: encrypt at rest; expiry via nonce withdrawal (see 6). |
| 2 | **Malicious server swaps the tx it asks the user to sign** | Real risk at arm time, same class as any dApp. The wallet displays the instructions; the delegate tx contains exactly nonce-advance + venue instructions rebuilt from the same preview the user just saw. Client uses `signTransaction` (not blind message signing). | Mitigate further in v2.1: client-side instruction diffing against the preview before signing (mirrors the RULE_FIRED re-check DOCS §9). Tracked. |
| 3 | **Replay / double submission** | Impossible: the durable nonce is consumed on first inclusion; a second submission fails at the nonce-advance. Engine also flips status `armed→submitted` before notifying. | Closed by construction. Verified by the "nonce already consumed → fallback" test. |
| 4 | **Wrong-wallet injection into `storeDelegation`** | Bounded checks: rule ownership (404 for foreign wallets), fee payer must equal the rule wallet, the wallet's signature must be present, first instruction must advance the declared nonce account. Adversarial tests cover all four rejections. | Closed. |
| 5 | **Stale-price execution** (prices moved between arm and fire) | The signed tx carries the venue's slippage bound from arm time. If the market moved beyond it, the venue program fails the tx → engine marks `failed` → falls back to the live prompt with a fresh, re-simulated preview. Never a silent worse fill. | Closed by venue-side bounds + tested fallback. Residual: a fill *within* the signed bounds may still be worse than the instant-fair price — inherent to pre-signing; disclosed in the arm dialog copy. |
| 6 | **Abandoned delegations** (rule deleted, match over) | `remove()` deletes the delegation row, but a leaked copy of the signed tx would remain valid until the nonce is consumed. Operational requirement: the UI should offer "revoke" = user submits a self nonce-advance (or withdraws the nonce account), invalidating every outstanding pre-signed tx at zero risk. | **Open — required before mainnet delegation.** Tracked as v2.1; low effort (one SystemProgram.nonceAdvance tx). |
| 7 | **Nonce-account setup spoofing** | Setup tx is built server-side but signed/sent by the wallet; ephemeral account secret is discarded after `partialSign`; authority is set to the wallet in the same tx the user reviews. Server never learns a usable secret (creation signature is worthless post-creation). | Closed. |
| 8 | **Auth on the delegate endpoints** | Both steps require fresh signed-message challenges (`rules-delegate`, `rules-delegate-store`) with replay-guarded nonces, wallet-scoped rule lookup. | Closed. |

## Residual-risk statement (for the submission / users)

Delegation trades "sign at 3 a.m." for "the operator could execute your
pre-agreed lock early." It cannot lose more than the approved trade's terms,
and it can be revoked at any time by advancing your own nonce (v2.1 UI).
Prompt-based rules remain the default; delegation is opt-in per rule.

## Requirements before mainnet delegation

1. ~~Revoke button (threat 6) — user-signed nonce advance.~~ **CLOSED
   2026-07-18:** `POST /rules/:id/revoke` erases the stored pre-signed tx
   server-side immediately and returns an unsigned `nonceAdvance` for the
   wallet to sign — landing it voids every outstanding pre-signed tx on the
   nonce, including leaked copies. Revoke buttons in Quick Rules and
   Automation; adversarial tests cover wallet-binding, the no-re-execution
   guarantee, and the advance-tx shape.
2. Client-side instruction check before pre-signing (threat 2). **Bounded
   version closed 2026-07-18:** before `signTransaction`, the client
   independently verifies fee payer = the connected wallet, exactly one
   leading `nonceAdvance` on the declared nonce account, and no other
   System-program instruction (blocks hidden SOL transfers/closes). The
   wallet's own instruction display remains the final review surface; a
   full venue-instruction diff stays open for when the venue program id is
   pinned client-side. **Strengthened 2026-07-19:** the leading instruction
   is verified with `SystemInstruction.decodeNonceAdvance` (type + nonce
   account + authority = this wallet), not a programId/keys[0] heuristic, so
   a `WithdrawNonceAccount`/`AuthorizeNonceAccount` can no longer pass as an
   advance; `storeDelegation` mirrors the same no-extra-System-instruction
   check server-side; and the revoke flow simulates the nonce-advance tx and
   verifies its shape before any signature prompt.
3. ~~Encrypt `delegations.signed_tx_base64` at rest.~~ **CLOSED 2026-07-18:**
   AES-256-GCM via `DELEGATION_ENC_KEY` (64-hex raw key or passphrase,
   sha256-derived). Blobs are self-describing (`enc:v1:`), so pre-key rows
   keep working and enabling the key needs no migration; decryption happens
   only at submit time. Boot warns loudly when the key is unset. A DB dump
   without the env key yields no submittable transaction.
