import Fastify from 'fastify';
import { Connection } from '@solana/web3.js';
import { marketKeyString, SimulationFailedError } from '@zygos/core';
import { JupiterPredictAdapter, TxLineAdapter } from '@zygos/venue-adapters';
import { verifyWalletAuth, type WalletAuth } from './auth.js';
import { openDb } from './db.js';
import { loadEnv } from './env.js';
import { FeedService } from './feed.js';
import { HedgeOrchestrator, PreviewError } from './hedge.js';
import { RuleEngine, type RuleTemplate } from './rules.js';
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
let hedge: HedgeOrchestrator | null = null;
let ruleEngine: RuleEngine | null = null;
const connection = env.RPC_URL ? new Connection(env.RPC_URL, 'confirmed') : null;
if (!connection) {
  app.log.warn('RPC_URL not set — transactions cannot be simulated, so no signature prompts will be offered');
}
if (feed && env.JUPITER_API_KEY) {
  const venue = new JupiterPredictAdapter({ apiKey: env.JUPITER_API_KEY });
  valuation = new ValuationService(venue, feed, app.log);
  hedge = new HedgeOrchestrator(valuation, feed, connection, app.log);
  ruleEngine = new RuleEngine(db, valuation, hedge, feed, app.log);
  app.log.info({ venue: venue.venueId }, 'venue adapter + hedge + rules configured');
} else if (feed) {
  app.log.warn('JUPITER_API_KEY not set — positions cannot be read or valued');
}

function mapHedgeError(err: unknown, reply: { code: (n: number) => { send: (b: object) => unknown } }): unknown {
  if (err instanceof PreviewError) return reply.code(err.status).send({ error: err.message });
  if (err instanceof SimulationFailedError) return reply.code(409).send({ error: `simulation failed — no signature prompt allowed: ${err.message}` });
  throw err;
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

interface HedgePreviewBody {
  wallet: string;
  positionRef: string;
  fraction: number;
}
app.post<{ Body: HedgePreviewBody }>('/hedge/preview', async (req, reply) => {
  if (!hedge) return reply.code(503).send({ error: 'hedge engine not configured (feed + venue required)' });
  const { wallet, positionRef, fraction } = req.body;
  if (typeof fraction !== 'number' || !(fraction > 0 && fraction <= 1)) {
    return reply.code(400).send({ error: 'fraction must be in (0,1]' });
  }
  try {
    return await hedge.preview(wallet, positionRef, fraction);
  } catch (err) {
    return mapHedgeError(err, reply);
  }
});

interface HedgeConfirmBody {
  wallet: string;
  positionRef: string;
  fraction: number;
  signature: string;
  packetIds: string[];
  auth: WalletAuth;
}
app.post<{ Body: HedgeConfirmBody }>('/hedge/confirm', async (req, reply) => {
  if (!hedge) return reply.code(503).send({ error: 'hedge engine not configured' });
  const authResult = verifyWalletAuth('hedge-confirm', req.body.auth);
  if (!authResult.ok) return reply.code(401).send({ error: authResult.reason });
  if (req.body.auth.wallet !== req.body.wallet) return reply.code(401).send({ error: 'auth wallet mismatch' });
  try {
    return await hedge.confirm(req.body.wallet, req.body.positionRef, req.body.fraction, req.body.packetIds ?? []);
  } catch (err) {
    return mapHedgeError(err, reply);
  }
});

interface RuleCreateBody {
  wallet: string;
  positionRef: string;
  template: RuleTemplate;
  team: 'HOME' | 'AWAY';
  fraction: number;
  auth: WalletAuth;
}
app.post<{ Body: RuleCreateBody }>('/rules', async (req, reply) => {
  if (!ruleEngine) return reply.code(503).send({ error: 'rule engine not configured' });
  const authResult = verifyWalletAuth('rules-create', req.body.auth);
  if (!authResult.ok) return reply.code(401).send({ error: authResult.reason });
  if (req.body.auth.wallet !== req.body.wallet) return reply.code(401).send({ error: 'auth wallet mismatch' });
  if (req.body.template !== 'GOAL_LOCK' && req.body.template !== 'RED_CARD_REDUCE') {
    return reply.code(400).send({ error: 'unknown template' });
  }
  try {
    const rule = await ruleEngine.create(req.body);
    // The intent hash is returned for the client to commit on-chain via a memo it signs (FR-41).
    return { rule, memo: `zygos:rule:${rule.intentHash}` };
  } catch (err) {
    return mapHedgeError(err, reply);
  }
});

app.get<{ Params: { wallet: string } }>('/rules/:wallet', async (req, reply) => {
  if (!ruleEngine) return reply.code(503).send({ error: 'rule engine not configured' });
  return { rules: ruleEngine.list(req.params.wallet) };
});

app.delete<{ Params: { id: string }; Body: { auth: WalletAuth } }>('/rules/:id', async (req, reply) => {
  if (!ruleEngine) return reply.code(503).send({ error: 'rule engine not configured' });
  const authResult = verifyWalletAuth('rules-delete', req.body.auth);
  if (!authResult.ok) return reply.code(401).send({ error: authResult.reason });
  const removed = ruleEngine.remove(req.params.id, req.body.auth.wallet);
  return removed ? { removed: true } : reply.code(404).send({ error: 'rule not found for this wallet' });
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
  attachWs(app.server, feed, valuation, ruleEngine, app.log);
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
