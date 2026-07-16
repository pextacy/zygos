import { z } from 'zod';
import type { MatchEvent, OddsTick } from '@zygos/core';
import type { FeedHealth, OddsFeedAdapter } from '../types.js';
import { FeedConfigError } from './errors.js';
import { toMatchEvent, toOddsTick, wireEventMessageSchema, wireOddsMessageSchema } from './schema.js';

/**
 * TxLINE feed adapter (DOCS.md §3). REST-polling transport at 2s/fixture —
 * within PRD latency targets. A WebSocket transport slots in behind the same
 * interface once the hackathon docs confirm streaming (SCHEMA.md open Q2).
 *
 * Resilience (DOCS.md §3.2): per-fixture exponential backoff 1s→30s on fetch
 * failure, reset on success. Staleness is surfaced via health(); the server
 * marks markets STALE — the adapter never fabricates ticks to look alive.
 */

export interface TxLineAdapterOptions {
  apiKey: string;
  baseUrl: string;
  pollIntervalMs?: number;
  /** Injected for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** Called with every raw payload BEFORE parsing, so the audit log survives parser bugs (DOCS.md §3.2). */
  onRawPacket?: (raw: { fixtureId: string; body: string; receivedAt: number }) => void;
  onParseError?: (err: { fixtureId: string; reason: string }) => void;
}

const POLL_RESPONSE_SCHEMA = z.object({
  odds: z.array(z.unknown()).default([]),
  events: z.array(z.unknown()).default([]),
});

interface FixturePollState {
  timer: NodeJS.Timeout | null;
  backoffMs: number;
  lastTickTs: number | null;
  seenPacketIds: Set<string>;
}

const BACKOFF_START_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;
const SEEN_CAP = 10_000;

export class TxLineAdapter implements OddsFeedAdapter {
  private readonly opts: {
    apiKey: string;
    baseUrl: string;
    pollIntervalMs: number;
    fetchFn: typeof fetch | undefined;
    onRawPacket: TxLineAdapterOptions['onRawPacket'] | undefined;
    onParseError: TxLineAdapterOptions['onParseError'] | undefined;
  };
  private readonly fixtures = new Map<string, FixturePollState>();
  private tickCbs: Array<(t: OddsTick) => void> = [];
  private eventCbs: Array<(e: MatchEvent) => void> = [];
  private connected = false;

  constructor(options: TxLineAdapterOptions) {
    if (!options.apiKey) {
      throw new FeedConfigError('TXLINE_API_KEY missing — cannot start the feed. No stub data will be served.');
    }
    if (!options.baseUrl) {
      throw new FeedConfigError('TXLINE_BASE_URL missing — cannot start the feed.');
    }
    this.opts = {
      apiKey: options.apiKey,
      baseUrl: options.baseUrl.replace(/\/$/, ''),
      pollIntervalMs: options.pollIntervalMs ?? 2_000,
      fetchFn: options.fetchFn,
      onRawPacket: options.onRawPacket,
      onParseError: options.onParseError,
    };
  }

  async connect(): Promise<void> {
    // REST transport has no persistent connection; verify reachability once so
    // misconfiguration fails at startup, not at first poll.
    const res = await this.request('/v1/ping');
    if (!res.ok && res.status !== 404) {
      throw new FeedConfigError(`TxLINE unreachable: HTTP ${res.status} from ${this.opts.baseUrl}`);
    }
    this.connected = true;
  }

  async subscribe(fixtureIds: string[]): Promise<void> {
    if (!this.connected) {
      throw new FeedConfigError('subscribe() before connect()');
    }
    for (const fixtureId of fixtureIds) {
      if (this.fixtures.has(fixtureId)) continue;
      const state: FixturePollState = { timer: null, backoffMs: 0, lastTickTs: null, seenPacketIds: new Set() };
      this.fixtures.set(fixtureId, state);
      void this.poll(fixtureId, state);
    }
  }

  onTick(cb: (t: OddsTick) => void): void {
    this.tickCbs.push(cb);
  }

