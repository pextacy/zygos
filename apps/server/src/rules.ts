import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Connection, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import type { MatchEvent } from '@zygos/core';
import { buildNonceSetupTx, fetchNonce, rebuildOnNonce } from './chain/nonce.js';
import { delegations, ruleFirings, rules, type Db } from './db.js';
import type { FeedLogger, FeedService } from './feed.js';
import { HedgeOrchestrator, PreviewError, type HedgePreview } from './hedge.js';
import type { ValuationService } from './valuation.js';

/**
 * Rule engine v1 (PRD FR-4x, DOCS.md §7). Two templates:
 *   GOAL_LOCK        — ON goal_for(my_team)  ⇒ prepare lock of `fraction`
 *   RED_CARD_REDUCE  — ON red_card(my_team)  ⇒ prepare exposure reduction to `fraction`
 * Rules are human-in-the-loop: a firing pre-builds and simulates the
 * transaction and pushes a RULE_FIRED frame for one-tap signing — the server
 * never signs (CLAUDE.md §2.2). Every firing logs the triggering packet (FR-43).
 */

export type RuleTemplate = 'GOAL_LOCK' | 'RED_CARD_REDUCE';

export interface RuleRecord {
  id: string;
  wallet: string;
  positionRef: string;
  fixtureId: string;
  team: 'HOME' | 'AWAY';
  template: RuleTemplate;
  /** lock fraction in ppm for exact storage. */
  fractionPpm: number;
  createdAt: number;
  intentHash: string;
}

export interface RuleFiredFrame {
  type: 'RULE_FIRED';
  ruleId: string;
  wallet: string;
  positionRef: string;
  template: RuleTemplate;
  event: MatchEvent;
  preview: HedgePreview;
  latencyMs: number;
}

/** Phase 4: a delegated rule executed by submitting the user's pre-signed tx. */
export interface RuleExecutedFrame {
  type: 'RULE_EXECUTED';
  ruleId: string;
  wallet: string;
  positionRef: string;
  template: RuleTemplate;
  event: MatchEvent;
  signature: string;
  latencyMs: number;
}

/** sha256 over the canonical rule body — pre-committed on-chain as proof the rule predated its firing (FR-41). */
export function intentHash(rule: Omit<RuleRecord, 'id' | 'intentHash'>): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        wallet: rule.wallet,
        positionRef: rule.positionRef,
        fixtureId: rule.fixtureId,
        team: rule.team,
        template: rule.template,
        fractionPpm: rule.fractionPpm,
        createdAt: rule.createdAt,
      }),
    )
    .digest('hex');
}

export class RuleEngine {
  private firedListeners: Array<(f: RuleFiredFrame) => void> = [];
  private executedListeners: Array<(f: RuleExecutedFrame) => void> = [];

  constructor(
    private readonly db: Db,
    private readonly valuation: ValuationService,
    private readonly hedge: HedgeOrchestrator,
    feed: FeedService,
    private readonly log: FeedLogger,
    private readonly connection: Connection | null = null,
  ) {
    feed.addListener({ onEvent: (event) => void this.onEvent(event) });
  }

  onFired(cb: (f: RuleFiredFrame) => void): void {
    this.firedListeners.push(cb);
  }

  onExecuted(cb: (f: RuleExecutedFrame) => void): void {
    this.executedListeners.push(cb);
  }

  async create(input: { wallet: string; positionRef: string; template: RuleTemplate; team: 'HOME' | 'AWAY'; fraction: number }): Promise<RuleRecord> {
    const position = await this.valuation.getPosition(input.wallet, input.positionRef);
    if (!position) throw new PreviewError(404, `position ${input.positionRef} not found for wallet`);
    if (position.outcome !== 'HOME' && position.outcome !== 'AWAY') {
      throw new PreviewError(422, `rules are supported for HOME/AWAY positions, not ${position.outcome}`);
    }
    if (!(input.fraction > 0 && input.fraction <= 1)) {
      throw new PreviewError(422, `fraction out of (0,1]: ${input.fraction}`);
    }

    const body = {
      wallet: input.wallet,
      positionRef: input.positionRef,
      fixtureId: position.fixtureId,
      team: input.team,
      template: input.template,
      fractionPpm: Math.round(input.fraction * 1_000_000),
      createdAt: Date.now(),
    };
    const record: RuleRecord = { ...body, id: randomUUID(), intentHash: intentHash(body) };

    this.db
      .insert(rules)
      .values({
        id: record.id,
        wallet: record.wallet,
        positionRef: record.positionRef,
        fixtureId: record.fixtureId,
        team: record.team,
        template: record.template,
        fraction: record.fractionPpm,
        createdAt: record.createdAt,
        intentHash: record.intentHash,
      })
      .run();
    this.log.info({ ruleId: record.id, fixtureId: record.fixtureId, template: record.template }, 'rule armed');
    return record;
  }

