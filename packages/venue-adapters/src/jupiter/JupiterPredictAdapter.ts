import { InsufficientDepthError, type MarketKey } from '@zygos/core';
import type { UnsignedVenueTx, VenueAdapter, VenuePosition, VenueQuote } from '../types.js';
import { FeedConfigError } from '../txline/errors.js';
import {
  jupiterMarketSchema,
  jupiterOrderResponseSchema,
  jupiterPositionSchema,
  jupiterPositionsResponseSchema,
  USDC_MINT,
  type JupiterPosition,
} from './schema.js';

/**
 * Jupiter Predict venue adapter (docs/venue-selection.md candidate #1).
 * Binary YES/NO USDC contracts; each winning contract pays $1. The API
 * returns unsigned transactions — signing happens exclusively in the user's
 * wallet (CLAUDE.md §2.2).
 *
 * Jupiter markets are venue-native marketIds, not TxLINE fixtures. The
 * server supplies a MarketBinding registry (built by matching TxLINE fixture
 * metadata against GET /events/search) that maps venue markets onto our
 * domain (fixtureId, MarketKey, outcome). Positions on unmapped markets are
 * surfaced with a null binding rather than dropped — the UI shows them as
 * "not valued" instead of pretending they don't exist.
 */

export interface MarketBinding {
  fixtureId: string;
  market: MarketKey;
  /** Which domain outcome a YES contract on this market represents (e.g. HOME). */
  yesOutcome: string;
}

export interface JupiterPredictAdapterOptions {
  apiKey: string;
  baseUrl?: string;
  /** venue marketId → domain binding; maintained by the server's fixture matcher. */
  bindings?: ReadonlyMap<string, MarketBinding>;
  fetchFn?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://api.jup.ag/prediction/v1';

export class JupiterPredictAdapter implements VenueAdapter {
  readonly venueId = 'jupiter-predict';
  readonly cluster = 'mainnet-beta' as const;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly bindings: ReadonlyMap<string, MarketBinding>;
  private readonly fetchFn: typeof fetch | undefined;

  constructor(options: JupiterPredictAdapterOptions) {
    if (!options.apiKey) {
      throw new FeedConfigError('JUPITER_API_KEY missing — venue adapter cannot start.');
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.bindings = options.bindings ?? new Map();
    this.fetchFn = options.fetchFn;
  }

  async getPositions(wallet: string): Promise<VenuePosition[]> {
    const body = await this.request('GET', `/positions?ownerPubkey=${encodeURIComponent(wallet)}`);
    const parsed = jupiterPositionsResponseSchema.parse(body);
    const out: VenuePosition[] = [];
    for (const raw of parsed.positions) {
      const pos = jupiterPositionSchema.safeParse(raw);
      if (!pos.success) continue; // malformed row: skip, never invent fields
      out.push(this.toVenuePosition(pos.data));
    }
    return out;
  }

  async getQuote(market: MarketKey, outcome: string, side: 'BUY' | 'SELL', size: bigint): Promise<VenueQuote> {
    const marketId = this.marketIdFor(market, outcome);
    const body = await this.request('GET', `/markets/${encodeURIComponent(marketId)}`);
    const m = jupiterMarketSchema.parse(body);

    const binding = this.bindings.get(marketId);
    const wantYes = binding === undefined || binding.yesOutcome === outcome;
    // BUY fills at the ask of the chosen side; SELL of YES ≈ BUY of NO (binary complement).
    const price = side === 'BUY' ? (wantYes ? m.yesPrice : m.noPrice) : 1_000_000 - (wantYes ? m.noPrice : m.yesPrice);
    if (price <= 0 || price >= 1_000_000) {
      throw new InsufficientDepthError(marketId, size);
    }
    return {
      market,
      outcome,
      side,
      size,
      price: BigInt(price),
      feeIncluded: false, // fees come back on order preview (estimatedFees); surfaced there
      asOf: Date.now(),
    };
  }

  async buildHedgeTx(wallet: string, position: VenuePosition, fraction: number, quote: VenueQuote): Promise<UnsignedVenueTx> {
    if (!(fraction > 0 && fraction <= 1)) {
      throw new RangeError(`lock fraction out of (0,1]: ${fraction}`);
    }
    const marketId = this.marketIdFor(position.market, position.outcome);
    const binding = this.bindings.get(marketId);
    const holdIsYes = binding === undefined || binding.yesOutcome === position.outcome;

    // Hedge a YES position by buying NO on the same binary market (and vice
    // versa): payoff becomes outcome-independent (DOCS.md §5.1 with B = ¬A).
    // All sizes are payout base units (1_000_000 = one $1-paying contract).
    const hedgeSize = (position.size * BigInt(Math.round(fraction * 1_000_000))) / 1_000_000n;
    const depositAmount = (hedgeSize * quote.price) / 1_000_000n; // micro-USD cost at quoted price

    const body = await this.request('POST', '/orders', {
      ownerPubkey: wallet,
      marketId,
      isYes: !holdIsYes,
      isBuy: true,
      depositAmount: depositAmount.toString(),
      depositMint: USDC_MINT,
    });
    const order = jupiterOrderResponseSchema.parse(body);
    return { txBase64: order.transaction, worstCasePrice: quote.price };
  }

  /** Direct close: DELETE /positions/{pubkey} sells all contracts. Partial close falls back to the synthetic hedge. */
  async buildCloseTx(_wallet: string, position: VenuePosition, fraction: number, quote: VenueQuote): Promise<UnsignedVenueTx> {
    if (fraction !== 1) {
      return this.buildHedgeTx(_wallet, position, fraction, quote);
    }
    const body = await this.request('DELETE', `/positions/${encodeURIComponent(position.positionRef)}`);
    const order = jupiterOrderResponseSchema.parse(body);
    return { txBase64: order.transaction, worstCasePrice: quote.price };
  }

  private toVenuePosition(pos: JupiterPosition): VenuePosition {
    const binding = this.bindings.get(pos.marketId);
    return {
      positionRef: pos.positionPubkey,
      fixtureId: binding?.fixtureId ?? `unmapped:${pos.marketId}`,
      market: binding?.market ?? { kind: '1X2' },
      outcome: binding ? (pos.isYes ? binding.yesOutcome : `NOT_${binding.yesOutcome}`) : pos.isYes ? 'YES' : 'NO',
      // Each contract pays $1 = 1_000_000 micro-USD, so size in payout base units:
      size: BigInt(pos.contracts) * 1_000_000n,
      entryPrice: pos.entryPrice != null ? BigInt(pos.entryPrice) : null,
    };
  }

  private marketIdFor(market: MarketKey, outcome: string): string {
    for (const [marketId, b] of this.bindings) {
      const sameMarket = b.market.kind === market.kind && (market.kind !== 'TOTAL' || (b.market as { line?: number }).line === market.line);
      if (sameMarket && (b.yesOutcome === outcome || `NOT_${b.yesOutcome}` === outcome)) return marketId;
    }
    throw new FeedConfigError(`no Jupiter market bound for ${market.kind}/${outcome} — fixture matcher has not mapped it yet`);
  }

  private async request(method: 'GET' | 'POST' | 'DELETE', path: string, body?: object): Promise<unknown> {
    const fetchFn = this.fetchFn ?? fetch;
    const res = await fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'x-api-key': this.apiKey,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      throw new Error(`jupiter API ${method} ${path}: HTTP ${res.status}`);
    }
    return res.json();
  }
}
