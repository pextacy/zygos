import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';
import { verifyWalletAuth } from '../src/auth.js';

const T0 = 1_700_000_000_000;

function sign(action: string, nonce: number, keypair: Keypair): string {
  const message = new TextEncoder().encode(`zygos:${action}:${nonce}`);
  return Buffer.from(nacl.sign.detached(message, keypair.secretKey)).toString('base64');
}

describe('verifyWalletAuth (DOCS.md §8 signed-message auth)', () => {
  it('accepts a valid signature within the window', () => {
    const kp = Keypair.generate();
    const auth = { wallet: kp.publicKey.toBase58(), nonce: T0, signature: sign('rules-create', T0, kp) };
    expect(verifyWalletAuth('rules-create', auth, T0 + 1000)).toEqual({ ok: true });
  });

  it('rejects a replayed nonce', () => {
    const kp = Keypair.generate();
    const auth = { wallet: kp.publicKey.toBase58(), nonce: T0 + 1, signature: sign('rules-create', T0 + 1, kp) };
    expect(verifyWalletAuth('rules-create', auth, T0 + 1000).ok).toBe(true);
    const replay = verifyWalletAuth('rules-create', auth, T0 + 2000);
    expect(replay.ok).toBe(false);
    expect(replay).toMatchObject({ reason: expect.stringContaining('already used') });
  });

  it('rejects signatures over a different action (no cross-endpoint reuse)', () => {
    const kp = Keypair.generate();
    const auth = { wallet: kp.publicKey.toBase58(), nonce: T0 + 2, signature: sign('rules-create', T0 + 2, kp) };
    expect(verifyWalletAuth('rules-delete', auth, T0 + 1000).ok).toBe(false);
  });

  it('rejects nonces outside the ±5 minute window', () => {
    const kp = Keypair.generate();
    const nonce = T0 - 6 * 60_000;
    const auth = { wallet: kp.publicKey.toBase58(), nonce, signature: sign('x', nonce, kp) };
    expect(verifyWalletAuth('x', auth, T0).ok).toBe(false);
  });

  it('rejects a signature from a different wallet', () => {
    const signer = Keypair.generate();
    const claimed = Keypair.generate();
    const auth = { wallet: claimed.publicKey.toBase58(), nonce: T0 + 3, signature: sign('x', T0 + 3, signer) };
    expect(verifyWalletAuth('x', auth, T0 + 1000).ok).toBe(false);
  });

  it('rejects replay of a future-dated nonce for its whole acceptance window', () => {
    // Client clock ~5min ahead: nonce is at the far edge of the window.
    const kp = Keypair.generate();
    const nonce = T0 + 5 * 60_000 - 1000;
    const auth = { wallet: kp.publicKey.toBase58(), nonce, signature: sign('x', nonce, kp) };
    expect(verifyWalletAuth('x', auth, T0).ok).toBe(true);
    // Just after first use + 5min the seen-entry must NOT have expired while
    // the nonce itself is still inside its ±5min window (replay guard).
    const replay = verifyWalletAuth('x', auth, T0 + 5 * 60_000);
    expect(replay.ok).toBe(false);
    expect(replay).toMatchObject({ reason: expect.stringContaining('already used') });
  });

  it('rejects malformed auth payloads instead of throwing', () => {
    expect(verifyWalletAuth('x', undefined as never, T0).ok).toBe(false);
    expect(verifyWalletAuth('x', null as never, T0).ok).toBe(false);
    expect(verifyWalletAuth('x', { wallet: 'w', nonce: 'T0', signature: 's' } as never, T0).ok).toBe(false);
    expect(verifyWalletAuth('x', { wallet: 'w', nonce: Number.NaN, signature: 's' } as never, T0).ok).toBe(false);
    expect(verifyWalletAuth('x', { wallet: 'w', nonce: T0 } as never, T0).ok).toBe(false);
  });
});
