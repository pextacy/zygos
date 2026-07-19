import { createHash, randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { Connection, PublicKey, SystemInstruction, SystemProgram, Transaction } from '@solana/web3.js';
import { marketKeyString, type ConsensusSnapshot, type MatchEvent } from '@zygos/core';
import { buildNonceRevokeTx, buildNonceSetupTx, fetchNonce, rebuildOnNonce } from './chain/nonce.js';
import { decryptDelegation, encryptDelegation } from './crypto.js';
import { delegations, ruleFirings, rules, type Db } from './db.js';
import type { FeedLogger, FeedService } from './feed.js';
import { HedgeOrchestrator, PreviewError, type HedgePreview } from './hedge.js';
import type { LockLedger } from './ledger.js';
import type { ValuationService } from './valuation.js';

/**
 * Rule engine (PRD FR-4x, DOCS.md §7). Three templates:
 *   GOAL_LOCK        — ON goal_for(my_team)  ⇒ prepare lock of `fraction`
 *   RED_CARD_REDUCE  — ON red_card(my_team)  ⇒ prepare exposure reduction to `fraction`
 *   PRICE_LOCK       — ON consensus prob of my outcome crossing a threshold ⇒
 *                      prepare lock of `fraction` (one-shot take-profit/stop;
 *                      edge-triggered on the cross, latched after it fires)
 * Rules are human-in-the-loop: a firing pre-builds and simulates the
 * transaction and pushes a RULE_FIRED frame for one-tap signing — the server
 * never signs (CLAUDE.md §2.2). Every firing logs the triggering packet (FR-43).
 */

export type RuleTemplate = 'GOAL_LOCK' | 'RED_CARD_REDUCE' | 'PRICE_LOCK';
export type PriceDirection = 'ABOVE' | 'BELOW';

export interface RuleRecord {
  id: string;
  wallet: string;
  positionRef: string;
  fixtureId: string;
  team: 'HOME' | 'AWAY';
  template: RuleTemplate;
  /** lock fraction in ppm for exact storage. */
  fractionPpm: number;
  /** PRICE_LOCK only: consensus-probability threshold in ppm of 1.0. */
  thresholdPpm: number | null;
  /** PRICE_LOCK only: side of the threshold that triggers the rule. */
  direction: PriceDirection | null;
  /** PRICE_LOCK only: set once it fires; a fired price rule never re-fires. */
  firedAt: number | null;
  createdAt: number;
  intentHash: string;
}

/** A PRICE_LOCK trigger: the consensus tick that crossed the armed threshold. */
export interface PriceTrigger {
  type: 'PRICE_CROSS';
  /** Newest packet contributing to the crossing snapshot (FR-13 provenance). */
  packetId: string;
  /** asOf of the crossing snapshot, ms epoch. */
  sourceTs: number;
  fixtureId: string;
  outcome: 'HOME' | 'AWAY';
  prob: number;
  threshold: number;
  direction: PriceDirection;
}

export type RuleTrigger = MatchEvent | PriceTrigger;

export interface RuleFiredFrame {
  type: 'RULE_FIRED';
  ruleId: string;
  wallet: string;
  positionRef: string;
  template: RuleTemplate;
  event: RuleTrigger;
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
  event: RuleTrigger;
  signature: string;
  latencyMs: number;
}

/**
 * sha256 over the canonical rule body — pre-committed on-chain as proof the
 * rule predated its firing (FR-41). PRICE_LOCK folds its threshold terms in;
 * event templates keep the exact pre-PRICE_LOCK byte layout so hashes
 * committed before this template shipped still recompute.
 */
export function intentHash(rule: Omit<RuleRecord, 'id' | 'intentHash' | 'firedAt'>): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        wallet: rule.wallet,
        positionRef: rule.positionRef,
        fixtureId: rule.fixtureId,
        team: rule.team,
        template: rule.template,
        fractionPpm: rule.fractionPpm,
        ...(rule.template === 'PRICE_LOCK' ? { thresholdPpm: rule.thresholdPpm, direction: rule.direction } : {}),
        createdAt: rule.createdAt,
      }),
    )
    .digest('hex');
}

