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
  DATABASE_URL: z.string().default('./data/zygos.db'),
  COMMITMENT_MEMO: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`invalid environment: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return parsed.data;
}