  list(wallet: string): RuleRecord[] {
    return this.db
      .select()
      .from(rules)
      .where(eq(rules.wallet, wallet))
      .all()
      .map(rowToRecord);
  }

  /** Returns false when the rule does not exist or belongs to another wallet. */
  remove(id: string, wallet: string): boolean {
    const existing = this.db.select().from(rules).where(eq(rules.id, id)).all()[0];
    if (!existing || existing.wallet !== wallet) return false;
    this.db.delete(rules).where(eq(rules.id, id)).run();
    this.db.delete(delegations).where(eq(delegations.ruleId, id)).run();
    return true;
  }

  // ---- delegated execution (Phase 4) ----

  /**
   * Step 1 of delegation. Without a nonce account: returns the setup tx to
   * sign. With one: builds the lock on the durable nonce and returns it for
   * the user's signature. The tx embeds the venue's slippage bounds from the
   * preview quote — the server can never worsen the terms afterwards.
   */
  async prepareDelegation(
    ruleId: string,
    wallet: string,
    noncePubkey?: string,
  ): Promise<{ kind: 'NONCE_SETUP'; noncePubkey: string; setupTxBase64: string } | { kind: 'DELEGATE_TX'; noncePubkey: string; delegateTxBase64: string; preview: HedgePreview }> {
    if (!this.connection) throw new PreviewError(503, 'RPC not configured — delegated execution unavailable');
    const rule = this.getOwnedRule(ruleId, wallet);

    if (!noncePubkey) {
      const setup = await buildNonceSetupTx(this.connection, new PublicKey(wallet));
      return { kind: 'NONCE_SETUP', noncePubkey: setup.noncePubkey, setupTxBase64: setup.setupTxBase64 };
    }

    const nonce = await fetchNonce(this.connection, new PublicKey(noncePubkey));
    if (nonce === null) throw new PreviewError(409, 'nonce account not initialized yet — send the setup transaction first');

    const preview = await this.hedge.preview(wallet, rule.positionRef, rule.fractionPpm / 1_000_000);
    if (!preview.plan.viable) throw new PreviewError(409, `no viable lock to pre-sign: ${preview.plan.reason ?? 'unviable at current prices'}`);

    const delegateTxBase64 = rebuildOnNonce(preview.unsignedTxBase64, new PublicKey(wallet), new PublicKey(noncePubkey), nonce);
    return { kind: 'DELEGATE_TX', noncePubkey, delegateTxBase64, preview };
  }

  /**
   * Step 2: store the user-signed durable-nonce transaction. Bounded checks:
   * fee payer is the wallet, the wallet's signature is present, and the first
   * instruction is `nonceAdvance` on the claimed nonce account.
   */
  storeDelegation(ruleId: string, wallet: string, noncePubkey: string, signedTxBase64: string): void {
    this.getOwnedRule(ruleId, wallet);
    const tx = Transaction.from(Buffer.from(signedTxBase64, 'base64'));
    const walletKey = new PublicKey(wallet);

    if (!tx.feePayer?.equals(walletKey)) throw new PreviewError(422, 'fee payer is not the rule wallet');
    const hasWalletSig = tx.signatures.some((s) => s.publicKey.equals(walletKey) && s.signature !== null);
    if (!hasWalletSig) throw new PreviewError(422, 'transaction is not signed by the wallet');
    const first = tx.instructions[0];
    const isNonceAdvance =
      first !== undefined &&
      first.programId.equals(SystemProgram.programId) &&
      first.keys[0]?.pubkey.toBase58() === noncePubkey;
    if (!isNonceAdvance) throw new PreviewError(422, 'first instruction must advance the declared nonce account');

    this.db
      .insert(delegations)
      .values({ ruleId, wallet, noncePubkey, signedTxBase64, createdAt: Date.now(), status: 'armed', submittedSig: null })
      .onConflictDoUpdate({
        target: delegations.ruleId,
        set: { noncePubkey, signedTxBase64, createdAt: Date.now(), status: 'armed', submittedSig: null },
      })
      .run();
    this.log.info({ ruleId, noncePubkey }, 'delegated execution armed (pre-signed durable-nonce tx stored)');
  }

  delegationStatus(ruleId: string): { status: string; submittedSig: string | null } | null {
    const row = this.db.select().from(delegations).where(eq(delegations.ruleId, ruleId)).all()[0];
    return row ? { status: row.status, submittedSig: row.submittedSig ?? null } : null;
  }

