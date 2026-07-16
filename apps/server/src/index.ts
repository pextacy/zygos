import Fastify from 'fastify';
import { loadEnv } from './env.js';

const env = loadEnv();

const app = Fastify({
  logger: {
    level: 'info',
    redact: ['req.headers.authorization'],
  },
});

/**
 * Health surface (DOCS.md §8, §10). Reports actual state: at scaffold stage
 * nothing is connected yet and this endpoint says so — no simulated health.
 * Feed, RPC, and DB sections are wired up on Day 1 (PLAN.md T1.1–T1.3).
 */
app.get('/healthz', async () => {
  return {
    status: 'scaffold',
    feed: { connected: false, lastTickAgeMs: {} },
    rpc: { configured: env.RPC_URL !== undefined, cluster: env.CLUSTER },
    txline: { configured: env.TXLINE_API_KEY !== undefined },
    db: { configured: false },
  };
});

app
  .listen({ port: env.PORT, host: env.HOST })
  .then(() => {
    app.log.info({ port: env.PORT, cluster: env.CLUSTER }, 'zygos server up');
  })
  .catch((err) => {
    app.log.error(err, 'failed to start');
    process.exit(1);
  });
