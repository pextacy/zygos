'use client';

import { Buffer } from 'buffer';
import { PublicKey, SystemInstruction, SystemProgram, Transaction, TransactionInstruction, VersionedTransaction } from '@solana/web3.js';

export type AnyTransaction = Transaction | VersionedTransaction;

export function deserializeTx(base64: string): AnyTransaction {
  const raw = Buffer.from(base64, 'base64');
  try {
    return VersionedTransaction.deserialize(raw);
  } catch {
    return Transaction.from(raw);
  }
}

/**
 * True only when `ix` DECODES as a System nonce-advance on `noncePubkey`
 * authorized by `wallet`. Decoding matters: a WithdrawNonceAccount or
 * AuthorizeNonceAccount instruction also targets the nonce account with
 * keys[0], so a programId+keys[0] heuristic would let a malicious server
 * drain the nonce balance or steal its authority under a signature meant
 * for an advance (mirrors the server's storeDelegation check).
 */
export function isNonceAdvanceFor(ix: TransactionInstruction | undefined, wallet: PublicKey, noncePubkey: string): boolean {
  if (ix === undefined || !ix.programId.equals(SystemProgram.programId)) return false;
  try {
    if (SystemInstruction.decodeInstructionType(ix) !== 'AdvanceNonceAccount') return false;
    const advance = SystemInstruction.decodeNonceAdvance(ix);
    return advance.noncePubkey.toBase58() === noncePubkey && advance.authorizedPubkey.equals(wallet);
  } catch {
    return false;
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
