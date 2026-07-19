import { z } from 'zod';

/**
 * Server environment (CLAUDE.md §9). TxLINE credentials exist only here —
 * never imported into apps/web, never logged (CLAUDE.md §2.5).
 *
 * TXLINE_API_TOKEN and RPC_URL are optional so the server boots for CI/smoke
 * without them; the feed and venue services fail fast when they are absent.
 */
const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default('0.0.0.0'),
  /** API origin: https://txline-dev.txodds.com (devnet) or https://txline.txodds.com (mainnet). */
  TXLINE_ORIGIN: z.string().url().default('https://txline-dev.txodds.com'),
  /** Activated long-lived API token (X-Api-Token) from scripts/txline-activate.ts. */
  TXLINE_API_TOKEN: z.string().min(1).optional(),
  JUPITER_API_KEY: z.string().min(1).optional(),
  RPC_URL: z.string().url().optional(),
  CLUSTER: z.enum(['mainnet-beta', 'devnet']).default('devnet'),
  /**
   * postgres://… → managed Postgres (Neon in production);
   * a directory path → embedded PGlite (zero-setup local dev);
   * memory:// → in-memory PGlite (tests/CI).
   */
  DATABASE_URL: z.string().default('./data/pglite'),
  /**
   * Comma-separated browser origins allowed by CORS (e.g. the Vercel URL).
   * Unset ⇒ any origin: safe here because auth is per-request wallet
   * signatures, never cookies — there is no ambient credential to steal.
   */
  WEB_ORIGIN: z.string().min(1).optional(),
  /**
   * Comma-separated wallets allowed to mutate the market-binding registry.
   * Unset ⇒ any signature-verified wallet (single-operator dev deployments);
   * set it before any shared/production deploy.
   */
  ADMIN_WALLETS: z.string().min(1).optional(),
  /**
   * At-rest encryption key for stored pre-signed delegation txs
   * (security-review requirement 3): 64-char hex for raw 32 bytes, or any
   * passphrase (sha256-derived). Unset ⇒ plaintext storage (dev only).
   */
  DELEGATION_ENC_KEY: z.string().min(1).optional(),
  COMMITMENT_MEMO: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source?: NodeJS.ProcessEnv): Env {
  if (source === undefined) {
    // The documented flow is "copy .env.example to .env" — actually load it.
    // Node's built-in parser (20.12+); real environment variables win over the
    // file because loadEnvFile never overwrites existing process.env keys.
    try {
      process.loadEnvFile('.env');
    } catch {
      // no .env file: fine — CI/Fly inject real environment variables
    }
    source = process.env;
  }
  // An empty string (e.g. `TXLINE_API_TOKEN=` left blank in a copied
  // .env.example) means "unset", not "invalid one-char-minimum value".
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ''));
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new Error(`invalid environment: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return parsed.data;
}
