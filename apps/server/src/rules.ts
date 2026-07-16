import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { MatchEvent } from '@zygos/core';
import { ruleFirings, rules, type Db } from './db.js';
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

  constructor(
    private readonly db: Db,
    private readonly valuation: ValuationService,
    private readonly hedge: HedgeOrchestrator,
    feed: FeedService,
    private readonly log: FeedLogger,
  ) {
    feed.addListener({ onEvent: (event) => void this.onEvent(event) });
  }

  onFired(cb: (f: RuleFiredFrame) => void): void {
    this.firedListeners.push(cb);
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
    return true;
  }

  private async onEvent(event: MatchEvent): Promise<void> {
    if (event.type !== 'GOAL' && event.type !== 'RED_CARD') return;
    const wanted: RuleTemplate = event.type === 'GOAL' ? 'GOAL_LOCK' : 'RED_CARD_REDUCE';

    const candidates = this.db.select().from(rules).where(eq(rules.fixtureId, event.fixtureId)).all().map(rowToRecord);
    for (const rule of candidates) {
      if (rule.template !== wanted) continue;
      if (event.team !== rule.team) continue;

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
