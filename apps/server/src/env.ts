import { z } from 'zod';

/**
 * Server environment (CLAUDE.md §9). TxLINE credentials exist only here —
 * never imported into apps/web, never logged (CLAUDE.md §2.5).
 *
 * TXLINE_* and RPC_URL are optional at scaffold stage so the empty server
 * boots for CI/smoke; the feed and venue services (Day 1) fail fast without them.
 */
const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default('0.0.0.0'),
  TXLINE_API_KEY: z.string().min(1).optional(),
  TXLINE_BASE_URL: z.string().url().optional(),
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
