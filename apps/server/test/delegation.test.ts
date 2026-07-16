import { Keypair, PublicKey, SystemProgram, Transaction, type Connection } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import type { ConsensusSnapshot, MatchEvent } from '@zygos/core';
import type { VenuePosition } from '@zygos/venue-adapters';
import { rebuildOnNonce } from '../src/chain/nonce.js';
import { openDb } from '../src/db.js';
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

function venueTxBase64(payer: PublicKey): string {
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 5 }));
  tx.feePayer = payer;
  tx.recentBlockhash = BLOCKHASH;
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}

function makeStack(connection: Connection | null, preview?: HedgePreview) {
  const listeners: Array<{ onEvent?: (e: MatchEvent) => void; onConsensus?: (s: ConsensusSnapshot) => void }> = [];
  const feed = { addListener: (l: (typeof listeners)[0]) => listeners.push(l) } as unknown as FeedService;
  const valuation = { getPosition: async () => POSITION } as unknown as ValuationService;
  const hedge = { preview: vi.fn(async () => preview ?? ({} as HedgePreview)) } as unknown as HedgeOrchestrator;
  const engine = new RuleEngine(openDb(':memory:'), valuation, hedge, feed, silentLog, connection);
  // The engine handles events fire-and-forget; give the async chain a tick to settle.
  const emit = async (e: MatchEvent) => {
    listeners.forEach((l) => l.onEvent?.(e));
    await new Promise((r) => setTimeout(r, 20));
  };
  return { engine, emit };
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
    expect(tx.instructions[1]?.programId.equals(SystemProgram.programId)).toBe(true); // original transfer
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

    const { engine, emit } = makeStack(connection);
    const rule = await engine.create({ wallet: user.publicKey.toBase58(), positionRef: 'pos-1', template: 'GOAL_LOCK', team: 'HOME', fraction: 0.7 });
    engine.storeDelegation(rule.id, user.publicKey.toBase58(), nonceAccount.toBase58(), signedDelegatedTx(user, nonceAccount));
    expect(engine.delegationStatus(rule.id)).toEqual({ status: 'armed', submittedSig: null });

    const executed: RuleExecutedFrame[] = [];
    const fired: RuleFiredFrame[] = [];
    engine.onExecuted((f) => executed.push(f));
    engine.onFired((f) => fired.push(f));

    await emit(goal());

    expect(sendRawTransaction).toHaveBeenCalledOnce();
    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatchObject({ type: 'RULE_EXECUTED', signature: 'SUBMITTED_SIG', template: 'GOAL_LOCK' });
    expect(fired).toHaveLength(0); // no prompt when execution landed
    expect(engine.delegationStatus(rule.id)).toEqual({ status: 'submitted', submittedSig: 'SUBMITTED_SIG' });
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
      plan: { viable: true, route: 'HEDGE', hedgeSize: '1', cost: '1', proceeds: '0', guaranteedFloor: '1', retainedUpside: '0', impliedExitProb: 0.5, edgePts: 0, payoutMatrix: [] },
      unsignedTxBase64: 'TX',
      packetIds: [],
      consensusAsOf: 0,
      simulated: true,
    };

    const { engine, emit } = makeStack(connection, preview);
    const rule = await engine.create({ wallet: user.publicKey.toBase58(), positionRef: 'pos-1', template: 'GOAL_LOCK', team: 'HOME', fraction: 1 });
    engine.storeDelegation(rule.id, user.publicKey.toBase58(), nonceAccount.toBase58(), signedDelegatedTx(user, nonceAccount));

    const fired: RuleFiredFrame[] = [];
    engine.onFired((f) => fired.push(f));
    await emit(goal());

    expect(engine.delegationStatus(rule.id)?.status).toBe('failed');
    expect(fired).toHaveLength(1); // degraded to the one-tap prompt, never silent
  });

  it('rejects delegated txs that are unsigned, wrong-payer, or missing the nonceAdvance', async () => {
    const user = Keypair.generate();
    const other = Keypair.generate();
    const nonceAccount = Keypair.generate().publicKey;
    const { engine } = makeStack({ sendRawTransaction: vi.fn() } as unknown as Connection);
    const rule = await engine.create({ wallet: user.publicKey.toBase58(), positionRef: 'pos-1', template: 'GOAL_LOCK', team: 'HOME', fraction: 1 });
    const wallet = user.publicKey.toBase58();

    // Unsigned.
    const unsigned = rebuildOnNonce(venueTxBase64(user.publicKey), user.publicKey, nonceAccount, BLOCKHASH);
    expect(() => engine.storeDelegation(rule.id, wallet, nonceAccount.toBase58(), unsigned)).toThrow(/not signed/);

    // Signed by the wrong wallet claiming our rule.
    expect(() => engine.storeDelegation(rule.id, wallet, nonceAccount.toBase58(), signedDelegatedTx(other, nonceAccount))).toThrow(/fee payer/);

    // No nonceAdvance first (plain venue tx signed directly).
    const plain = Transaction.from(Buffer.from(venueTxBase64(user.publicKey), 'base64'));
    plain.sign(user);
    const plainB64 = plain.serialize({ requireAllSignatures: false }).toString('base64');
    expect(() => engine.storeDelegation(rule.id, wallet, nonceAccount.toBase58(), plainB64)).toThrow(/nonceAdvance|nonce account/);
  });

  it('wallet-scoped: another wallet cannot delegate someone else’s rule', async () => {
    const user = Keypair.generate();
    const { engine } = makeStack(null);
    const rule = await engine.create({ wallet: user.publicKey.toBase58(), positionRef: 'pos-1', template: 'GOAL_LOCK', team: 'HOME', fraction: 1 });
    expect(() => engine.storeDelegation(rule.id, Keypair.generate().publicKey.toBase58(), 'x', 'y')).toThrow(/not found/);
  });
});
