import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Packet audit log (PLAN.md T1.3, DOCS.md §3.2). Raw poll bodies are hashed
 * and recorded BEFORE parsing so provenance survives parser bugs; every
 * consumed tick is then recorded with its market and the raw-body hash it
 * came from (FR-13: any displayed fair value traces to source packets).
 */

export const rawPackets = sqliteTable('raw_packets', {
  hash: text('hash').primaryKey(),
  fixtureId: text('fixture_id').notNull(),
  receivedAt: integer('received_at').notNull(),
});

export const packets = sqliteTable('packets', {
  packetId: text('packet_id').primaryKey(),
  sourceTs: integer('source_ts').notNull(),
  fixtureId: text('fixture_id').notNull(),
  market: text('market').notNull(),
  rawHash: text('raw_hash').notNull(),
});

/** Automation rules v1 (PRD FR-4x). Stored server-side keyed by wallet; intent hash pre-committed on-chain by the user. */
export const rules = sqliteTable('rules', {
  id: text('id').primaryKey(),
  wallet: text('wallet').notNull(),
  positionRef: text('position_ref').notNull(),
  fixtureId: text('fixture_id').notNull(),
  /** HOME | AWAY — the side the position holds; determines event matching. */
  team: text('team').notNull(),
  template: text('template').notNull(), // 'GOAL_LOCK' | 'RED_CARD_REDUCE'
  fraction: integer('fraction').notNull(), // lock fraction in ppm (0, 1_000_000]
  createdAt: integer('created_at').notNull(),
  intentHash: text('intent_hash').notNull(),
});

/** Every rule firing, with the triggering TxLINE packet reference (FR-43). */
export const ruleFirings = sqliteTable('rule_firings', {
  id: text('id').primaryKey(),
  ruleId: text('rule_id').notNull(),
  packetId: text('packet_id').notNull(),
  eventType: text('event_type').notNull(),
  firedAt: integer('fired_at').notNull(),
  /** event sourceTs → signable prompt, ms (PRD ≤3s median). */
  latencyMs: integer('latency_ms').notNull(),
});

export type Db = ReturnType<typeof openDb>;

export function openDb(databaseUrl: string) {
  if (databaseUrl !== ':memory:') {
    mkdirSync(dirname(databaseUrl), { recursive: true });
  }
  const sqlite = new Database(databaseUrl);
  sqlite.pragma('journal_mode = WAL');
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS raw_packets (
      hash TEXT PRIMARY KEY,
      fixture_id TEXT NOT NULL,
      received_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS packets (
      packet_id TEXT PRIMARY KEY,
      source_ts INTEGER NOT NULL,
      fixture_id TEXT NOT NULL,
      market TEXT NOT NULL,
      raw_hash TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_packets_fixture ON packets (fixture_id, source_ts);
    CREATE TABLE IF NOT EXISTS rules (
      id TEXT PRIMARY KEY,
      wallet TEXT NOT NULL,
      position_ref TEXT NOT NULL,
      fixture_id TEXT NOT NULL,
      team TEXT NOT NULL,
      template TEXT NOT NULL,
      fraction INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      intent_hash TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rules_fixture ON rules (fixture_id);
    CREATE TABLE IF NOT EXISTS rule_firings (
      id TEXT PRIMARY KEY,
      rule_id TEXT NOT NULL,
      packet_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      fired_at INTEGER NOT NULL,
      latency_ms INTEGER NOT NULL
    );
  `);
  return drizzle(sqlite, { schema: { rawPackets, packets, rules, ruleFirings } });
}
