import { mkdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { bigint, doublePrecision, integer, pgTable, text } from 'drizzle-orm/pg-core';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import pg from 'pg';

/**
 * Persistence layer, Postgres dialect throughout:
 *   DATABASE_URL=postgres://…  → managed Postgres (Neon) via node-postgres
 *   DATABASE_URL=<dir path>    → embedded PGlite (zero-setup local dev)
 *   DATABASE_URL=memory://     → in-memory PGlite (tests)
 * One dialect means one schema and one migration path; only the driver differs.
 *
 * Packet audit log (PLAN.md T1.3, DOCS.md §3.2): raw poll bodies are hashed
 * and recorded BEFORE parsing so provenance survives parser bugs; every
 * consumed tick is then recorded with its market and the raw-body hash it
 * came from (FR-13: any displayed fair value traces to source packets).
 *
 * All timestamps are ms-epoch numbers (BIGINT — they exceed int4 range).
 */

export const rawPackets = pgTable('raw_packets', {
  hash: text('hash').primaryKey(),
  fixtureId: text('fixture_id').notNull(),
  receivedAt: bigint('received_at', { mode: 'number' }).notNull(),
});

export const packets = pgTable('packets', {
  packetId: text('packet_id').primaryKey(),
  sourceTs: bigint('source_ts', { mode: 'number' }).notNull(),
  fixtureId: text('fixture_id').notNull(),
  market: text('market').notNull(),
  rawHash: text('raw_hash').notNull(),
});

/** Automation rules (PRD FR-4x). Stored server-side keyed by wallet; intent hash pre-committed on-chain by the user. */
export const rules = pgTable('rules', {
  id: text('id').primaryKey(),
  wallet: text('wallet').notNull(),
  positionRef: text('position_ref').notNull(),
  fixtureId: text('fixture_id').notNull(),
  /** HOME | AWAY — the side the position holds; determines event/price matching. */
  team: text('team').notNull(),
  template: text('template').notNull(), // 'GOAL_LOCK' | 'RED_CARD_REDUCE' | 'PRICE_LOCK'
  fraction: integer('fraction').notNull(), // lock fraction in ppm (0, 1_000_000]
  /** PRICE_LOCK only: consensus-probability threshold in ppm of 1.0. */
  threshold: integer('threshold'),
  /** PRICE_LOCK only: fire when consensus crosses ABOVE or BELOW the threshold. */
  direction: text('direction'),
  /** PRICE_LOCK is one-shot: set when it fires, after which it never re-fires. */
  firedAt: bigint('fired_at', { mode: 'number' }),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  intentHash: text('intent_hash').notNull(),
});

/**
 * Delegated execution (Phase 4): the user's pre-signed, durable-nonce lock
 * transaction per rule. The server can only ever SUBMIT this exact tx.
 */
export const delegations = pgTable('delegations', {
  ruleId: text('rule_id').primaryKey(),
  wallet: text('wallet').notNull(),
  noncePubkey: text('nonce_pubkey').notNull(),
  signedTxBase64: text('signed_tx_base64').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  status: text('status').notNull(), // 'armed' | 'submitted' | 'failed'
  submittedSig: text('submitted_sig'),
});

/**
 * Lock ledger: every verified executed lock, persisted so the edge captured
 * vs TxLINE fair value survives the session (extends FR-33's on-chain memo
 * with a queryable server-side record). Plan fields are nullable because a
 * delegated submission carries no fresh preview at fire time.
 */
export const locks = pgTable('locks', {
  id: text('id').primaryKey(),
  wallet: text('wallet').notNull(),
  positionRef: text('position_ref').notNull(),
  fixtureId: text('fixture_id').notNull(),
  market: text('market').notNull(),
  outcome: text('outcome').notNull(),
  fractionPpm: integer('fraction_ppm').notNull(),
  route: text('route'), // 'CLOSE' | 'HEDGE'
  guaranteedFloor: text('guaranteed_floor'), // µUSD bigint as text
  edgePts: doublePrecision('edge_pts'), // vs TxLINE fair value at the signed preview
  impliedExitProb: doublePrecision('implied_exit_prob'),
  packetIds: text('packet_ids').notNull(), // JSON array — FR-13 provenance
  consensusAsOf: bigint('consensus_as_of', { mode: 'number' }),
  txSig: text('tx_sig'),
  /** Signature of the on-chain memo commitment (FR-33), attached after the user signs it. */
  memoSig: text('memo_sig'),
  source: text('source').notNull(), // 'MANUAL' | 'RULE' | 'DELEGATED'
  ruleId: text('rule_id'),
  sizeBefore: text('size_before'),
  sizeAfter: text('size_after'),
  executedAt: bigint('executed_at', { mode: 'number' }).notNull(),
});

/**
 * Market binding registry: TxLINE fixture/market ↔ venue marketId mapping
 * (the MarketBinding the Jupiter adapter consumes). Persisted so bindings
 * made at the liquidity gate survive restarts; README "known limitation #1".
 */
export const marketBindings = pgTable('market_bindings', {
  /** Venue-native market id (e.g. a Jupiter Predict marketId). */
  marketId: text('market_id').primaryKey(),
  fixtureId: text('fixture_id').notNull(),
  /** Market key string: '1X2' | 'TOTAL:<line>' (core marketKeyString format). */
  market: text('market').notNull(),
  /** Domain outcome a YES contract represents (HOME/DRAW/AWAY/OVER/UNDER). */
  yesOutcome: text('yes_outcome').notNull(),
  source: text('source').notNull(), // 'MANUAL' | 'MATCHED'
  note: text('note'),
  createdBy: text('created_by').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

/** Every rule firing, with the triggering TxLINE packet reference (FR-43). */
export const ruleFirings = pgTable('rule_firings', {
  id: text('id').primaryKey(),
  ruleId: text('rule_id').notNull(),
  packetId: text('packet_id').notNull(),
  eventType: text('event_type').notNull(),
  firedAt: bigint('fired_at', { mode: 'number' }).notNull(),
  /** event sourceTs → signable prompt, ms (PRD ≤3s median). */
  latencyMs: integer('latency_ms').notNull(),
});

/** Driver-agnostic handle: node-postgres (Neon) and PGlite both satisfy it. */
export type Db = PgDatabase<PgQueryResultHKT>;

/** Idempotent boot migration — additive only, matching the historical schema. */
const MIGRATION_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS raw_packets (
    hash TEXT PRIMARY KEY,
    fixture_id TEXT NOT NULL,
    received_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS packets (
    packet_id TEXT PRIMARY KEY,
    source_ts BIGINT NOT NULL,
    fixture_id TEXT NOT NULL,
    market TEXT NOT NULL,
    raw_hash TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_packets_fixture ON packets (fixture_id, source_ts)`,
  `CREATE TABLE IF NOT EXISTS rules (
    id TEXT PRIMARY KEY,
    wallet TEXT NOT NULL,
    position_ref TEXT NOT NULL,
    fixture_id TEXT NOT NULL,
    team TEXT NOT NULL,
    template TEXT NOT NULL,
    fraction INTEGER NOT NULL,
    threshold INTEGER,
    direction TEXT,
    fired_at BIGINT,
    created_at BIGINT NOT NULL,
    intent_hash TEXT NOT NULL
  )`,
  // Rules tables created before PRICE_LOCK lack these columns.
  `ALTER TABLE rules ADD COLUMN IF NOT EXISTS threshold INTEGER`,
  `ALTER TABLE rules ADD COLUMN IF NOT EXISTS direction TEXT`,
  `ALTER TABLE rules ADD COLUMN IF NOT EXISTS fired_at BIGINT`,
  `CREATE INDEX IF NOT EXISTS idx_rules_fixture ON rules (fixture_id)`,
  `CREATE TABLE IF NOT EXISTS rule_firings (
    id TEXT PRIMARY KEY,
    rule_id TEXT NOT NULL,
    packet_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    fired_at BIGINT NOT NULL,
    latency_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS locks (
    id TEXT PRIMARY KEY,
    wallet TEXT NOT NULL,
    position_ref TEXT NOT NULL,
    fixture_id TEXT NOT NULL,
    market TEXT NOT NULL,
    outcome TEXT NOT NULL,
    fraction_ppm INTEGER NOT NULL,
    route TEXT,
    guaranteed_floor TEXT,
    edge_pts DOUBLE PRECISION,
    implied_exit_prob DOUBLE PRECISION,
    packet_ids TEXT NOT NULL,
    consensus_as_of BIGINT,
    tx_sig TEXT,
    memo_sig TEXT,
    source TEXT NOT NULL,
    rule_id TEXT,
    size_before TEXT,
    size_after TEXT,
    executed_at BIGINT NOT NULL
  )`,
  `ALTER TABLE locks ADD COLUMN IF NOT EXISTS memo_sig TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_locks_wallet ON locks (wallet, executed_at)`,
  `CREATE TABLE IF NOT EXISTS market_bindings (
    market_id TEXT PRIMARY KEY,
    fixture_id TEXT NOT NULL,
    market TEXT NOT NULL,
    yes_outcome TEXT NOT NULL,
    source TEXT NOT NULL,
    note TEXT,
    created_by TEXT NOT NULL,
    created_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_bindings_fixture ON market_bindings (fixture_id)`,
  `CREATE TABLE IF NOT EXISTS delegations (
    rule_id TEXT PRIMARY KEY,
    wallet TEXT NOT NULL,
    nonce_pubkey TEXT NOT NULL,
    signed_tx_base64 TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    status TEXT NOT NULL,
    submitted_sig TEXT
  )`,
];

const IS_POSTGRES_URL = /^postgres(ql)?:\/\//;
const IS_MEMORY = /^(memory:\/\/|:memory:$)/;

/** How a DATABASE_URL will be opened — lets the boot path warn about ephemeral on-disk fallbacks. */
export function dbKind(databaseUrl: string): 'postgres' | 'memory' | 'pglite-dir' {
  if (IS_POSTGRES_URL.test(databaseUrl)) return 'postgres';
  if (IS_MEMORY.test(databaseUrl)) return 'memory';
  return 'pglite-dir';
}

/**
 * Open the database and run the idempotent boot migration.
 *
 * Neon note: non-local postgres:// connections force TLS with certificate
 * verification (Neon serves publicly-trusted certs); `sslmode` in the URL is
 * therefore not required but harmless.
 */
export async function openDb(databaseUrl: string): Promise<Db> {
  let db: Db;
  if (IS_POSTGRES_URL.test(databaseUrl)) {
    // Parse the host instead of regexing the whole URL: credential-less forms
    // like postgres://localhost:5432/db must also count as local, or a plain
    // non-SSL dev Postgres gets TLS forced on it and boot fails.
    let local = false;
    try {
      const host = new URL(databaseUrl).hostname;
      local = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
    } catch {
      // unparseable URL: leave `local` false and let pg surface the real error
    }
    const pool = new pg.Pool({ connectionString: databaseUrl, ...(local ? {} : { ssl: { rejectUnauthorized: true } }) });
    db = drizzleNodePg(pool);
  } else if (IS_MEMORY.test(databaseUrl)) {
    db = drizzlePglite(new PGlite());
  } else {
    // Embedded PGlite: the path is a data DIRECTORY (not a single file).
    mkdirSync(databaseUrl, { recursive: true });
    db = drizzlePglite(new PGlite(databaseUrl));
  }
  for (const stmt of MIGRATION_STATEMENTS) {
    await db.execute(sql.raw(stmt));
  }
  return db;
}