  onEvent(cb: (e: MatchEvent) => void): void {
    this.eventCbs.push(cb);
  }

  health(): FeedHealth {
    const lastTickAgeMs: Record<string, number> = {};
    const now = Date.now();
    for (const [fixtureId, s] of this.fixtures) {
      lastTickAgeMs[fixtureId] = s.lastTickTs === null ? Number.POSITIVE_INFINITY : now - s.lastTickTs;
    }
    return { connected: this.connected, lastTickAgeMs };
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    for (const s of this.fixtures.values()) {
      if (s.timer) clearTimeout(s.timer);
      s.timer = null;
    }
    this.fixtures.clear();
  }

  private request(path: string): Promise<Response> {
    const fetchFn = this.opts.fetchFn ?? fetch;
    return fetchFn(`${this.opts.baseUrl}${path}`, {
      headers: { authorization: `Bearer ${this.opts.apiKey}`, accept: 'application/json' },
    });
  }

  private async poll(fixtureId: string, state: FixturePollState): Promise<void> {
    if (!this.connected || !this.fixtures.has(fixtureId)) return;

    let delayMs = this.opts.pollIntervalMs;
    try {
      const res = await this.request(`/v1/fixtures/${encodeURIComponent(fixtureId)}/live`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.text();
      const receivedAt = Date.now();
      this.opts.onRawPacket?.({ fixtureId, body, receivedAt });
      this.handlePayload(fixtureId, state, body, receivedAt);
      state.backoffMs = 0;
    } catch (err) {
      state.backoffMs = state.backoffMs === 0 ? BACKOFF_START_MS : Math.min(state.backoffMs * 2, BACKOFF_CAP_MS);
      delayMs = state.backoffMs;
      this.opts.onParseError?.({ fixtureId, reason: `poll failed: ${err instanceof Error ? err.message : String(err)}` });
    }

    if (this.connected && this.fixtures.has(fixtureId)) {
      state.timer = setTimeout(() => void this.poll(fixtureId, state), delayMs);
      state.timer.unref?.();
    }
  }

  private handlePayload(fixtureId: string, state: FixturePollState, body: string, receivedAt: number): void {
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      this.opts.onParseError?.({ fixtureId, reason: 'response is not JSON' });
      return;
    }
    const parsed = POLL_RESPONSE_SCHEMA.safeParse(json);
    if (!parsed.success) {
      this.opts.onParseError?.({ fixtureId, reason: `unexpected shape: ${parsed.error.issues[0]?.message ?? 'unknown'}` });
      return;
    }

    for (const raw of parsed.data.odds) {
      const msg = wireOddsMessageSchema.safeParse(raw);
      if (!msg.success) {
        this.opts.onParseError?.({ fixtureId, reason: `odds message rejected: ${msg.error.issues[0]?.message ?? 'unknown'}` });
        continue;
      }
      if (state.seenPacketIds.has(msg.data.packet_id)) continue;
      this.remember(state, msg.data.packet_id);

      const tick = toOddsTick(msg.data, receivedAt);
      if (tick === null) {
        this.opts.onParseError?.({ fixtureId, reason: `untranslatable market/outcome in packet ${msg.data.packet_id}` });
        continue;
      }
      state.lastTickTs = receivedAt;
      for (const cb of this.tickCbs) cb(tick);
    }

    for (const raw of parsed.data.events) {
      const msg = wireEventMessageSchema.safeParse(raw);
      if (!msg.success) continue;
      if (state.seenPacketIds.has(msg.data.packet_id)) continue;
      this.remember(state, msg.data.packet_id);
      const event = toMatchEvent(msg.data);
      for (const cb of this.eventCbs) cb(event);
    }
  }

  private remember(state: FixturePollState, packetId: string): void {
    state.seenPacketIds.add(packetId);
    if (state.seenPacketIds.size > SEEN_CAP) {
      // Drop the oldest half; Set iteration order is insertion order.
      const keep = [...state.seenPacketIds].slice(SEEN_CAP / 2);
      state.seenPacketIds.clear();
      for (const id of keep) state.seenPacketIds.add(id);
    }
  }
}