  private getOwnedRule(ruleId: string, wallet: string): RuleRecord {
    const row = this.db.select().from(rules).where(eq(rules.id, ruleId)).all()[0];
    if (!row || row.wallet !== wallet) throw new PreviewError(404, 'rule not found for this wallet');
    return rowToRecord(row);
  }

  private async onEvent(event: MatchEvent): Promise<void> {
    if (event.type !== 'GOAL' && event.type !== 'RED_CARD') return;
    const wanted: RuleTemplate = event.type === 'GOAL' ? 'GOAL_LOCK' : 'RED_CARD_REDUCE';

    const candidates = this.db.select().from(rules).where(eq(rules.fixtureId, event.fixtureId)).all().map(rowToRecord);
    for (const rule of candidates) {
      if (rule.template !== wanted) continue;
      if (event.team !== rule.team) continue;

      // Delegated path first (Phase 4): submit the user's pre-signed tx directly.
      if (await this.tryDelegatedExecution(rule, event)) continue;

      try {
        const preview = await this.hedge.preview(rule.wallet, rule.positionRef, rule.fractionPpm / 1_000_000);
        const latencyMs = Date.now() - event.sourceTs;
        const frame: RuleFiredFrame = {
          type: 'RULE_FIRED',
          ruleId: rule.id,
          wallet: rule.wallet,
          positionRef: rule.positionRef,
          template: rule.template,
          event,
          preview,
          latencyMs,
        };
        this.db
          .insert(ruleFirings)
          .values({ id: randomUUID(), ruleId: rule.id, packetId: event.packetId, eventType: event.type, firedAt: Date.now(), latencyMs })
          .run();
        this.log.info({ ruleId: rule.id, packetId: event.packetId, latencyMs, inferred: event.inferred }, 'rule fired');
        for (const cb of this.firedListeners) cb(frame);
      } catch (err) {
        // A firing that cannot produce a safe signable tx surfaces as a log +
        // no prompt — never an unsimulated signature request (CLAUDE.md §2.4).
        this.log.error(
          { ruleId: rule.id, packetId: event.packetId, err: err instanceof Error ? err.message : String(err) },
          'rule fired but preview/simulation failed — no prompt shown',
        );
      }
    }
  }

  /** Returns true when execution was delegated AND submitted; false falls through to the signable prompt. */
  private async tryDelegatedExecution(rule: RuleRecord, event: MatchEvent): Promise<boolean> {
    if (!this.connection) return false;
    const row = this.db.select().from(delegations).where(eq(delegations.ruleId, rule.id)).all()[0];
    if (!row || row.status !== 'armed') return false;

    try {
      const raw = Buffer.from(row.signedTxBase64, 'base64');
      const signature = await this.connection.sendRawTransaction(raw, { skipPreflight: false });
      this.db.update(delegations).set({ status: 'submitted', submittedSig: signature }).where(eq(delegations.ruleId, rule.id)).run();

      const latencyMs = Date.now() - event.sourceTs;
      this.db
        .insert(ruleFirings)
        .values({ id: randomUUID(), ruleId: rule.id, packetId: event.packetId, eventType: event.type, firedAt: Date.now(), latencyMs })
        .run();
      this.log.info({ ruleId: rule.id, signature, packetId: event.packetId, latencyMs }, 'delegated rule EXECUTED (pre-signed tx submitted)');

      const frame: RuleExecutedFrame = {
        type: 'RULE_EXECUTED',
        ruleId: rule.id,
        wallet: rule.wallet,
        positionRef: rule.positionRef,
        template: rule.template,
        event,
        signature,
        latencyMs,
      };
      for (const cb of this.executedListeners) cb(frame);
      return true;
    } catch (err) {
      // Submission failed (nonce consumed, bounds exceeded, RPC error): mark and
      // fall back to the human prompt — degraded, never silent.
      this.db.update(delegations).set({ status: 'failed' }).where(eq(delegations.ruleId, rule.id)).run();
      this.log.error(
        { ruleId: rule.id, err: err instanceof Error ? err.message : String(err) },
        'delegated submission failed — falling back to one-tap prompt',
      );
      return false;
    }
  }
}

function rowToRecord(row: typeof rules.$inferSelect): RuleRecord {
  return {
    id: row.id,
    wallet: row.wallet,
    positionRef: row.positionRef,
    fixtureId: row.fixtureId,
    team: row.team as 'HOME' | 'AWAY',
    template: row.template as RuleTemplate,
    fractionPpm: row.fraction,
    createdAt: row.createdAt,
    intentHash: row.intentHash,
  };
}
