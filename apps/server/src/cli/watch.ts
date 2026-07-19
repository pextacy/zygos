/**
 * Headless consensus watcher (CLAUDE.md §4, DOCS.md §10 runbook):
 *   pnpm -F server cli:watch <fixtureId>
 *
 * Connects to the real TxLINE feed and prints one line per consensus update —
 * the Day-1 live-fire harness (PLAN.md T1.7) and the match-day ops probe.
 * Fails fast without credentials; there is no offline mode.
 */
import { marketKeyString, type ConsensusSnapshot } from '@zygos/core';
import { TxLineAdapter } from '@zygos/venue-adapters';
import { openDb } from '../db.js';
import { loadEnv } from '../env.js';
import { FeedService, type FeedLogger } from '../feed.js';

const fixtureId = process.argv[2];
if (!fixtureId) {
  console.error('usage: pnpm -F server cli:watch <fixtureId> | list [competitionId]');
  process.exit(2);
}

const env = loadEnv();
if (!env.TXLINE_API_TOKEN) {
  console.error('TXLINE_API_TOKEN not set. Run `pnpm -F server txline:activate` first (needs devnet SOL + unblocked network) — no offline mode exists.');
  process.exit(2);
}

const log: FeedLogger = {
  info: (o, m) => console.log(JSON.stringify({ level: 'info', ...o, msg: m })),
  warn: (o, m) => console.warn(JSON.stringify({ level: 'warn', ...o, msg: m })),
  error: (o, m) => console.error(JSON.stringify({ level: 'error', ...o, msg: m })),
};

const db = await openDb(env.DATABASE_URL);
const adapter = new TxLineAdapter({
  origin: env.TXLINE_ORIGIN,
  apiToken: env.TXLINE_API_TOKEN,
  onRawPacket: (raw) => feedService.auditRaw(raw),
  onParseError: (e) => console.warn(`[stream] ${e.fixtureId}: ${e.reason}`),
});
const feedService = new FeedService(adapter, db, log);

if (fixtureId === 'list') {
  await adapter.connect();
  const competitionId = process.argv[3] ? Number(process.argv[3]) : undefined;
  const fixtures = await adapter.listFixtures(competitionId !== undefined ? { competitionId } : undefined);
  for (const fx of fixtures) {
    console.log(`${fx.FixtureId}  ${new Date(fx.StartTime).toISOString()}  [${fx.CompetitionId}] ${fx.Competition}: ${fx.Participant1} vs ${fx.Participant2}`);
  }
  process.exit(0);
}

function fmt(snap: ConsensusSnapshot): string {
  const probs = Object.entries(snap.probs)
    .map(([k, v]) => `${k}=${((v ?? 0) * 100).toFixed(1)}%`)
    .join(' ');
  const flags = [snap.confidence === 'LOW_CONFIDENCE' ? 'LOW_CONF' : null, snap.excludedBookIds.length ? `excl:${snap.excludedBookIds.join(',')}` : null]
    .filter(Boolean)
    .join(' ');
  return `${new Date(snap.asOf).toISOString()} ${snap.fixtureId} ${marketKeyString(snap.market)} ${probs} books=${snap.bookCount} ${flags}`;
}

feedService.addListener({
  onConsensus: (snap) => console.log(fmt(snap)),
  onEvent: (e) => console.log(`*** EVENT ${e.type} team=${e.team ?? '-'} ${e.inferred ? '(inferred)' : ''} packet=${e.packetId}`),
});

await adapter.connect();
await feedService.subscribe([fixtureId]);
console.log(`watching ${fixtureId} via ${env.TXLINE_ORIGIN} — Ctrl-C to stop`);

setInterval(() => {
  const states = feedService.feedStates();
  const state = states[fixtureId];
  // PENDING (no odds yet — pre-match/idle) is benign; only DEGRADED/STALE are faults.
  if (state === 'PENDING') console.log(`[health] awaiting first odds for ${fixtureId} (feed connected, no ticks yet)`);
  else if (state && state !== 'LIVE') console.warn(`[health] feed ${state} for ${fixtureId}`);
}, 10_000);
