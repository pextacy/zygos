import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, type Connection } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import type { ConsensusSnapshot, MatchEvent } from '@zygos/core';
import type { VenuePosition } from '@zygos/venue-adapters';
import { eq } from 'drizzle-orm';
import { rebuildOnNonce } from '../src/chain/nonce.js';
import { decryptDelegation, encryptDelegation, parseDelegationKey } from '../src/crypto.js';
import { delegations, openDb } from '../src/db.js';
import type { FeedLogger, FeedService } from '../src/feed.js';
import type { HedgeOrchestrator, HedgePreview } from '../src/hedge.js';
import { RuleEngine, type RuleExecutedFrame, type RuleFiredFrame } from '../src/rules.js';
import type { ValuationService } from '../src/valuation.js';

/**
 * Delegated execution (Phase 4): arm → pre-sign on a durable nonce → event →
 * server submits the stored tx; failures fall back to the signable prompt.
 */

const silentLog: FeedLogger = { info: () => {}, warn: () => {}, error: () => {} };
const BLOCKHASH = '4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM';

const POSITION: VenuePosition = {
  positionRef: 'pos-1',
  fixtureId: 'fx-1',
  market: { kind: '1X2' },
  outcome: 'HOME',
  size: 10_000_000n,
  entryPrice: null,
};

/** Real venue instructions run under the venue's program, never System — and
 * both the client check and storeDelegation reject stray System instructions. */
const VENUE_PROGRAM_ID = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');

function venueTxBase64(payer: PublicKey): string {
  const tx = new Transaction().add(
    new TransactionInstruction({
      programId: VENUE_PROGRAM_ID,
      keys: [{ pubkey: payer, isSigner: true, isWritable: true }],
      data: Buffer.from([1, 2, 3]),
    }),
  );
  tx.feePayer = payer;
  tx.recentBlockhash = BLOCKHASH;
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}

async function makeStack(connection: Connection | null, preview?: HedgePreview, encKey: Buffer | null = null) {
  const listeners: Array<{ onEvent?: (e: MatchEvent) => void; onConsensus?: (s: ConsensusSnapshot) => void }> = [];
  const feed = { addListener: (l: (typeof listeners)[0]) => listeners.push(l) } as unknown as FeedService;
  const valuation = { getPosition: async () => POSITION } as unknown as ValuationService;
  const hedge = { preview: vi.fn(async () => preview ?? ({} as HedgePreview)) } as unknown as HedgeOrchestrator;
  const db = await openDb('memory://');
  const engine = new RuleEngine(db, valuation, hedge, feed, silentLog, connection, null, encKey);
  // The engine handles events fire-and-forget; give the async chain a tick to settle.
  const emit = async (e: MatchEvent) => {
    listeners.forEach((l) => l.onEvent?.(e));
    await new Promise((r) => setTimeout(r, 20));
  };
  return { engine, emit, db };
}

function goal(team: 'HOME' | 'AWAY' = 'HOME'): MatchEvent {
  return { packetId: 'pkt-goal', sourceTs: Date.now() - 400, fixtureId: 'fx-1', type: 'GOAL', team, inferred: false };
}

/** Build and user-sign a durable-nonce lock exactly as the client flow does. */
function signedDelegatedTx(user: Keypair, noncePubkey: PublicKey): string {
  const rebuilt = rebuildOnNonce(venueTxBase64(user.publicKey), user.publicKey, noncePubkey, BLOCKHASH);
  const tx = Transaction.from(Buffer.from(rebuilt, 'base64'));
  tx.sign(user);
  return tx.serialize({ requireAllSignatures: false }).toString('base64');
}

