import { asc, eq } from 'drizzle-orm';
import { marketKeyString, OUTCOMES_BY_KIND, parseMarketKey } from '@zygos/core';
import type { MarketBinding } from '@zygos/venue-adapters';
import { marketBindings, type Db } from './db.js';

/**
 * Market binding registry (closes README "known limitation #1"): the
 * persistent TxLINE fixture ↔ venue market mapping that the Jupiter adapter
 * consumes. The adapter holds a reference to `map`, so an upsert/remove here
 * is visible to position mapping and quote routing immediately — no restart.
 *
 * Bindings are server-level configuration, not user data: with ADMIN_WALLETS
 * set, only those wallets may mutate them; unset (single-operator dev
 * deployments) any signature-verified wallet may. Reads are public — a
 * binding is exactly as public as the markets it joins.
 */

export type BindingSource = 'MANUAL' | 'MATCHED';

export interface BindingRecord {
  marketId: string;
  fixtureId: string;
  market: string; // marketKeyString format
  yesOutcome: string;
  source: BindingSource;
  note: string | null;
  createdBy: string;
  createdAt: number;
}

export class BindingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BindingValidationError';
  }
}

function requireString(field: string, value: unknown, maxLen = 200): string {
  if (typeof value !== 'string') throw new BindingValidationError(`${field} must be a string`);
  if (value.length > maxLen) throw new BindingValidationError(`${field} too long (max ${maxLen} chars)`);
  return value;
}

// Market-key grammar and outcome vocabulary live in @zygos/core next to
// marketKeyString — re-exported here for existing importers.
export { parseMarketKey } from '@zygos/core';

export class BindingRegistry {
  /** Live map shared by reference with the venue adapter. */
  private readonly live = new Map<string, MarketBinding>();

  private constructor(private readonly db: Db) {}

  /** Load persisted bindings into the live map (async: Postgres-backed). */
  static async open(db: Db): Promise<BindingRegistry> {
    const registry = new BindingRegistry(db);
    for (const row of await db.select().from(marketBindings)) {
      const market = parseMarketKey(row.market);
      if (!market) continue; // unparseable legacy row: skip rather than crash the boot
      registry.live.set(row.marketId, { fixtureId: row.fixtureId, market, yesOutcome: row.yesOutcome });
    }
    return registry;
  }

  /** Pass this (by reference) to the venue adapter's `bindings` option. */
  get map(): ReadonlyMap<string, MarketBinding> {
    return this.live;
  }

  async list(): Promise<BindingRecord[]> {
    const rows = await this.db.select().from(marketBindings).orderBy(asc(marketBindings.createdAt));
    return rows.map(rowToRecord);
  }

  async upsert(input: {
    marketId: string;
    fixtureId: string;
    market: string;
    yesOutcome: string;
    source?: BindingSource;
    note?: string | null;
    createdBy: string;
    nowMs?: number;
  }): Promise<BindingRecord> {
    // Runtime type checks at the boundary: callers hand through externally
    // supplied JSON, and a non-string here would otherwise surface as a
    // TypeError 500 instead of a validation 400.
    const marketId = requireString('marketId', input.marketId).trim();
    const fixtureId = requireString('fixtureId', input.fixtureId).trim();
    requireString('market', input.market);
    requireString('yesOutcome', input.yesOutcome);
    if (input.note !== undefined && input.note !== null) requireString('note', input.note, 500);
    if (marketId.length === 0) throw new BindingValidationError('marketId required');
    if (fixtureId.length === 0) throw new BindingValidationError('fixtureId required');
    const market = parseMarketKey(input.market);
    if (!market) throw new BindingValidationError(`market must be '1X2' or 'TOTAL:<line>', got '${input.market}'`);
    const allowed = OUTCOMES_BY_KIND[market.kind];
    if (!allowed.includes(input.yesOutcome)) {
      throw new BindingValidationError(`yesOutcome for ${market.kind} must be one of ${allowed.join('/')}, got '${input.yesOutcome}'`);
    }

    const rec: BindingRecord = {
      marketId,
      fixtureId,
      market: marketKeyString(market),
      yesOutcome: input.yesOutcome,
      source: input.source ?? 'MANUAL',
      note: input.note ?? null,
      createdBy: input.createdBy,
      createdAt: input.nowMs ?? Date.now(),
    };
    await this.db
      .insert(marketBindings)
      .values(rec)
      .onConflictDoUpdate({
        target: marketBindings.marketId,
        set: {
          fixtureId: rec.fixtureId,
          market: rec.market,
          yesOutcome: rec.yesOutcome,
          source: rec.source,
          note: rec.note,
          createdBy: rec.createdBy,
          createdAt: rec.createdAt,
        },
      });
    this.live.set(marketId, { fixtureId: rec.fixtureId, market, yesOutcome: rec.yesOutcome });
    return rec;
  }

  async remove(marketId: string): Promise<boolean> {
    this.live.delete(marketId);
    // Existence comes from the DB, not the live map: an unparseable legacy row
    // is absent from `live` but must still be deletable (and report success).
    const deleted = await this.db.delete(marketBindings).where(eq(marketBindings.marketId, marketId)).returning({ marketId: marketBindings.marketId });
    return deleted.length > 0;
  }
}

function rowToRecord(row: typeof marketBindings.$inferSelect): BindingRecord {
  return {
    marketId: row.marketId,
    fixtureId: row.fixtureId,
    market: row.market,
    yesOutcome: row.yesOutcome,
    source: row.source === 'MATCHED' ? 'MATCHED' : 'MANUAL',
    note: row.note,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}
