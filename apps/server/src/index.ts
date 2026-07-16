import Fastify from 'fastify';
import { marketKeyString } from '@zygos/core';
import { JupiterPredictAdapter, TxLineAdapter } from '@zygos/venue-adapters';
import { openDb } from './db.js';
import { loadEnv } from './env.js';
import { FeedService } from './feed.js';
import { ValuationService } from './valuation.js';
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
if (env.TXLINE_API_TOKEN) {
  const adapter = new TxLineAdapter({
    origin: env.TXLINE_ORIGIN,
    apiToken: env.TXLINE_API_TOKEN,
    onRawPacket: (raw) => feed?.auditRaw(raw),
    onParseError: (e) => app.log.warn({ fixtureId: e.fixtureId, reason: e.reason }, 'txline parse/stream issue'),
  });
  feed = new FeedService(adapter, db, app.log);
  await adapter.connect();
  app.log.info({ origin: env.TXLINE_ORIGIN }, 'txline feed connected');
} else {
  app.log.warn('TXLINE_API_TOKEN not set — feed disabled, no odds will be served. Run: pnpm -F server txline:activate');
}

/**
 * Venue adapter + valuation (T1.5/T1.6). Market bindings (TxLINE fixture ↔
 * Jupiter market) start empty and are populated by the fixture matcher during
 * the Day-1 liquidity gate; unmapped positions surface as UNMAPPED_OUTCOME.
 */
let valuation: ValuationService | null = null;
if (feed && env.JUPITER_API_KEY) {
  const venue = new JupiterPredictAdapter({ apiKey: env.JUPITER_API_KEY });
  valuation = new ValuationService(venue, feed, app.log);
  app.log.info({ venue: venue.venueId }, 'venue adapter configured');
} else if (feed) {
  app.log.warn('JUPITER_API_KEY not set — positions cannot be read or valued');
}

app.get('/healthz', async () => {
  return {
    status: feed ? 'ok' : 'feed-not-configured',
    feed: feed ? { ...feed.health(), states: feed.feedStates() } : { connected: false, lastTickAgeMs: {} },
    rpc: { configured: env.RPC_URL !== undefined, cluster: env.CLUSTER },
    txline: { configured: env.TXLINE_API_TOKEN !== undefined, origin: env.TXLINE_ORIGIN },
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

app.get<{ Params: { wallet: string } }>('/positions/:wallet', async (req, reply) => {
  if (!feed) return reply.code(503).send({ error: 'feed not configured' });
  if (!valuation) return reply.code(503).send({ error: 'no venue adapter configured — set JUPITER_API_KEY' });
  const wallet = req.params.wallet;
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) {
    return reply.code(400).send({ error: 'not a base58 Solana address' });
  }
  await valuation.refreshPositions(wallet);
  const now = Date.now();
  return { wallet, positions: valuation.valueWallet(wallet, feed.snapshots(now), now) };
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
  attachWs(app.server, feed, valuation, app.log);
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
