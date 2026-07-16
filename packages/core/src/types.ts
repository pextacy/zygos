/**
 * Core domain types shared across Zygos. Pure data — no I/O in this package
 * (CLAUDE.md §5). Wire-format knowledge lives in the adapters, never here.
 */

/** Market taxonomy. Extended as feed tiers are confirmed (PRD FR-10). */
export type MarketKey = { kind: '1X2' } | { kind: 'TOTAL'; line: number };

export type OutcomeKey = 'HOME' | 'DRAW' | 'AWAY' | 'OVER' | 'UNDER';

/** A normalized odds tick from the feed adapter (DOCS.md §3.1). */
export interface OddsTick {
  /** TxLINE packet identifier — provenance for every derived number (FR-13). */
  packetId: string;
  /** Server monotonic ms at receipt. */
  receivedAt: number;
  /** TxLINE timestamp, ms epoch. */
  sourceTs: number;
  fixtureId: string;
  market: MarketKey;
  bookmakerId: string;
  outcomes: Array<{ outcome: OutcomeKey; decimalOdds: number }>;
}

/** A match event, explicit from the feed or inferred from odds moves (DOCS.md §6). */
export interface MatchEvent {
  packetId: string;
  sourceTs: number;
  fixtureId: string;
  type: 'GOAL' | 'RED_CARD' | 'KICKOFF' | 'HT' | 'FT';
  team: 'HOME' | 'AWAY' | null;
  /** true when derived from an odds discontinuity rather than an explicit feed event. */
  inferred: boolean;
}

/** De-vigged consensus snapshot for one market (DOCS.md §4). */
export interface ConsensusSnapshot {
  fixtureId: string;
  market: MarketKey;
  /** Probability per outcome, each in [0,1], summing to 1. */
  probs: Partial<Record<OutcomeKey, number>>;
  /** Number of books contributing to the blend. <2 ⇒ LOW_CONFIDENCE. */
  bookCount: number;
  /** Packet ids of every tick contributing to this snapshot (FR-13). */
  packetIds: string[];
  /** ms epoch of the newest contributing tick. */
  asOf: number;
}