export class RuleEngine {
  private firedListeners: Array<(f: RuleFiredFrame) => void> = [];
  private executedListeners: Array<(f: RuleExecutedFrame) => void> = [];
  /** ruleId → last observed consensus prob, for PRICE_LOCK cross detection. */
  private readonly lastProb = new Map<string, number>();
  /**
   * fixtureId → count of armed (unfired) PRICE_LOCK rules. Gates the per-tick
   * candidates query: onConsensus runs on every tick of every tracked market,
   * and without this gate each tick costs a DB round trip even with zero
   * price rules armed. Lazily loaded from the DB on the first tick; a stale
   * over-count only costs one extra query, never a missed rule.
   */
  private priceLockIndex: Map<string, number> | null = null;
  private priceLockIndexPromise: Promise<Map<string, number>> | null = null;

  constructor(
    private readonly db: Db,
    private readonly valuation: ValuationService,
    private readonly hedge: HedgeOrchestrator,
    feed: FeedService,
    private readonly log: FeedLogger,
    private readonly connection: Connection | null = null,
    private readonly ledger: LockLedger | null = null,
    /** At-rest encryption key for stored pre-signed txs (security-review req 3); null ⇒ plaintext (dev). */
    private readonly encKey: Buffer | null = null,
  ) {
    feed.addListener({
      onEvent: (event) => void this.onEvent(event),
      onConsensus: (snap) => void this.onConsensus(snap),
    });
  }

  onFired(cb: (f: RuleFiredFrame) => void): void {
    this.firedListeners.push(cb);
  }

  onExecuted(cb: (f: RuleExecutedFrame) => void): void {
    this.executedListeners.push(cb);
  }

  async create(input: {
    wallet: string;
    positionRef: string;
    template: RuleTemplate;
    team: 'HOME' | 'AWAY';
    fraction: number;
    threshold?: number;
    direction?: PriceDirection;
  }): Promise<RuleRecord> {
    const position = await this.valuation.getPosition(input.wallet, input.positionRef);
    if (!position) throw new PreviewError(404, `position ${input.positionRef} not found for wallet`);
    if (position.outcome !== 'HOME' && position.outcome !== 'AWAY') {
      throw new PreviewError(422, `rules are supported for HOME/AWAY positions, not ${position.outcome}`);
    }
    if (!(input.fraction > 0 && input.fraction <= 1)) {
      throw new PreviewError(422, `fraction out of (0,1]: ${input.fraction}`);
    }
    const isPrice = input.template === 'PRICE_LOCK';
    if (isPrice) {
      if (input.threshold === undefined || !(input.threshold > 0 && input.threshold < 1)) {
        throw new PreviewError(422, `PRICE_LOCK threshold out of (0,1): ${input.threshold}`);
      }
      if (input.direction !== 'ABOVE' && input.direction !== 'BELOW') {
        throw new PreviewError(422, `PRICE_LOCK direction must be ABOVE or BELOW`);
      }
    }

    const body = {
      wallet: input.wallet,
      positionRef: input.positionRef,
      fixtureId: position.fixtureId,
      team: input.team,
      template: input.template,
      fractionPpm: Math.round(input.fraction * 1_000_000),
      thresholdPpm: isPrice ? Math.round(input.threshold! * 1_000_000) : null,
      direction: isPrice ? input.direction! : null,
      createdAt: Date.now(),
    };
    const record: RuleRecord = { ...body, id: randomUUID(), firedAt: null, intentHash: intentHash(body) };

    await this.db
      .insert(rules)
      .values({
        id: record.id,
        wallet: record.wallet,
        positionRef: record.positionRef,
        fixtureId: record.fixtureId,
        team: record.team,
        template: record.template,
        fraction: record.fractionPpm,
        threshold: record.thresholdPpm,
        direction: record.direction,
        firedAt: null,
        createdAt: record.createdAt,
        intentHash: record.intentHash,
      });
    if (record.template === 'PRICE_LOCK') {
      await this.ensurePriceLockIndex();
      this.bumpPriceLockIndex(record.fixtureId, +1);
    }
    this.log.info({ ruleId: record.id, fixtureId: record.fixtureId, template: record.template }, 'rule armed');
    return record;
  }

