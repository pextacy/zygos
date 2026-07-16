import { createHash } from 'node:crypto';
import {
  applyTick,
  createInferenceState,
  inferFromSnapshot,
  marketKeyString,
  snapshot,
  type ConsensusSnapshot,
  type MarketConsensusState,
  type MatchEvent,
  type OddsTick,
} from '@zygos/core';
import type { OddsFeedAdapter } from '@zygos/venue-adapters';
import { packets, rawPackets, type Db } from './db.js';

/** Structural subset of pino/fastify loggers — lets the CLI pass a console-backed one. */
export interface FeedLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export type FeedState = 'LIVE' | 'DEGRADED' | 'STALE';

const DEGRADED_AFTER_MS = 10_000;
const STALE_AFTER_MS = 30_000; // FR-14

export interface FeedListeners {
  onConsensus?: (snap: ConsensusSnapshot) => void;
  onEvent?: (event: MatchEvent) => void;
}

/**
 * FeedService: adapter ticks → audit log → consensus fold → snapshot fanout.
 * Consensus math stays pure in @zygos/core; this class owns the I/O around it.
 */
export class FeedService {
  private readonly states = new Map<string, Map<string, MarketConsensusState>>();
  private readonly listeners: FeedListeners[] = [];
  private readonly subscribed = new Set<string>();

  /** Fixtures with a real (explicit) event stream: inference is suppressed for them (DOCS.md §6 is a fallback). */
  private readonly fixturesWithRealEvents = new Set<string>();
  private readonly inference = createInferenceState();

  constructor(
    private readonly adapter: OddsFeedAdapter,
    private readonly db: Db,
    private readonly log: FeedLogger,
  ) {
    adapter.onTick((tick) => this.handleTick(tick));
    adapter.onEvent((event) => {
      if (!event.inferred) this.fixturesWithRealEvents.add(event.fixtureId);
      this.log.info({ fixtureId: event.fixtureId, type: event.type, packetId: event.packetId }, 'match event');
      for (const l of this.listeners) l.onEvent?.(event);
    });
  }

  static hashRaw(body: string): string {
    return createHash('sha256').update(body).digest('hex');
  }

  /** Record the raw poll body before parsing (DOCS.md §3.2). Called from the adapter's onRawPacket hook. */
  auditRaw(raw: { fixtureId: string; body: string; receivedAt: number }): string {
    const hash = FeedService.hashRaw(raw.body);
    try {
      this.db.insert(rawPackets).values({ hash, fixtureId: raw.fixtureId, receivedAt: raw.receivedAt }).onConflictDoNothing().run();
    } catch (err) {
      this.log.error({ err, fixtureId: raw.fixtureId }, 'raw packet audit insert failed');
    }
    this.lastRawHash.set(raw.fixtureId, hash);
    return hash;
  }

  private readonly lastRawHash = new Map<string, string>();

  async subscribe(fixtureIds: string[]): Promise<void> {
    const fresh = fixtureIds.filter((id) => !this.subscribed.has(id));
    if (fresh.length === 0) return;
    await this.adapter.subscribe(fresh);
    for (const id of fresh) this.subscribed.add(id);
    this.log.info({ fixtureIds: fresh }, 'subscribed fixtures');
  }

  addListener(l: FeedListeners): void {
    this.listeners.push(l);
  }

  subscribedFixtures(): string[] {
    return [...this.subscribed];
  }

  /** Latest consensus snapshots across all tracked markets, at `nowMs`. */
  snapshots(nowMs: number): ConsensusSnapshot[] {
    const out: ConsensusSnapshot[] = [];
    for (const markets of this.states.values()) {
      for (const state of markets.values()) {
        const snap = snapshot(state, nowMs);
        if (snap) out.push(snap);
      }
    }
    return out;
  }

  /** Per-fixture feed state derived from adapter health (FR-14, DOCS.md §8 FEED_HEALTH). */
  feedStates(): Record<string, FeedState> {
    const health = this.adapter.health();
    const out: Record<string, FeedState> = {};
    for (const [fixtureId, ageMs] of Object.entries(health.lastTickAgeMs)) {
      out[fixtureId] = ageMs < DEGRADED_AFTER_MS ? 'LIVE' : ageMs < STALE_AFTER_MS ? 'DEGRADED' : 'STALE';
    }
    return out;
  }

  health() {
    return this.adapter.health();
  }

  private handleTick(tick: OddsTick): void {
    const rawHash = this.lastRawHash.get(tick.fixtureId) ?? 'unknown';
    try {
      this.db
        .insert(packets)
        .values({ packetId: tick.packetId, sourceTs: tick.sourceTs, fixtureId: tick.fixtureId, market: marketKeyString(tick.market), rawHash })
        .onConflictDoNothing()
        .run();
    } catch (err) {
      this.log.error({ err, packetId: tick.packetId, fixtureId: tick.fixtureId }, 'packet audit insert failed');
    }

    const markets = this.states.get(tick.fixtureId) ?? new Map<string, MarketConsensusState>();
    const key = marketKeyString(tick.market);
    const next = applyTick(markets.get(key), tick);
    markets.set(key, next);
    this.states.set(tick.fixtureId, markets);

    const snap = snapshot(next, Date.now());
    if (snap) {
      if (snap.excludedBookIds.length > 0) {
        this.log.warn(
          { fixtureId: snap.fixtureId, market: key, excluded: snap.excludedBookIds, packetId: tick.packetId },
          'outlier book excluded from consensus',
        );
      }
      for (const l of this.listeners) l.onConsensus?.(snap);

      // Odds-discontinuity event inference — only where no explicit event stream exists (DOCS.md §6).
      if (!this.fixturesWithRealEvents.has(snap.fixtureId)) {
        const inferred = inferFromSnapshot(this.inference, snap);
        if (inferred) {
          this.log.info({ fixtureId: inferred.fixtureId, team: inferred.team, packetId: tick.packetId }, 'event inferred from odds discontinuity');
          for (const l of this.listeners) l.onEvent?.(inferred);
        }
      }
    }
  }
}
