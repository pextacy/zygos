import Fastify from 'fastify';
import cors from '@fastify/cors';
import { eq } from 'drizzle-orm';
import { Connection, PublicKey } from '@solana/web3.js';
import { marketKeyString, SimulationFailedError } from '@zygos/core';
import { JupiterPredictAdapter, TxLineAdapter } from '@zygos/venue-adapters';
import { verifyWalletAuth, type WalletAuth } from './auth.js';
import { parseDelegationKey } from './crypto.js';
import { BindingRegistry, BindingValidationError } from './bindings.js';
import { buildUnsignedMemoTx, ruleCommitment } from './chain/memo.js';
import { TxOracleValidator } from './chain/txoracle.js';
import { dbKind, openDb, packets } from './db.js';
import { loadEnv } from './env.js';
import { FeedService, SubscriptionLimitError } from './feed.js';
import { HedgeOrchestrator, PreviewError } from './hedge.js';
import { LockLedger } from './ledger.js';
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

// Browser clients live on another origin in production (Vercel web → Render API).
// The allowlist is normalized (trailing slashes stripped, lowercased) and, for
// each configured host, all its Vercel preview/deployment subdomains are
// accepted too — otherwise a per-deploy URL like
// zygos-abc123-team.vercel.app is silently CORS-blocked while the canonical
// alias works, surfacing in the browser only as "Failed to fetch".
const normalizeOrigin = (o: string): string => o.trim().replace(/\/+$/, '').toLowerCase();
/** Vercel project slug from a *.vercel.app host (`zygos-abc123-team` → `zygos`), else null. */
const vercelProjectOf = (host: string): string | null =>
  host.endsWith('.vercel.app') ? (host.replace(/\.vercel\.app$/, '').split('-')[0] ?? null) : null;
const allowedOrigins = env.WEB_ORIGIN ? env.WEB_ORIGIN.split(',').map(normalizeOrigin).filter(Boolean) : null;
const vercelProjectHosts = new Set(
  (allowedOrigins ?? [])
    .map((o) => {
      try {
        return vercelProjectOf(new URL(o).hostname);
      } catch {
        return null;
      }
    })
    .filter((h): h is string => h !== null),
);
await app.register(cors, {
  origin: (origin, cb) => {
    // Non-browser callers (curl, server-to-server) send no Origin — always allow.
    if (!origin || allowedOrigins === null) return cb(null, true);
    const norm = normalizeOrigin(origin);
    if (allowedOrigins.includes(norm)) return cb(null, true);
    try {
      const project = vercelProjectOf(new URL(norm).hostname);
      if (project !== null && vercelProjectHosts.has(project)) {
        return cb(null, true); // same Vercel project, different deploy/preview URL
      }
    } catch {
      /* malformed origin: fall through to reject */
    }
    return cb(null, false);
  },
});

const db = await openDb(env.DATABASE_URL);
if (process.env.NODE_ENV === 'production' && dbKind(env.DATABASE_URL) === 'pglite-dir') {
  // Deploying without a DATABASE_URL secret lands on the Dockerfile's
  // /data/pglite fallback — ephemeral unless a volume is mounted at /data.
  // Silent loss here would erase rules, pre-signed delegations, the lock
  // ledger and market bindings on every redeploy (fly.toml has the volume
  // instructions).
  app.log.warn(
    { databaseUrl: env.DATABASE_URL },
    'PRODUCTION BOOT ON EMBEDDED PGlite: set the DATABASE_URL secret (Neon) or mount a persistent volume at this path — otherwise ALL state (rules, delegations, lock ledger, bindings) is lost on redeploy/restart',
  );
}
/** Lock ledger is DB-only: history stays queryable even when feed/venue are down. */
const ledger = new LockLedger(db);
/** Market bindings are DB-only too: editable before the venue key even exists. */
const bindingRegistry = await BindingRegistry.open(db);
const adminWallets = env.ADMIN_WALLETS?.split(',').map((w) => w.trim()) ?? null;

/**
 * The feed only exists with real credentials (CLAUDE.md §2.1): without
 * TXLINE_API_KEY the server boots for ops/CI but serves no odds, and /healthz
 * says so explicitly. There is no simulated fallback.
 */
