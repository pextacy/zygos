import { PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';

/**
 * Signed-message auth for mutating endpoints (DOCS.md §8): the wallet signs
 * `zygos:{action}:{nonce}` where nonce is a client ms-timestamp. Binds the
 * request to wallet ownership with no accounts or passwords. Nonces are
 * single-use within a ±5 minute window (replay guard).
 */

const WINDOW_MS = 5 * 60_000;
const seenNonces = new Map<string, number>(); // `${wallet}:${nonce}` → expiry

export interface WalletAuth {
  wallet: string;
  nonce: number;
  /** base64 detached ed25519 signature over `zygos:{action}:{nonce}`. */
  signature: string;
}

export function verifyWalletAuth(action: string, auth: WalletAuth, nowMs: number = Date.now()): { ok: true } | { ok: false; reason: string } {
  // Requests arrive as untyped JSON: reject malformed payloads instead of
  // throwing (and NaN nonces would slip past the window check below).
  if (
    typeof auth !== 'object' ||
    auth === null ||
    typeof auth.wallet !== 'string' ||
    typeof auth.signature !== 'string' ||
    typeof auth.nonce !== 'number' ||
    !Number.isSafeInteger(auth.nonce)
  ) {
    return { ok: false, reason: 'malformed auth payload' };
  }
  if (Math.abs(nowMs - auth.nonce) > WINDOW_MS) {
    return { ok: false, reason: 'nonce outside the ±5 minute window' };
  }
  const key = `${auth.wallet}:${auth.nonce}`;
  const expiry = seenNonces.get(key);
  if (expiry !== undefined && expiry >= nowMs) {
    return { ok: false, reason: 'nonce already used' };
  }

  let pubkeyBytes: Uint8Array;
  try {
    pubkeyBytes = new PublicKey(auth.wallet).toBytes();
  } catch {
    return { ok: false, reason: 'invalid wallet address' };
  }

  let signature: Uint8Array;
  try {
    signature = Uint8Array.from(Buffer.from(auth.signature, 'base64'));
  } catch {
    return { ok: false, reason: 'signature is not base64' };
  }

  const message = new TextEncoder().encode(`zygos:${action}:${auth.nonce}`);
  if (!nacl.sign.detached.verify(message, signature, pubkeyBytes)) {
    return { ok: false, reason: 'signature verification failed' };
  }

  // The entry must outlive the nonce's acceptance window (now ≤ nonce + WINDOW):
  // expiring at nowMs + WINDOW would re-admit a future-dated nonce near the
  // window's edge — a replay. Anchor expiry to the nonce itself.
  seenNonces.set(key, auth.nonce + WINDOW_MS);
  if (seenNonces.size > 10_000) {
    for (const [k, exp] of seenNonces) {
      if (exp < nowMs) seenNonces.delete(k);
    }
  }
  return { ok: true };
}
