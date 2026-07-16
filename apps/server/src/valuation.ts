import {
  FeedStaleError,
  marketKeyString,
  valuePosition,
  type ConsensusSnapshot,
  type OutcomeKey,
  type PositionValuation,
} from '@zygos/core';
import type { VenueAdapter, VenuePosition } from '@zygos/venue-adapters';
import type { FeedLogger, FeedService } from './feed.js';

/**
 * Position valuation service (PRD FR-20/21/22, PLAN.md T1.6): joins venue
 * positions with the latest consensus snapshot per market and re-valuates on
 * every relevant tick. Pure math lives in @zygos/core; this owns the joins.
 *
 * Honesty rules: a wallet with no venue adapter configured is an error (503
 * upstream), a position whose market has no fresh consensus is returned as
 * `state: 'STALE' | 'NO_CONSENSUS'` with a null valuation — never a silently
 * frozen number (CLAUDE.md §2.3).
 */

export interface ValuedPosition {
  position: {
    positionRef: string;
    fixtureId: string;
    market: string;
    outcome: string;
    size: string; // bigint serialized
    entryPrice: string | null;
  };
  state: 'OK' | 'STALE' | 'NO_CONSENSUS' | 'UNMAPPED_OUTCOME';
  valuation: {
    fairValue: string;
    markValue: string | null;
    lagDelta: string | null;
    consensusProb: number;
    feedAgeMs: number;
    packetIds: string[];
  } | null;
}

export interface ValuationListener {
  wallet: string;
  onValuation: (v: ValuedPosition) => void;
}

const OUTCOME_KEYS: ReadonlySet<string> = new Set(['HOME', 'DRAW', 'AWAY', 'OVER', 'UNDER']);

export class ValuationService {
  private readonly listeners: ValuationListener[] = [];
  /** wallet → cached venue positions (refreshed on demand and on subscribe). */
  private readonly positionsByWallet = new Map<string, VenuePosition[]>();

  constructor(
    private readonly venue: VenueAdapter,
    feed: FeedService,
    private readonly log: FeedLogger,
  ) {
    feed.addListener({
      onConsensus: (snap) => this.onConsensus(snap),
    });
  }

  /** Load (or refresh) positions for a wallet from the venue program/API. */
  async refreshPositions(wallet: string): Promise<VenuePosition[]> {
    const positions = await this.venue.getPositions(wallet);
    this.positionsByWallet.set(wallet, positions);
    this.log.info({ wallet: truncate(wallet), count: positions.length, venue: this.venue.venueId }, 'positions refreshed');
    return positions;
  }

  addListener(l: ValuationListener): void {
    this.listeners.push(l);
    void this.refreshPositions(l.wallet).catch((err: unknown) => {
      this.log.error({ wallet: truncate(l.wallet), err: err instanceof Error ? err.message : String(err) }, 'position refresh failed');
    });
  }

  removeListener(l: ValuationListener): void {
    const i = this.listeners.indexOf(l);
    if (i !== -1) this.listeners.splice(i, 1);
  }

  /** Value all of a wallet's positions against the given snapshots at nowMs. */
  valueWallet(wallet: string, snapshots: ConsensusSnapshot[], nowMs: number): ValuedPosition[] {
    const positions = this.positionsByWallet.get(wallet) ?? [];
    const byMarket = new Map<string, ConsensusSnapshot>();
    for (const s of snapshots) {
      byMarket.set(`${s.fixtureId}|${marketKeyString(s.market)}`, s);
    }
    return positions.map((p) => this.valueOne(p, byMarket.get(`${p.fixtureId}|${marketKeyString(p.market)}`), nowMs));
  }

  private valueOne(position: VenuePosition, snapshot: ConsensusSnapshot | undefined, nowMs: number): ValuedPosition {
    const base: ValuedPosition['position'] = {
      positionRef: position.positionRef,
      fixtureId: position.fixtureId,
      market: marketKeyString(position.market),
      outcome: position.outcome,
      size: position.size.toString(),
      entryPrice: position.entryPrice?.toString() ?? null,
    };

    if (snapshot === undefined) {
      return { position: base, state: 'NO_CONSENSUS', valuation: null };
    }
    if (!OUTCOME_KEYS.has(position.outcome)) {
      // e.g. Jupiter positions on unmapped markets ("YES"/"NOT_HOME" without binding)
      return { position: base, state: 'UNMAPPED_OUTCOME', valuation: null };
    }

    try {
      const v: PositionValuation = valuePosition({
        size: position.size,
        outcome: position.outcome as OutcomeKey,
        snapshot,
        markPrice: null, // on-chain mark quote wiring lands with the hedge engine (T2.x getQuote per tick is rate-prohibitive)
        nowMs,
      });
      return {
        position: base,
        state: 'OK',
        valuation: {
          fairValue: v.fairValue.toString(),
          markValue: v.markValue?.toString() ?? null,
          lagDelta: v.lagDelta?.toString() ?? null,
          consensusProb: v.consensusProb,
          feedAgeMs: v.feedAgeMs,
          packetIds: v.packetIds,
        },
      };
    } catch (err) {
      if (err instanceof FeedStaleError) {
        return { position: base, state: 'STALE', valuation: null };
      }
      throw err;
    }
  }

  private onConsensus(snap: ConsensusSnapshot): void {
    if (this.listeners.length === 0) return;
    const nowMs = Date.now();
    const marketKey = marketKeyString(snap.market);
    for (const listener of this.listeners) {
      const positions = this.positionsByWallet.get(listener.wallet) ?? [];
      for (const p of positions) {
        if (p.fixtureId !== snap.fixtureId || marketKeyString(p.market) !== marketKey) continue;
        listener.onValuation(this.valueOne(p, snap, nowMs));
      }
    }
  }
}

function truncate(wallet: string): string {
  // Never log full wallet addresses (CLAUDE.md §5).
  return wallet.length > 8 ? `${wallet.slice(0, 4)}…${wallet.slice(-4)}` : wallet;
}