let feed: FeedService | null = null;
let txlineAdapter: TxLineAdapter | null = null;
if (env.TXLINE_API_TOKEN) {
  const adapter = new TxLineAdapter({
    origin: env.TXLINE_ORIGIN,
    apiToken: env.TXLINE_API_TOKEN,
    onRawPacket: (raw) => feed?.auditRaw(raw),
    onParseError: (e) => app.log.warn({ fixtureId: e.fixtureId, reason: e.reason }, 'txline parse/stream issue'),
  });
  feed = new FeedService(adapter, db, app.log);
  txlineAdapter = adapter;
  await adapter.connect();
  app.log.info({ origin: env.TXLINE_ORIGIN }, 'txline feed connected');
} else {
  app.log.warn('TXLINE_API_TOKEN not set — feed disabled, no odds will be served. Run: pnpm -F server txline:activate');
}

/**
 * Venue adapter + valuation (T1.5/T1.6). Market bindings (TxLINE fixture ↔
 * Jupiter market) come from the persistent BindingRegistry (managed via
 * /bindings); positions on still-unbound markets surface as UNMAPPED_OUTCOME.
 */
let valuation: ValuationService | null = null;
let hedge: HedgeOrchestrator | null = null;
let ruleEngine: RuleEngine | null = null;
const connection = env.RPC_URL ? new Connection(env.RPC_URL, 'confirmed') : null;
if (!connection) {
  app.log.warn('RPC_URL not set — transactions cannot be simulated, so no signature prompts will be offered');
}

/** On-chain verification of displayed odds against TxODDS's anchored Merkle roots (txoracle validate_odds). */
let oracleValidator: TxOracleValidator | null = null;
if (connection) {
  try {
    oracleValidator = new TxOracleValidator(connection, env.CLUSTER);
    app.log.info({ cluster: env.CLUSTER }, 'txoracle validator ready');
  } catch (err) {
    app.log.error({ err: err instanceof Error ? err.message : String(err) }, 'txoracle validator init failed');
  }
}
if (feed && env.JUPITER_API_KEY) {
  // The registry's live map is shared by reference: binding upserts apply
  // to position mapping and quote routing immediately, no restart.
  const venue = new JupiterPredictAdapter({ apiKey: env.JUPITER_API_KEY, bindings: bindingRegistry.map });
  valuation = new ValuationService(venue, feed, app.log);
  hedge = new HedgeOrchestrator(valuation, feed, connection, app.log, ledger);
  const delegationKey = parseDelegationKey(env.DELEGATION_ENC_KEY);
  if (!delegationKey) {
    app.log.warn('DELEGATION_ENC_KEY not set — pre-signed delegation txs are stored in PLAINTEXT (set it before production)');
  }
  ruleEngine = new RuleEngine(db, valuation, hedge, feed, app.log, connection, ledger, delegationKey);
  app.log.info({ venue: venue.venueId }, 'venue adapter + hedge + rules configured');
} else if (feed) {
  app.log.warn('JUPITER_API_KEY not set — positions cannot be read or valued');
}

function mapHedgeError(err: unknown, reply: { code: (n: number) => { send: (b: object) => unknown } }): unknown {
  if (err instanceof PreviewError) return reply.code(err.status).send({ error: err.message });
  if (err instanceof SimulationFailedError) return reply.code(409).send({ error: `simulation failed — no signature prompt allowed: ${err.message}` });
  throw err;
}

/** Handlers destructure req.body directly; a request with no JSON body must be a 400, not a TypeError-driven 500. */
function hasBody(req: { body: unknown }): boolean {
  return typeof req.body === 'object' && req.body !== null;
}

