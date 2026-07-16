import { z } from 'zod';

/**
 * Jupiter Predict API shapes, per the official developer guide
 * (developers.jup.ag → "How to build a prediction market app on Solana").
 * Base URL https://api.jup.ag/prediction/v1, auth via `x-api-key` header.
 * Amounts are micro-USD: 1_000_000 = $1.00 — identical to core PRICE_SCALE.
 *
 * Field-level shapes below are PROVISIONAL until verified against live
 * responses during the Day-1 liquidity gate (docs/venue-selection.md);
 * unknown extra fields pass through, missing required ones fail loudly.
 */

export const jupiterMarketSchema = z
  .object({
    marketId: z.string().min(1),
    // YES/NO pricing in micro-USD per contract.
    yesPrice: z.coerce.number().int().nonnegative(),
    noPrice: z.coerce.number().int().nonnegative(),
  })
  .passthrough();

export const jupiterPositionSchema = z
  .object({
    positionPubkey: z.string().min(32),
    marketId: z.string().min(1),
    isYes: z.boolean(),
    // Contract count; each winning contract pays exactly $1 (1_000_000 micro-USD).
    contracts: z.coerce.number().int().positive(),
    entryPrice: z.coerce.number().int().nonnegative().nullable().optional(),
    claimable: z.boolean().optional(),
  })
  .passthrough();

export const jupiterOrderResponseSchema = z
  .object({
    // Base64-encoded unsigned transaction — signed only by the user's wallet.
    transaction: z.string().min(1),
    contractCount: z.coerce.number().int().positive().optional(),
    estimatedCost: z.coerce.number().int().nonnegative().optional(),
    estimatedFees: z.coerce.number().int().nonnegative().optional(),
  })
  .passthrough();

export const jupiterPositionsResponseSchema = z.object({ positions: z.array(z.unknown()).default([]) }).passthrough();

export type JupiterMarket = z.infer<typeof jupiterMarketSchema>;
export type JupiterPosition = z.infer<typeof jupiterPositionSchema>;
export type JupiterOrderResponse = z.infer<typeof jupiterOrderResponseSchema>;

/** USDC mint used as depositMint in order creation (per the guide). */
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
