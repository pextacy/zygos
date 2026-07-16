/**
 * Adapter contracts (DOCS.md §3.1, CLAUDE.md §3). All external schema knowledge
 * — TxLINE wire formats, venue program layouts — stays behind these interfaces.
 *
 * OddsTick/MatchEvent are defined in @zygos/core (the consensus engine folds
 * over them, and core may not import this package) and re-exported here so
 * adapter authors have a single import point, as DOCS.md §3.1 sketches.
 */
import type { MarketKey, MatchEvent, OddsTick } from '@zygos/core';

export type { MatchEvent, OddsTick } from '@zygos/core';

export interface FeedHealth {
  connected: boolean;
  /** Per subscribed fixtureId: ms since last tick. Drives STALE lockout (FR-14). */
  lastTickAgeMs: Record<string, number>;
}

export interface OddsFeedAdapter {
  connect(): Promise<void>;
  subscribe(fixtureIds: string[]): Promise<void>;
  onTick(cb: (t: OddsTick) => void): void;
  /** No-ops if the feed tier lacks an event stream; inference fills in (DOCS.md §6). */
  onEvent(cb: (e: MatchEvent) => void): void;
  health(): FeedHealth;
  disconnect(): Promise<void>;
}

/** An open position on the venue, in outcome shares paying 1 quote-token unit (DOCS.md §5). */
export interface VenuePosition {
  /** Stable reference used across valuation, preview, and rules. */
  positionRef: string;
  fixtureId: string;
  market: MarketKey;
  outcome: string;
  /** Share quantity in venue base units. Money is always bigint (CLAUDE.md §5). */
  size: bigint;
  /** Average entry price in quote base units per share, if recoverable from chain. */
  entryPrice: bigint | null;
}

/** Size-aware quote: walking the book / AMM curve, fee-inclusive (DOCS.md §5.3). */
export interface VenueQuote {
  market: MarketKey;
  outcome: string;
  side: 'BUY' | 'SELL';
  size: bigint;
  /** Effective price in quote base units per share at the full requested size. */
  price: bigint;
  feeIncluded: boolean;
  /** ms epoch at which the underlying book/pool state was read. */
  asOf: number;
}

/** Unsigned transaction handed to the wallet adapter — never signed server-side (CLAUDE.md §2.2). */
export interface UnsignedVenueTx {
  /** Base64-serialized unsigned Solana transaction. */
  txBase64: string;
  /** Slippage bound baked into the instruction, in quote base units. */
  worstCasePrice: bigint;
}

export interface VenueAdapter {
  readonly venueId: string;
  readonly cluster: 'mainnet-beta' | 'devnet';
  getPositions(wallet: string): Promise<VenuePosition[]>;
  getQuote(market: MarketKey, outcome: string, side: 'BUY' | 'SELL', size: bigint): Promise<VenueQuote>;
  buildHedgeTx(wallet: string, position: VenuePosition, fraction: number, quote: VenueQuote): Promise<UnsignedVenueTx>;
  /** Present only where the venue supports direct position reduction (DOCS.md §5.3). */
  buildCloseTx?(wallet: string, position: VenuePosition, fraction: number, quote: VenueQuote): Promise<UnsignedVenueTx>;
}