describe('rebuildOnNonce', () => {
  it('prepends nonceAdvance, keeps original instructions, stays unsigned', () => {
    const user = Keypair.generate();
    const nonceAccount = Keypair.generate().publicKey;
    const out = rebuildOnNonce(venueTxBase64(user.publicKey), user.publicKey, nonceAccount, BLOCKHASH);
    const tx = Transaction.from(Buffer.from(out, 'base64'));

    expect(tx.instructions).toHaveLength(2);
    expect(tx.instructions[0]?.programId.equals(SystemProgram.programId)).toBe(true);
    expect(tx.instructions[0]?.keys[0]?.pubkey.equals(nonceAccount)).toBe(true); // nonceAdvance on our account
    expect(tx.instructions[1]?.programId.equals(VENUE_PROGRAM_ID)).toBe(true); // original venue instruction
    expect(tx.feePayer?.equals(user.publicKey)).toBe(true);
    expect(tx.signatures.every((s) => s.signature === null)).toBe(true);
  });
});

describe('delegated rule execution', () => {
  it('stores a valid pre-signed tx and SUBMITS it on fire (RULE_EXECUTED, no prompt)', async () => {
    const user = Keypair.generate();
    const nonceAccount = Keypair.generate().publicKey;
    const sendRawTransaction = vi.fn(async () => 'SUBMITTED_SIG');
    const connection = { sendRawTransaction } as unknown as Connection;

    const { engine, emit } = await makeStack(connection);
    const rule = await engine.create({ wallet: user.publicKey.toBase58(), positionRef: 'pos-1', template: 'GOAL_LOCK', team: 'HOME', fraction: 0.7 });
    await engine.storeDelegation(rule.id, user.publicKey.toBase58(), nonceAccount.toBase58(), signedDelegatedTx(user, nonceAccount));
    expect(await engine.delegationStatus(rule.id)).toEqual({ status: 'armed', submittedSig: null });

    const executed: RuleExecutedFrame[] = [];
    const fired: RuleFiredFrame[] = [];
    engine.onExecuted((f) => executed.push(f));
    engine.onFired((f) => fired.push(f));

    await emit(goal());

    expect(sendRawTransaction).toHaveBeenCalledOnce();
    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatchObject({ type: 'RULE_EXECUTED', signature: 'SUBMITTED_SIG', template: 'GOAL_LOCK' });
    expect(fired).toHaveLength(0); // no prompt when execution landed
    expect(await engine.delegationStatus(rule.id)).toEqual({ status: 'submitted', submittedSig: 'SUBMITTED_SIG' });
  });

  it('falls back to the signable prompt when submission fails, marking the delegation failed', async () => {
    const user = Keypair.generate();
    const nonceAccount = Keypair.generate().publicKey;
    const connection = {
      sendRawTransaction: vi.fn(async () => {
        throw new Error('nonce already consumed');
      }),
    } as unknown as Connection;
    const preview: HedgePreview = {
      previewId: 'pv-1',
      plan: { viable: true, route: 'HEDGE', hedgeSize: '1', cost: '1', proceeds: '0', guaranteedFloor: '1', retainedUpside: '0', impliedExitProb: 0.5, edgePts: 0, payoutMatrix: [] },
      unsignedTxBase64: 'TX',
      packetIds: [],
      consensusAsOf: 0,
      simulated: true,
    };

    const { engine, emit } = await makeStack(connection, preview);
    const rule = await engine.create({ wallet: user.publicKey.toBase58(), positionRef: 'pos-1', template: 'GOAL_LOCK', team: 'HOME', fraction: 1 });
    await engine.storeDelegation(rule.id, user.publicKey.toBase58(), nonceAccount.toBase58(), signedDelegatedTx(user, nonceAccount));

    const fired: RuleFiredFrame[] = [];
    engine.onFired((f) => fired.push(f));
    await emit(goal());

    expect((await engine.delegationStatus(rule.id))?.status).toBe('failed');
    expect(fired).toHaveLength(1); // degraded to the one-tap prompt, never silent
  });

  it('rejects delegated txs that are unsigned, wrong-payer, or missing the nonceAdvance', async () => {
    const user = Keypair.generate();
    const other = Keypair.generate();
    const nonceAccount = Keypair.generate().publicKey;
    const { engine } = await makeStack({ sendRawTransaction: vi.fn() } as unknown as Connection);
    const rule = await engine.create({ wallet: user.publicKey.toBase58(), positionRef: 'pos-1', template: 'GOAL_LOCK', team: 'HOME', fraction: 1 });
    const wallet = user.publicKey.toBase58();

    // Unsigned.
    const unsigned = rebuildOnNonce(venueTxBase64(user.publicKey), user.publicKey, nonceAccount, BLOCKHASH);
    await expect(engine.storeDelegation(rule.id, wallet, nonceAccount.toBase58(), unsigned)).rejects.toThrow(/not signed/);

    // Signed by the wrong wallet claiming our rule.
    await expect(engine.storeDelegation(rule.id, wallet, nonceAccount.toBase58(), signedDelegatedTx(other, nonceAccount))).rejects.toThrow(/fee payer/);

    // No nonceAdvance first (plain venue tx signed directly).
    const plain = Transaction.from(Buffer.from(venueTxBase64(user.publicKey), 'base64'));
    plain.sign(user);
    const plainB64 = plain.serialize({ requireAllSignatures: false }).toString('base64');
    await expect(engine.storeDelegation(rule.id, wallet, nonceAccount.toBase58(), plainB64)).rejects.toThrow(/nonceAdvance|nonce account/);

    // A stray System-program instruction after the advance (hidden SOL
    // transfer/close) — mirrors the client-side pre-sign check.
    const withTransfer = Transaction.from(
      Buffer.from(rebuildOnNonce(venueTxBase64(user.publicKey), user.publicKey, nonceAccount, BLOCKHASH), 'base64'),
    );
    withTransfer.add(SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: other.publicKey, lamports: 5 }));
    withTransfer.sign(user);
    const withTransferB64 = withTransfer.serialize({ requireAllSignatures: false }).toString('base64');
    await expect(engine.storeDelegation(rule.id, wallet, nonceAccount.toBase58(), withTransferB64)).rejects.toThrow(/System-program/);
  });

  it('wallet-scoped: another wallet cannot delegate someone else’s rule', async () => {
    const user = Keypair.generate();
    const { engine } = await makeStack(null);
    const rule = await engine.create({ wallet: user.publicKey.toBase58(), positionRef: 'pos-1', template: 'GOAL_LOCK', team: 'HOME', fraction: 1 });
    await expect(engine.storeDelegation(rule.id, Keypair.generate().publicKey.toBase58(), 'x', 'y')).rejects.toThrow(/not found/);
  });
});

