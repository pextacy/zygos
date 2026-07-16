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
  `);
  return drizzle(sqlite, { schema: { rawPackets, packets } });
}
