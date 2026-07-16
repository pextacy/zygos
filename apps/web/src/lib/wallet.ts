'use client';

import { Buffer } from 'buffer';
import { Transaction, VersionedTransaction } from '@solana/web3.js';

export type AnyTransaction = Transaction | VersionedTransaction;

export function deserializeTx(base64: string): AnyTransaction {
  const raw = Buffer.from(base64, 'base64');
  try {
    return VersionedTransaction.deserialize(raw);
  } catch {
    return Transaction.from(raw);
  }
}

/** Auth payload for mutating endpoints: wallet signs `zygos:{action}:{nonce}` (DOCS.md §8). */
export async function buildWalletAuth(
  action: string,
  wallet: string,
  signMessage: (message: Uint8Array) => Promise<Uint8Array>,
): Promise<{ wallet: string; nonce: number; signature: string }> {
  const nonce = Date.now();
  const signature = await signMessage(new TextEncoder().encode(`zygos:${action}:${nonce}`));
  return { wallet, nonce, signature: Buffer.from(signature).toString('base64') };
}