describe('delegation revoke (security-review requirement 1)', () => {
  it('erases the stored tx, returns a nonce-advance tx, and the rule no longer auto-executes', async () => {
    const user = Keypair.generate();
    const nonceAccount = Keypair.generate().publicKey;
    const sendRawTransaction = vi.fn(async () => 'SHOULD_NOT_SUBMIT');
    const connection = {
      sendRawTransaction,
      getLatestBlockhash: vi.fn(async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1 })),
    } as unknown as Connection;
    const preview: HedgePreview = {
      previewId: 'pv-1',
      plan: { viable: true, route: 'HEDGE', hedgeSize: '1', cost: '1', proceeds: '0', guaranteedFloor: '1', retainedUpside: '0', impliedExitProb: 0.5, edgePts: 0, payoutMatrix: [] },
      unsignedTxBase64: 'TX',
      packetIds: [],
      consensusAsOf: 0,
      simulated: true,
    };

    const { engine, emit } = await makeStack(connection, preview);
    const wallet = user.publicKey.toBase58();
    const rule = await engine.create({ wallet, positionRef: 'pos-1', template: 'GOAL_LOCK', team: 'HOME', fraction: 1 });
    await engine.storeDelegation(rule.id, wallet, nonceAccount.toBase58(), signedDelegatedTx(user, nonceAccount));

    const res = await engine.revokeDelegation(rule.id, wallet);
    expect(res.revoked).toBe(true);
    expect(res.noncePubkey).toBe(nonceAccount.toBase58());
    expect((await engine.delegationStatus(rule.id))?.status).toBe('revoked');

    // The returned tx is exactly one nonceAdvance on the delegation's nonce, authored by the wallet.
    const revokeTx = Transaction.from(Buffer.from(res.revokeTxBase64!, 'base64'));
    expect(revokeTx.instructions).toHaveLength(1);
    expect(revokeTx.instructions[0]?.programId.equals(SystemProgram.programId)).toBe(true);
    expect(revokeTx.instructions[0]?.keys[0]?.pubkey.equals(nonceAccount)).toBe(true);
    expect(revokeTx.feePayer?.equals(user.publicKey)).toBe(true);

    // A later event must NOT submit anything delegated — only the signable prompt path remains.
    const fired: RuleFiredFrame[] = [];
    engine.onFired((f) => fired.push(f));
    await emit(goal());
    expect(sendRawTransaction).not.toHaveBeenCalled();
    expect(fired).toHaveLength(1);
  });

  it('is wallet-bound and 404s without a delegation', async () => {
    const user = Keypair.generate();
    const { engine } = await makeStack(null);
    const rule = await engine.create({ wallet: user.publicKey.toBase58(), positionRef: 'pos-1', template: 'GOAL_LOCK', team: 'HOME', fraction: 1 });
    await expect(engine.revokeDelegation(rule.id, Keypair.generate().publicKey.toBase58())).rejects.toThrow(/not found/);
    await expect(engine.revokeDelegation(rule.id, user.publicKey.toBase58())).rejects.toThrow(/no delegation/);
  });
});

