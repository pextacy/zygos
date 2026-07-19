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
import { packets, rawPackets, subscriptions, type Db } from './db.js';

/** Structural subset of pino/fastify loggers — lets the CLI pass a console-backed one. */
export interface FeedLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export type FeedState = 'LIVE' | 'DEGRADED' | 'STALE';

const DEGRADED_AFTER_MS = 10_000;
const STALE_AFTER_MS = 30_000; // FR-14

/** Subscription endpoints are unauthenticated; cap total tracked fixtures so anonymous clients can't grow state/upstream polling without bound. */
const MAX_SUBSCRIBED_FIXTURES = 200;

export class SubscriptionLimitError extends Error {
  constructor(requested: number, limit: number) {
    super(`subscription limit reached: ${requested} requested, cap is ${limit} fixtures`);
    this.name = 'SubscriptionLimitError';
  }
}

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

  /**
   * Record the raw poll body before parsing (DOCS.md §3.2). Called from the
   * adapter's onRawPacket hook. The insert is fire-and-forget: audit writes
   * must never stall the hot tick path on DB latency.
   */
  auditRaw(raw: { fixtureId: string; body: string; receivedAt: number }): string {
    const hash = FeedService.hashRaw(raw.body);
    void this.db
      .insert(rawPackets)
      .values({ hash, fixtureId: raw.fixtureId, receivedAt: raw.receivedAt })
      .onConflictDoNothing()
      .catch((err: unknown) => this.log.error({ err, fixtureId: raw.fixtureId }, 'raw packet audit insert failed'));
    this.lastRawHash.set(raw.fixtureId, hash);
    return hash;
  }

  private readonly lastRawHash = new Map<string, string>();

  async subscribe(fixtureIds: string[]): Promise<void> {
    const fresh = fixtureIds.filter((id) => !this.subscribed.has(id));
    if (fresh.length === 0) return;
    if (this.subscribed.size + fresh.length > MAX_SUBSCRIBED_FIXTURES) {
      throw new SubscriptionLimitError(this.subscribed.size + fresh.length, MAX_SUBSCRIBED_FIXTURES);
    }
    await this.adapter.subscribe(fresh);
    for (const id of fresh) this.subscribed.add(id);
    // Persist so a host restart restores the live board on boot (see restore()).
    const now = Date.now();
    void this.db
      .insert(subscriptions)
      .values(fresh.map((fixtureId) => ({ fixtureId, createdAt: now })))
      .onConflictDoNothing()
      .catch((err: unknown) => this.log.error({ err }, 'subscription persist failed'));
    this.log.info({ fixtureIds: fresh }, 'subscribed fixtures');
  }

  /** Re-subscribe every persisted fixture — called once on boot so a restart is self-healing. */
  async restoreSubscriptions(): Promise<void> {
    const rows = await this.db.select().from(subscriptions);
    const ids = rows.map((r) => r.fixtureId);
    if (ids.length === 0) return;
    try {
      await this.subscribe(ids);
      this.log.info({ count: ids.length }, 'restored persisted fixture subscriptions on boot');
    } catch (err) {
      this.log.error({ err: err instanceof Error ? err.message : String(err) }, 'subscription restore failed');
    }
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

  /**
   * Ticks are processed on a serialized chain: the packet audit insert must
   * LAND before the tick is consumed and fanned out (FR-13 audit-before-
   * consume), otherwise a client can be shown a packetId that /verify/odds
   * still 404s on — or, on a crash, one whose provenance row is lost forever.
   * The chain also preserves per-market tick ordering across async awaits.
   */
  private tickChain: Promise<void> = Promise.resolve();

  private handleTick(tick: OddsTick): void {
    this.tickChain = this.tickChain.then(() => this.processTick(tick));
  }

  /** Resolves when every tick received so far is audited, folded and fanned out (tests, shutdown). */
  flushTicks(): Promise<void> {
    return this.tickChain;
  }

  private async processTick(tick: OddsTick): Promise<void> {
    const rawHash = this.lastRawHash.get(tick.fixtureId) ?? 'unknown';
    try {
      await this.db
        .insert(packets)
        .values({ packetId: tick.packetId, sourceTs: tick.sourceTs, fixtureId: tick.fixtureId, market: marketKeyString(tick.market), rawHash })
        .onConflictDoNothing();
    } catch (err: unknown) {
      // The tick is still consumed (a dropped tick would freeze valuations),
      // but the failure is loud: this packet cannot be /verify'd later.
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