  async list(wallet: string): Promise<RuleRecord[]> {
    const rows = await this.db.select().from(rules).where(eq(rules.wallet, wallet));
    return rows.map(rowToRecord);
  }

  /** Returns false when the rule does not exist or belongs to another wallet. */
  async remove(id: string, wallet: string): Promise<boolean> {
    const existing = (await this.db.select().from(rules).where(eq(rules.id, id)))[0];
    if (!existing || existing.wallet !== wallet) return false;
    await this.db.delete(rules).where(eq(rules.id, id));
    await this.db.delete(delegations).where(eq(delegations.ruleId, id));
    if (existing.template === 'PRICE_LOCK' && existing.firedAt === null) this.bumpPriceLockIndex(existing.fixtureId, -1);
    return true;
  }

  private ensurePriceLockIndex(): Promise<Map<string, number>> {
    this.priceLockIndexPromise ??= (async () => {
      const idx = new Map<string, number>();
      const rows = await this.db.select().from(rules).where(eq(rules.template, 'PRICE_LOCK'));
      for (const row of rows) {
        if (row.firedAt === null) idx.set(row.fixtureId, (idx.get(row.fixtureId) ?? 0) + 1);
      }
      this.priceLockIndex = idx;
      return idx;
    })();
    return this.priceLockIndexPromise;
  }

