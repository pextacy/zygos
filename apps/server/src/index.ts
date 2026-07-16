import Fastify from 'fastify';
import { marketKeyString } from '@zygos/core';
import { TxLineAdapter } from '@zygos/venue-adapters';
import { openDb } from './db.js';
import { loadEnv } from './env.js';
import { FeedService } from './feed.js';
import { attachWs } from './ws.js';

const env = loadEnv();

const app = Fastify({
  logger: {
    level: 'info',
    redact: ['req.headers.authorization'],
  },
});

const db = openDb(env.DATABASE_URL);

/**
 * The feed only exists with real credentials (CLAUDE.md §2.1): without
 * TXLINE_API_KEY the server boots for ops/CI but serves no odds, and /healthz
 * says so explicitly. There is no simulated fallback.
 */
let feed: FeedService | null = null;
if (env.TXLINE_API_KEY && env.TXLINE_BASE_URL) {
  const adapter = new TxLineAdapter({
    apiKey: env.TXLINE_API_KEY,
    baseUrl: env.TXLINE_BASE_URL,
    onRawPacket: (raw) => feed?.auditRaw(raw),
    onParseError: (e) => app.log.warn({ fixtureId: e.fixtureId, reason: e.reason }, 'txline parse/poll issue'),
  });
  feed = new FeedService(adapter, db, app.log);
  await adapter.connect();
  app.log.info({ baseUrl: env.TXLINE_BASE_URL }, 'txline feed connected');
} else {
  app.log.warn('TXLINE_API_KEY / TXLINE_BASE_URL not set — feed disabled, no odds will be served');
}

app.get('/healthz', async () => {
  return {
    status: feed ? 'ok' : 'feed-not-configured',
    feed: feed ? { ...feed.health(), states: feed.feedStates() } : { connected: false, lastTickAgeMs: {} },
    rpc: { configured: env.RPC_URL !== undefined, cluster: env.CLUSTER },
    txline: { configured: env.TXLINE_API_KEY !== undefined },
    db: { configured: true, url: env.DATABASE_URL },
  };
});

app.get('/fixtures', async (_req, reply) => {
  if (!feed) {
    return reply.code(503).send({ error: 'feed not configured — set TXLINE_API_KEY and TXLINE_BASE_URL' });
  }
  const now = Date.now();
  const states = feed.feedStates();
  return {
    fixtures: feed.subscribedFixtures().map((fixtureId) => ({
      fixtureId,
      state: states[fixtureId] ?? 'STALE',
      markets: feed
        .snapshots(now)
        .filter((s) => s.fixtureId === fixtureId)
        .map((s) => ({
          market: marketKeyString(s.market),
          probs: s.probs,
          bookCount: s.bookCount,
          confidence: s.confidence,
          packetIds: s.packetIds,
          asOf: s.asOf,
        })),
    })),
  };
});

const subscribeBody = { type: 'object', required: ['fixtureIds'], properties: { fixtureIds: { type: 'array', items: { type: 'string' }, maxItems: 50 } } } as const;
app.post<{ Body: { fixtureIds: string[] } }>('/fixtures/subscribe', { schema: { body: subscribeBody } }, async (req, reply) => {
  if (!feed) {
    return reply.code(503).send({ error: 'feed not configured' });
  }
  await feed.subscribe(req.body.fixtureIds);
  return { subscribed: feed.subscribedFixtures() };
});

await app.ready();
if (feed) {
  attachWs(app.server, feed, app.log);
}

app
  .listen({ port: env.PORT, host: env.HOST })
  .then(() => {
    app.log.info({ port: env.PORT, cluster: env.CLUSTER, feed: feed !== null }, 'zygos server up');
  })
  .catch((err) => {
    app.log.error(err, 'failed to start');
    process.exit(1);
  });