describe('delegation at-rest encryption (security-review requirement 3)', () => {
  it('stores ciphertext, decrypts transparently at fire time, and submits the original bytes', async () => {
    const user = Keypair.generate();
    const nonceAccount = Keypair.generate().publicKey;
    const sendRawTransaction = vi.fn(async () => 'ENC_SIG');
    const connection = { sendRawTransaction } as unknown as Connection;
    const key = parseDelegationKey('test-passphrase');

    const { engine, emit, db } = await makeStack(connection, undefined, key);
    const wallet = user.publicKey.toBase58();
    const rule = await engine.create({ wallet, positionRef: 'pos-1', template: 'GOAL_LOCK', team: 'HOME', fraction: 1 });
    const signedB64 = signedDelegatedTx(user, nonceAccount);
    await engine.storeDelegation(rule.id, wallet, nonceAccount.toBase58(), signedB64);

    // The DB row is ciphertext — a leaked dump yields no submittable tx without the env key.
    const row = (await db.select().from(delegations).where(eq(delegations.ruleId, rule.id)))[0];
    expect(row?.signedTxBase64.startsWith('enc:v1:')).toBe(true);
    expect(row?.signedTxBase64).not.toContain(signedB64.slice(0, 24));

    await emit(goal());
    expect(sendRawTransaction).toHaveBeenCalledOnce();
    const submitted = (sendRawTransaction.mock.calls[0] as unknown[])[0] as Buffer;
    expect(Buffer.from(submitted).toString('base64')).toBe(signedB64);
  });

  it('crypto helpers: roundtrip, plaintext passthrough, tamper and missing-key failures', () => {
    const key = parseDelegationKey('a'.repeat(64)); // 64-hex → raw bytes
    const blob = encryptDelegation('hello-tx', key!);
    expect(blob.startsWith('enc:v1:')).toBe(true);
    expect(decryptDelegation(blob, key)).toBe('hello-tx');
    expect(decryptDelegation('plain-blob', null)).toBe('plain-blob'); // pre-key rows pass through
    expect(() => decryptDelegation(blob, null)).toThrow(/not configured/);
    expect(() => decryptDelegation(blob, parseDelegationKey('other-key'))).toThrow();
    expect(parseDelegationKey(undefined)).toBeNull();
    expect(parseDelegationKey('')).toBeNull();
  });
});