  private bumpPriceLockIndex(fixtureId: string, delta: number): void {
    if (!this.priceLockIndex) return;
    const next = (this.priceLockIndex.get(fixtureId) ?? 0) + delta;
    if (next > 0) this.priceLockIndex.set(fixtureId, next);
    else this.priceLockIndex.delete(fixtureId);
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
    const rule = await this.getOwnedRule(ruleId, wallet);

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
  async storeDelegation(ruleId: string, wallet: string, noncePubkey: string, signedTxBase64: string): Promise<void> {
    await this.getOwnedRule(ruleId, wallet);
    let tx: Transaction;
    try {
      tx = Transaction.from(Buffer.from(signedTxBase64, 'base64'));
    } catch (err) {
      throw new PreviewError(422, `signedTxBase64 is not a valid transaction: ${err instanceof Error ? err.message : String(err)}`);
    }
    const walletKey = new PublicKey(wallet);

    if (!tx.feePayer?.equals(walletKey)) throw new PreviewError(422, 'fee payer is not the rule wallet');
    const hasWalletSig = tx.signatures.some((s) => s.publicKey.equals(walletKey) && s.signature !== null);
    if (!hasWalletSig) throw new PreviewError(422, 'transaction is not signed by the wallet');
    // Cryptographic check, not just presence: a garbage signature would sit
    // armed for hours and only fail at fire time, silently degrading the rule.
    if (!tx.verifySignatures()) throw new PreviewError(422, 'transaction signature verification failed');
    const first = tx.instructions[0];
    let advance: { noncePubkey: PublicKey; authorizedPubkey: PublicKey };
    try {
      if (first === undefined || !first.programId.equals(SystemProgram.programId) || SystemInstruction.decodeInstructionType(first) !== 'AdvanceNonceAccount') {
        throw new Error('not a nonce advance');
      }
      advance = SystemInstruction.decodeNonceAdvance(first);
    } catch {
      throw new PreviewError(422, 'first instruction must advance the declared nonce account');
    }
    if (advance.noncePubkey.toBase58() !== noncePubkey) throw new PreviewError(422, 'nonce advance targets a different nonce account than declared');
    if (!advance.authorizedPubkey.equals(walletKey)) throw new PreviewError(422, 'nonce authority is not the rule wallet');
    // Mirror of the client's pre-sign check: beyond the leading advance, no
    // other System-program instruction may ride along (hidden SOL transfers /
    // account closes). Keeping both sides identical stops them drifting apart.
    if (tx.instructions.slice(1).some((ix) => ix.programId.equals(SystemProgram.programId))) {
      throw new PreviewError(422, 'unexpected extra System-program instruction in delegated tx');
    }

    // At-rest encryption (security-review req 3): a DB leak without the env
    // key yields no submittable transaction.
    const stored = this.encKey ? encryptDelegation(signedTxBase64, this.encKey) : signedTxBase64;
    await this.db
      .insert(delegations)
      .values({ ruleId, wallet, noncePubkey, signedTxBase64: stored, createdAt: Date.now(), status: 'armed', submittedSig: null })
      .onConflictDoUpdate({
        target: delegations.ruleId,
        set: { noncePubkey, signedTxBase64: stored, createdAt: Date.now(), status: 'armed', submittedSig: null },
      });
    this.log.info({ ruleId, noncePubkey, encrypted: this.encKey !== null }, 'delegated execution armed (pre-signed durable-nonce tx stored)');
  }

  /**
   * Revoke a delegation (security-review requirement 1). Two layers:
   *  1. server-side, immediate: the stored pre-signed tx is erased and the row
   *     marked revoked — this server can never submit it again;
   *  2. on-chain, against leaked copies: returns an unsigned `nonceAdvance` on
   *     the user's own nonce account; once the wallet signs and lands it, every
   *     outstanding pre-signed tx on that nonce is void forever.
   */
  async revokeDelegation(ruleId: string, wallet: string): Promise<{ revoked: true; noncePubkey: string; revokeTxBase64: string | null }> {
    await this.getOwnedRule(ruleId, wallet);
    const row = (await this.db.select().from(delegations).where(eq(delegations.ruleId, ruleId)))[0];
    if (!row) throw new PreviewError(404, 'no delegation to revoke for this rule');

    await this.db
      .update(delegations)
      .set({ status: 'revoked', signedTxBase64: '' })
      .where(eq(delegations.ruleId, ruleId));

    let revokeTxBase64: string | null = null;
    if (this.connection) {
      try {
        revokeTxBase64 = await buildNonceRevokeTx(this.connection, new PublicKey(wallet), new PublicKey(row.noncePubkey));
      } catch (err) {
        this.log.error(
          { ruleId, err: err instanceof Error ? err.message : String(err) },
          'revoke tx build failed — stored tx erased server-side, but sign a nonce advance later to void leaked copies',
        );
      }
    }
    this.log.info({ ruleId, noncePubkey: row.noncePubkey }, 'delegation revoked (stored tx erased; nonce-advance tx returned for on-chain invalidation)');
    return { revoked: true, noncePubkey: row.noncePubkey, revokeTxBase64 };
  }

  async delegationStatus(ruleId: string): Promise<{ status: string; submittedSig: string | null } | null> {
    const row = (await this.db.select().from(delegations).where(eq(delegations.ruleId, ruleId)))[0];
    return row ? { status: row.status, submittedSig: row.submittedSig ?? null } : null;
  }

  /** Batch variant for listing endpoints — one query instead of one per rule. */
  async delegationStatuses(ruleIds: string[]): Promise<Map<string, { status: string; submittedSig: string | null }>> {
    if (ruleIds.length === 0) return new Map();
    const rows = await this.db.select().from(delegations).where(inArray(delegations.ruleId, ruleIds));
    return new Map(rows.map((r) => [r.ruleId, { status: r.status, submittedSig: r.submittedSig ?? null }]));
  }

  private async getOwnedRule(ruleId: string, wallet: string): Promise<RuleRecord> {
    const row = (await this.db.select().from(rules).where(eq(rules.id, ruleId)))[0];
    if (!row || row.wallet !== wallet) throw new PreviewError(404, 'rule not found for this wallet');
    return rowToRecord(row);
  }

  private async onEvent(event: MatchEvent): Promise<void> {
    if (event.type !== 'GOAL' && event.type !== 'RED_CARD') return;
    const wanted: RuleTemplate = event.type === 'GOAL' ? 'GOAL_LOCK' : 'RED_CARD_REDUCE';

    const candidates = (await this.db.select().from(rules).where(eq(rules.fixtureId, event.fixtureId))).map(rowToRecord);
    for (const rule of candidates) {
      if (rule.template !== wanted) continue;
      if (event.team !== rule.team) continue;
      await this.fire(rule, event);
    }
  }

  /**
   * PRICE_LOCK evaluation (edge-triggered): a rule fires only on the tick that
   * crosses its threshold, never level-triggered on every tick beyond it — so
   * a failed preview consumes the cross and stays quiet until the price
   * re-crosses. Successful firings latch `firedAt`: price rules are one-shot.
   */
  private async onConsensus(snap: ConsensusSnapshot): Promise<void> {
    const idx = await this.ensurePriceLockIndex();
    if (!idx.has(snap.fixtureId)) return;

    const candidates = (await this.db.select().from(rules).where(eq(rules.fixtureId, snap.fixtureId)))
      .map(rowToRecord)
      .filter((r) => r.template === 'PRICE_LOCK' && r.firedAt === null);

    for (const rule of candidates) {
      const prob = snap.probs[rule.team];
      if (prob === undefined || rule.thresholdPpm === null || rule.direction === null) continue;
      const threshold = rule.thresholdPpm / 1_000_000;
      const last = this.lastProb.get(rule.id);
      this.lastProb.set(rule.id, prob);

      // Edge-triggered means a cross must be OBSERVED. The first tick seen for
      // a rule (fresh arm, or a restart wiping this in-memory map) only
      // establishes the baseline — otherwise a price already beyond the
      // threshold at arm/boot time would fire (and auto-submit a delegated
      // pre-signed tx) without any actual cross.
      if (last === undefined) continue;

      const beyond = rule.direction === 'ABOVE' ? prob >= threshold : prob <= threshold;
      const wasBeyond = rule.direction === 'ABOVE' ? last >= threshold : last <= threshold;
      if (!beyond || wasBeyond) continue;

      const trigger: PriceTrigger = {
        type: 'PRICE_CROSS',
        packetId: snap.packetIds[snap.packetIds.length - 1] ?? 'unknown',
        sourceTs: snap.asOf,
        fixtureId: snap.fixtureId,
        outcome: rule.team,
        prob,
        threshold,
        direction: rule.direction,
      };
      if (await this.fire(rule, trigger)) {
        await this.db.update(rules).set({ firedAt: Date.now() }).where(eq(rules.id, rule.id));
        this.lastProb.delete(rule.id);
        this.bumpPriceLockIndex(rule.fixtureId, -1);
      }
    }
  }

  /** Shared firing path. Returns true when the rule executed (delegated) or a signable prompt was emitted. */
  private async fire(rule: RuleRecord, trigger: RuleTrigger): Promise<boolean> {
    // Delegated path first (Phase 4): submit the user's pre-signed tx directly.
    if (await this.tryDelegatedExecution(rule, trigger)) return true;

    try {
      const preview = await this.hedge.preview(rule.wallet, rule.positionRef, rule.fractionPpm / 1_000_000);
      // A non-viable plan returns without throwing (empty tx, not simulated).
      // Treat it exactly like a failed preview: no prompt, and the cross is
      // consumed WITHOUT latching — the rule re-arms on the next cross instead
      // of burning the one-shot on nothing signable.
      if (!preview.plan.viable) {
        this.log.warn(
          { ruleId: rule.id, fixtureId: rule.fixtureId, packetId: trigger.packetId, reason: preview.plan.reason ?? 'unviable at current prices' },
          'rule fired but plan not viable — no prompt shown',
        );
        return false;
      }
      const latencyMs = Date.now() - trigger.sourceTs;
      const frame: RuleFiredFrame = {
        type: 'RULE_FIRED',
        ruleId: rule.id,
        wallet: rule.wallet,
        positionRef: rule.positionRef,
        template: rule.template,
        event: trigger,
        preview,
        latencyMs,
      };
      await this.db
        .insert(ruleFirings)
        .values({ id: randomUUID(), ruleId: rule.id, packetId: trigger.packetId, eventType: trigger.type, firedAt: Date.now(), latencyMs });
      this.log.info(
        { ruleId: rule.id, fixtureId: rule.fixtureId, packetId: trigger.packetId, latencyMs, inferred: 'inferred' in trigger ? trigger.inferred : undefined },
        'rule fired',
      );
      for (const cb of this.firedListeners) cb(frame);
      return true;
    } catch (err) {
      // A firing that cannot produce a safe signable tx surfaces as a log +
      // no prompt — never an unsimulated signature request (CLAUDE.md §2.4).
      this.log.error(
        { ruleId: rule.id, packetId: trigger.packetId, err: err instanceof Error ? err.message : String(err) },
        'rule fired but preview/simulation failed — no prompt shown',
      );
      return false;
    }
  }

  /** Returns true when execution was delegated AND submitted; false falls through to the signable prompt. */
  private async tryDelegatedExecution(rule: RuleRecord, event: RuleTrigger): Promise<boolean> {
    if (!this.connection) return false;
    const row = (await this.db.select().from(delegations).where(eq(delegations.ruleId, rule.id)))[0];
    if (!row || row.status !== 'armed') return false;

    try {
      const raw = Buffer.from(decryptDelegation(row.signedTxBase64, this.encKey), 'base64');
      const signature = await this.connection.sendRawTransaction(raw, { skipPreflight: false });
      await this.db.update(delegations).set({ status: 'submitted', submittedSig: signature }).where(eq(delegations.ruleId, rule.id));

      const latencyMs = Date.now() - event.sourceTs;
      await this.db
        .insert(ruleFirings)
        .values({ id: randomUUID(), ruleId: rule.id, packetId: event.packetId, eventType: event.type, firedAt: Date.now(), latencyMs });
      const position = await this.valuation.getPosition(rule.wallet, rule.positionRef).catch(() => null);
      this.log.info(
        {
          ruleId: rule.id,
          signature,
          fixtureId: rule.fixtureId,
          market: position ? marketKeyString(position.market) : 'unknown',
          packetId: event.packetId,
          latencyMs,
        },
        'delegated rule EXECUTED (pre-signed tx submitted)',
      );

      // Ledger entry: a delegated submission carries no fresh preview, so plan
      // fields stay null; the trigger packet is the provenance (FR-43).
      if (this.ledger) {
        await this.ledger.record({
          wallet: rule.wallet,
          positionRef: rule.positionRef,
          fixtureId: rule.fixtureId,
          market: position ? marketKeyString(position.market) : 'unknown',
          outcome: position?.outcome ?? rule.team,
          fractionPpm: rule.fractionPpm,
          route: null,
          guaranteedFloor: null,
          edgePts: null,
          impliedExitProb: null,
          packetIds: [event.packetId],
          consensusAsOf: null,
          txSig: signature,
          source: 'DELEGATED',
          ruleId: rule.id,
          sizeBefore: position?.size.toString() ?? null,
          sizeAfter: null,
          executedAt: Date.now(),
        });
      }

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
      await this.db.update(delegations).set({ status: 'failed' }).where(eq(delegations.ruleId, rule.id)).catch(() => {});
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
    thresholdPpm: row.threshold ?? null,
    direction: (row.direction as PriceDirection | null) ?? null,
    firedAt: row.firedAt ?? null,
    createdAt: row.createdAt,
    intentHash: row.intentHash,
  };
}