app.get('/healthz', async () => {
  return {
    status: feed ? 'ok' : 'feed-not-configured',
    feed: feed ? { ...feed.health(), states: feed.feedStates() } : { connected: false, lastTickAgeMs: {} },
    rpc: { configured: env.RPC_URL !== undefined, cluster: env.CLUSTER },
    txline: { configured: env.TXLINE_API_TOKEN !== undefined, origin: env.TXLINE_ORIGIN },
    db: { configured: true },
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

const BASE58_WALLET = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

app.get<{ Params: { wallet: string } }>('/positions/:wallet', async (req, reply) => {
  if (!feed) return reply.code(503).send({ error: 'feed not configured' });
  if (!valuation) return reply.code(503).send({ error: 'no venue adapter configured — set JUPITER_API_KEY' });
  const wallet = req.params.wallet;
  if (!BASE58_WALLET.test(wallet)) {
    return reply.code(400).send({ error: 'not a base58 Solana address' });
  }
  await valuation.refreshPositions(wallet);
  const now = Date.now();
  return { wallet, positions: valuation.valueWallet(wallet, feed.snapshots(now), now) };
});

/**
 * Cryptographic provenance check (FR-13 made verifiable): given an audited
 * packet id, fetch its Merkle proof from TxLINE and validate it against the
 * on-chain root via read-only simulation of txoracle `validate_odds`.
 */
app.post<{ Body: { packetId: string } }>('/verify/odds', async (req, reply) => {
  if (!txlineAdapter) return reply.code(503).send({ error: 'feed not configured' });
  if (!oracleValidator) return reply.code(503).send({ error: 'RPC not configured — on-chain verification unavailable' });
  const packetId = hasBody(req) ? req.body.packetId : undefined;
  if (!packetId || typeof packetId !== 'string') return reply.code(400).send({ error: 'packetId required' });

  const row = (await db.select().from(packets).where(eq(packets.packetId, packetId)))[0];
  if (!row) return reply.code(404).send({ error: 'packet not in the audit log' });

  try {
    const proof = await txlineAdapter.fetchOddsValidation(row.fixtureId, row.sourceTs);
    const result = await oracleValidator.validateOdds(proof);
    app.log.info({ packetId, verified: result.verified, rootsAccount: result.rootsAccount }, 'on-chain odds verification');
    return result;
  } catch (err) {
    return reply.code(502).send({ error: `verification failed: ${err instanceof Error ? err.message : String(err)}` });
  }
});

interface HedgePreviewBody {
  wallet: string;
  positionRef: string;
  fraction: number;
}
app.post<{ Body: HedgePreviewBody }>('/hedge/preview', async (req, reply) => {
  if (!hedge) return reply.code(503).send({ error: 'hedge engine not configured (feed + venue required)' });
  if (!hasBody(req)) return reply.code(400).send({ error: 'JSON body required' });
  const { wallet, positionRef, fraction } = req.body;
  if (typeof wallet !== 'string' || typeof positionRef !== 'string') {
    return reply.code(400).send({ error: 'wallet and positionRef must be strings' });
  }
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
  /** Handle from /hedge/preview — lets the ledger record the server-built plan the user signed against. */
  previewId?: string;
  /** Present when the lock was signed from a RULE_FIRED prompt. */
  ruleId?: string;
  auth: WalletAuth;
}
app.post<{ Body: HedgeConfirmBody }>('/hedge/confirm', async (req, reply) => {
  if (!hedge) return reply.code(503).send({ error: 'hedge engine not configured' });
  if (!hasBody(req)) return reply.code(400).send({ error: 'JSON body required' });
  const authResult = verifyWalletAuth('hedge-confirm', req.body.auth);
  if (!authResult.ok) return reply.code(401).send({ error: authResult.reason });
  if (req.body.auth.wallet !== req.body.wallet) return reply.code(401).send({ error: 'auth wallet mismatch' });
  if (typeof req.body.positionRef !== 'string') return reply.code(400).send({ error: 'positionRef must be a string' });
  if (typeof req.body.fraction !== 'number' || !(req.body.fraction > 0 && req.body.fraction <= 1)) {
    return reply.code(400).send({ error: 'fraction must be in (0,1]' });
  }
  // packetIds/signature land in the lock ledger — bound them so a client can't
  // stuff arbitrary blobs into the durable provenance record.
  const packetIds = req.body.packetIds ?? [];
  if (!Array.isArray(packetIds) || packetIds.length > 64 || packetIds.some((p) => typeof p !== 'string' || p.length > 128)) {
    return reply.code(400).send({ error: 'packetIds must be an array of ≤64 short strings' });
  }
  if (req.body.signature !== undefined && (typeof req.body.signature !== 'string' || req.body.signature.length > 128)) {
    return reply.code(400).send({ error: 'signature must be a short string' });
  }
  try {
    return await hedge.confirm(req.body.wallet, req.body.positionRef, req.body.fraction, packetIds, {
      ...(req.body.signature !== undefined ? { signature: req.body.signature } : {}),
      ...(req.body.previewId !== undefined ? { previewId: req.body.previewId } : {}),
      ...(req.body.ruleId !== undefined ? { ruleId: req.body.ruleId } : {}),
    });
  } catch (err) {
    return mapHedgeError(err, reply);
  }
});

/**
 * Lock ledger (extends FR-33): per-wallet history of verified executed locks
 * with the edge each captured vs TxLINE fair value, plus cumulative stats.
 */
app.get<{ Params: { wallet: string } }>('/locks/:wallet', async (req, reply) => {
  const wallet = req.params.wallet;
  if (!BASE58_WALLET.test(wallet)) {
    return reply.code(400).send({ error: 'not a base58 Solana address' });
  }
  const lockList = await ledger.list(wallet);
  return { wallet, locks: lockList, stats: await ledger.stats(wallet, lockList) };
});

/**
 * Attach the memo-commitment signature to a recorded lock (FR-33): completes
 * the audit chain lock-tx → memo-tx once the user has signed the memo.
 */
app.patch<{ Params: { id: string }; Body: { memoSig: string; auth: WalletAuth } }>('/locks/:id/memo', async (req, reply) => {
  if (!hasBody(req)) return reply.code(400).send({ error: 'JSON body required' });
  const authResult = verifyWalletAuth('locks-memo', req.body.auth);
  if (!authResult.ok) return reply.code(401).send({ error: authResult.reason });
  if (typeof req.body.memoSig !== 'string' || req.body.memoSig.length === 0 || req.body.memoSig.length > 128) {
    return reply.code(400).send({ error: 'memoSig must be a short string' });
  }
  const attached = await ledger.attachMemoSig(req.params.id, req.body.auth.wallet, req.body.memoSig);
  return attached ? { attached: true } : reply.code(404).send({ error: 'lock not found for this wallet' });
});

/**
 * Market binding registry (closes README known-limitation #1): persistent
 * TxLINE fixture ↔ venue market mapping, editable at the liquidity gate
 * without a redeploy. Reads are public; writes need a wallet signature and,
 * when ADMIN_WALLETS is set, membership in it.
 */
function bindingAdminCheck(action: string, auth: WalletAuth): { ok: true } | { ok: false; status: number; error: string } {
  const authResult = verifyWalletAuth(action, auth);
  if (!authResult.ok) return { ok: false, status: 401, error: authResult.reason };
  if (adminWallets && !adminWallets.includes(auth.wallet)) {
    return { ok: false, status: 403, error: 'wallet not in ADMIN_WALLETS — binding registry is admin-only on this deployment' };
  }
  return { ok: true };
}

app.get('/bindings', async () => {
  return { bindings: await bindingRegistry.list(), adminRestricted: adminWallets !== null };
});

/** Everything the binding form needs: venue marketIds seen but unbound, plus the fixtures/markets the feed is tracking. */
app.get('/bindings/candidates', async () => {
  const now = Date.now();
  const markets = feed
    ? feed.snapshots(now).map((s) => ({ fixtureId: s.fixtureId, market: marketKeyString(s.market) }))
    : [];
  return {
    unmappedMarketIds: valuation?.unmappedMarketIds() ?? [],
    fixtures: feed?.subscribedFixtures() ?? [],
    markets,
  };
});

interface BindingUpsertBody {
  fixtureId: string;
  market: string;
  yesOutcome: string;
  note?: string;
  auth: WalletAuth;
}
app.put<{ Params: { marketId: string }; Body: BindingUpsertBody }>('/bindings/:marketId', async (req, reply) => {
  if (!hasBody(req)) return reply.code(400).send({ error: 'JSON body required' });
  const check = bindingAdminCheck('bindings-upsert', req.body.auth);
  if (!check.ok) return reply.code(check.status).send({ error: check.error });
  try {
    const binding = await bindingRegistry.upsert({
      marketId: req.params.marketId,
      fixtureId: req.body.fixtureId ?? '',
      market: req.body.market ?? '',
      yesOutcome: req.body.yesOutcome ?? '',
      ...(req.body.note !== undefined ? { note: req.body.note } : {}),
      createdBy: req.body.auth.wallet,
    });
    // Re-map cached positions right away so UNMAPPED_OUTCOME rows resolve.
    await valuation?.refreshAllWallets();
    app.log.info({ marketId: binding.marketId, fixtureId: binding.fixtureId, market: binding.market }, 'market binding upserted');
    return { binding };
  } catch (err) {
    if (err instanceof BindingValidationError) return reply.code(400).send({ error: err.message });
    throw err;
  }
});

app.delete<{ Params: { marketId: string }; Body: { auth: WalletAuth } }>('/bindings/:marketId', async (req, reply) => {
  if (!hasBody(req)) return reply.code(400).send({ error: 'JSON body required' });
  const check = bindingAdminCheck('bindings-delete', req.body.auth);
  if (!check.ok) return reply.code(check.status).send({ error: check.error });
  const removed = await bindingRegistry.remove(req.params.marketId);
  if (!removed) return reply.code(404).send({ error: 'no binding for that marketId' });
  await valuation?.refreshAllWallets();
  app.log.info({ marketId: req.params.marketId }, 'market binding removed');
  return { removed: true };
});

interface RuleCreateBody {
  wallet: string;
  positionRef: string;
  template: RuleTemplate;
  team: 'HOME' | 'AWAY';
  fraction: number;
  /** PRICE_LOCK only: consensus-probability threshold in (0,1). */
  threshold?: number;
  /** PRICE_LOCK only: fire when consensus crosses ABOVE or BELOW the threshold. */
  direction?: 'ABOVE' | 'BELOW';
  auth: WalletAuth;
}
app.post<{ Body: RuleCreateBody }>('/rules', async (req, reply) => {
  if (!ruleEngine) return reply.code(503).send({ error: 'rule engine not configured' });
  if (!hasBody(req)) return reply.code(400).send({ error: 'JSON body required' });
  const authResult = verifyWalletAuth('rules-create', req.body.auth);
  if (!authResult.ok) return reply.code(401).send({ error: authResult.reason });
  if (req.body.auth.wallet !== req.body.wallet) return reply.code(401).send({ error: 'auth wallet mismatch' });
  if (req.body.template !== 'GOAL_LOCK' && req.body.template !== 'RED_CARD_REDUCE' && req.body.template !== 'PRICE_LOCK') {
    return reply.code(400).send({ error: 'unknown template' });
  }
  if (req.body.team !== 'HOME' && req.body.team !== 'AWAY') {
    return reply.code(400).send({ error: 'team must be HOME or AWAY' });
  }
  if (typeof req.body.positionRef !== 'string') return reply.code(400).send({ error: 'positionRef must be a string' });
  try {
    const rule = await ruleEngine.create(req.body);
    // Intent pre-commitment (FR-41): server builds the unsigned memo tx; only the user's wallet signs it.
    const memo = ruleCommitment(rule.intentHash);
    let memoTxBase64: string | null = null;
    if (connection) {
      try {
        memoTxBase64 = (await buildUnsignedMemoTx(connection, new PublicKey(req.body.wallet), memo)).txBase64;
      } catch (err) {
        app.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'rule memo tx build failed — rule armed without on-chain commitment');
      }
    }
    return { rule, memo, memoTxBase64 };
  } catch (err) {
    return mapHedgeError(err, reply);
  }
});

app.get<{ Params: { wallet: string } }>('/rules/:wallet', async (req, reply) => {
  if (!ruleEngine) return reply.code(503).send({ error: 'rule engine not configured' });
  const engine = ruleEngine;
  const list = await engine.list(req.params.wallet);
  const statuses = await engine.delegationStatuses(list.map((r) => r.id));
  return { rules: list.map((rule) => ({ ...rule, delegation: statuses.get(rule.id) ?? null })) };
});

/**
 * Delegated execution (Phase 4). POST without noncePubkey → nonce setup tx;
 * with noncePubkey → durable-nonce lock tx to pre-sign. PUT stores the signed tx.
 */
app.post<{ Params: { id: string }; Body: { auth: WalletAuth; noncePubkey?: string } }>('/rules/:id/delegate', async (req, reply) => {
  if (!ruleEngine) return reply.code(503).send({ error: 'rule engine not configured' });
  if (!hasBody(req)) return reply.code(400).send({ error: 'JSON body required' });
  const authResult = verifyWalletAuth('rules-delegate', req.body.auth);
  if (!authResult.ok) return reply.code(401).send({ error: authResult.reason });
  try {
    return await ruleEngine.prepareDelegation(req.params.id, req.body.auth.wallet, req.body.noncePubkey);
  } catch (err) {
    return mapHedgeError(err, reply);
  }
});

app.put<{ Params: { id: string }; Body: { auth: WalletAuth; noncePubkey: string; signedTxBase64: string } }>('/rules/:id/delegate', async (req, reply) => {
  if (!ruleEngine) return reply.code(503).send({ error: 'rule engine not configured' });
  if (!hasBody(req)) return reply.code(400).send({ error: 'JSON body required' });
  const authResult = verifyWalletAuth('rules-delegate-store', req.body.auth);
  if (!authResult.ok) return reply.code(401).send({ error: authResult.reason });
  if (typeof req.body.noncePubkey !== 'string' || !req.body.noncePubkey || typeof req.body.signedTxBase64 !== 'string' || !req.body.signedTxBase64) {
    return reply.code(400).send({ error: 'noncePubkey and signedTxBase64 required' });
  }
  try {
    await ruleEngine.storeDelegation(req.params.id, req.body.auth.wallet, req.body.noncePubkey, req.body.signedTxBase64);
    return { delegated: true, status: await ruleEngine.delegationStatus(req.params.id) };
  } catch (err) {
    return mapHedgeError(err, reply);
  }
});

/**
 * Revoke a delegation (security-review req 1): erases the stored pre-signed tx
 * server-side immediately and returns an unsigned nonce-advance tx — once the
 * wallet signs and lands it, leaked copies of the pre-signed tx are void too.
 */
app.post<{ Params: { id: string }; Body: { auth: WalletAuth } }>('/rules/:id/revoke', async (req, reply) => {
  if (!ruleEngine) return reply.code(503).send({ error: 'rule engine not configured' });
  if (!hasBody(req)) return reply.code(400).send({ error: 'JSON body required' });
  const authResult = verifyWalletAuth('rules-revoke', req.body.auth);
  if (!authResult.ok) return reply.code(401).send({ error: authResult.reason });
  try {
    return await ruleEngine.revokeDelegation(req.params.id, req.body.auth.wallet);
  } catch (err) {
    return mapHedgeError(err, reply);
  }
});

app.delete<{ Params: { id: string }; Body: { auth: WalletAuth } }>('/rules/:id', async (req, reply) => {
  if (!ruleEngine) return reply.code(503).send({ error: 'rule engine not configured' });
  if (!hasBody(req)) return reply.code(400).send({ error: 'JSON body required' });
  const authResult = verifyWalletAuth('rules-delete', req.body.auth);
  if (!authResult.ok) return reply.code(401).send({ error: authResult.reason });
  const removed = await ruleEngine.remove(req.params.id, req.body.auth.wallet);
  return removed ? { removed: true } : reply.code(404).send({ error: 'rule not found for this wallet' });
});

const subscribeBody = { type: 'object', required: ['fixtureIds'], properties: { fixtureIds: { type: 'array', items: { type: 'string' }, maxItems: 50 } } } as const;
app.post<{ Body: { fixtureIds: string[] } }>('/fixtures/subscribe', { schema: { body: subscribeBody } }, async (req, reply) => {
  if (!feed) {
    return reply.code(503).send({ error: 'feed not configured' });
  }
  try {
    await feed.subscribe(req.body.fixtureIds);
  } catch (err) {
    if (err instanceof SubscriptionLimitError) return reply.code(429).send({ error: err.message });
    throw err;
  }
  return { subscribed: feed.subscribedFixtures() };
});

await app.ready();
let wss: ReturnType<typeof attachWs> | null = null;
if (feed) {
  wss = attachWs(app.server, feed, valuation, ruleEngine, app.log);
}

/**
 * Graceful shutdown (Fly/Docker send SIGTERM on deploy/restart): stop taking
 * connections, drop WS clients, close the TxLINE stream, then exit. A 10s
 * deadline guarantees the process never hangs a deploy; Postgres (Neon) is
 * durable across hard exits, this just makes the common path clean.
 */
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'graceful shutdown started');
  setTimeout(() => process.exit(1), 10_000).unref();
  try {
    if (wss) {
      for (const client of wss.clients) client.terminate();
      wss.close();
    }
    if (txlineAdapter) await txlineAdapter.disconnect();
    // Let in-flight ticks finish their audit inserts — a tick consumed without
    // its provenance row is exactly what the serialized chain exists to prevent.
    if (feed) await feed.flushTicks();
    await app.close();
    app.log.info('shutdown complete');
    process.exit(0);
  } catch (err) {
    app.log.error({ err: err instanceof Error ? err.message : String(err) }, 'shutdown error');
    process.exit(1);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

app
  .listen({ port: env.PORT, host: env.HOST })
  .then(() => {
    app.log.info({ port: env.PORT, cluster: env.CLUSTER, feed: feed !== null }, 'zygos server up');
  })
  .catch((err) => {
    app.log.error(err, 'failed to start');
    process.exit(1);
  });
