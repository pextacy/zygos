import {
  Connection,
  Keypair,
  NONCE_ACCOUNT_LENGTH,
  NonceAccount,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';

/**
 * Durable-nonce plumbing for delegated rule execution (Phase 4 / PRD US-4 v2).
 *
 * Why durable nonces: a normal transaction dies with its blockhash (~90s). A
 * rule may fire hours after arming, so the pre-signed lock transaction is
 * built on a durable nonce owned by the USER's wallet — it stays valid until
 * submitted, and only the user's own `nonceAdvance` (embedded as the first
 * instruction) can consume it. The server stores a fully-signed transaction
 * it cannot alter: worst case on server compromise is EARLY submission of the
 * exact pre-agreed lock, never a different trade. That bound is the security
 * story, stated in phases.md G4.
 */

export interface NonceSetup {
  /** The nonce account address (new ephemeral keypair; authority = user wallet). */
  noncePubkey: string;
  /** Base64 tx: create + initialize the nonce account. Partially signed by the ephemeral keypair; the wallet co-signs and sends. */
  setupTxBase64: string;
}

/**
 * Build the nonce-account creation transaction. The ephemeral account keypair
 * signs here and its secret is DISCARDED — after initialization only the user
 * wallet (authority) can advance or withdraw.
 */
export async function buildNonceSetupTx(connection: Connection, wallet: PublicKey): Promise<NonceSetup> {
  const nonceAccount = Keypair.generate();
  const rent = await connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH);
  const { blockhash } = await connection.getLatestBlockhash('confirmed');

  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: wallet,
      newAccountPubkey: nonceAccount.publicKey,
      lamports: rent,
      space: NONCE_ACCOUNT_LENGTH,
      programId: SystemProgram.programId,
    }),
    SystemProgram.nonceInitialize({ noncePubkey: nonceAccount.publicKey, authorizedPubkey: wallet }),
  );
  tx.feePayer = wallet;
  tx.recentBlockhash = blockhash;
  tx.partialSign(nonceAccount); // ephemeral secret never persisted

  return {
    noncePubkey: nonceAccount.publicKey.toBase58(),
    setupTxBase64: tx.serialize({ requireAllSignatures: false }).toString('base64'),
  };
}

/** Read the current nonce value; null when the account does not exist/isn't a nonce account. */
export async function fetchNonce(connection: Connection, noncePubkey: PublicKey): Promise<string | null> {
  const info = await connection.getAccountInfo(noncePubkey, 'confirmed');
  if (!info) return null;
  try {
    return NonceAccount.fromAccountData(info.data).nonce;
  } catch {
    return null;
  }
}

/**
 * Rebuild a venue-built LEGACY transaction onto the user's durable nonce:
 * same instructions, same fee payer, but `nonceInfo` so it never expires.
 * Versioned venue transactions cannot be re-keyed this way — callers must
 * reject them for delegated mode (fail loudly, no silent downgrade).
 */
export function rebuildOnNonce(unsignedTxBase64: string, wallet: PublicKey, noncePubkey: PublicKey, nonce: string): string {
  const raw = Buffer.from(unsignedTxBase64, 'base64');
  let source: Transaction;
  try {
    source = Transaction.from(raw);
  } catch {
    throw new RangeError('delegated mode requires a legacy transaction from the venue; got a versioned tx');
  }

  const tx = new Transaction();
  tx.nonceInfo = {
    nonce,
    nonceInstruction: SystemProgram.nonceAdvance({ noncePubkey, authorizedPubkey: wallet }),
  };
  for (const ix of source.instructions) tx.add(ix);
  tx.feePayer = wallet;
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}
