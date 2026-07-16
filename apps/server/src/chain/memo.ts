import { createHash } from 'node:crypto';
import { ComputeBudgetProgram, Connection, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';

/**
 * On-chain commitments via the SPL Memo program — the single place Zygos
 * writes to chain itself. One builder for both commitment kinds so formats
 * stay consistent and parseable:
 *   zygos:lock:{sha256(fixture|market|side|fraction|sorted packetIds)}
 *   zygos:rule:{sha256(canonical rule body)}
 * The transaction is returned UNSIGNED; only the user's wallet signs
 * (CLAUDE.md §2.2).
 */

export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

/** Memo instructions are tiny; a tight compute limit keeps priority-fee exposure minimal. */
const MEMO_COMPUTE_UNITS = 10_000;

export function lockCommitment(input: { fixtureId: string; market: string; side: string; fraction: number; packetIds: string[] }): string {
  const hash = createHash('sha256')
    .update(JSON.stringify({ fixtureId: input.fixtureId, market: input.market, side: input.side, fraction: input.fraction, packetIds: [...input.packetIds].sort() }))
    .digest('hex');
  return `zygos:lock:${hash}`;
}

export function ruleCommitment(intentHash: string): string {
  return `zygos:rule:${intentHash}`;
}

export function memoInstruction(text: string): TransactionInstruction {
  return new TransactionInstruction({ keys: [], programId: MEMO_PROGRAM_ID, data: Buffer.from(text, 'utf8') });
}

/**
 * Build an unsigned memo transaction with a fresh blockhash and a bounded
 * compute limit. Returns the lastValidBlockHeight so callers can confirm
 * with the full blockhash triple instead of a bare signature.
 */
export async function buildUnsignedMemoTx(
  connection: Connection,
  payer: PublicKey,
  text: string,
): Promise<{ txBase64: string; blockhash: string; lastValidBlockHeight: number }> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: MEMO_COMPUTE_UNITS }))
    .add(memoInstruction(text));
  tx.feePayer = payer;
  tx.recentBlockhash = blockhash;
  return { txBase64: tx.serialize({ requireAllSignatures: false }).toString('base64'), blockhash, lastValidBlockHeight };
}
