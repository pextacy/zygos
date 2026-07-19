import { z } from 'zod';
import type { MatchEvent, OddsTick } from '@zygos/core';
import type { FeedHealth, OddsFeedAdapter } from '../types.js';
import { FeedConfigError } from './errors.js';
import {
  normalizePhase,
  phaseTransitionEvent,
  toActionEvent,
  toOddsTick,
  txFixtureSchema,
  txOddsRecordSchema,
  txScoreRecordSchema,
  type TxFixture,
} from './schema.js';

/**
 * TxLINE feed adapter against the real API (SCHEMA.md):
 * - Auth: short-lived guest JWT (POST {origin}/auth/guest/start) in
 *   `Authorization: Bearer`, long-lived activated token in `X-Api-Token`.
 *   401/403 ⇒ renew the JWT and retry — the official client pattern.
 * - Transport: /api/odds/stream and /api/scores/stream SSE feeds (data
 *   messages carry one record; heartbeat events carry liveness), warmed by
 *   GET /api/odds/snapshot/{fixtureId} on subscribe.
 * - Resilience: exponential backoff 1s→30s per stream, resubscription-free
 *   (streams are account-wide; we filter to subscribed fixtures).
 * Fails fast without credentials; there is no offline or stub mode.
 */

export interface TxLineAdapterOptions {
  /** API origin, e.g. https://txline-dev.txodds.com (devnet) or https://txline.txodds.com (mainnet). */
  origin: string;
  /** Activated API token from scripts/txline-activate.ts (X-Api-Token header). */
  apiToken: string;
  fetchFn?: typeof fetch;
  /** Called with every raw data payload BEFORE parsing (audit-before-parse, DOCS.md §3.2). */
  onRawPacket?: (raw: { fixtureId: string; body: string; receivedAt: number }) => void;
  onParseError?: (err: { fixtureId: string; reason: string }) => void;
  /** Warm consensus state from the snapshot endpoint on subscribe (default true). */
  snapshotOnSubscribe?: boolean;
}

const BACKOFF_START_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;
const GUEST_AUTH_PATH = '/auth/guest/start';

const guestAuthResponseSchema = z.object({ token: z.string().min(1) }).passthrough();

interface StreamState {
  abort: AbortController | null;
  backoffMs: number;
  lastEventAt: number | null;
  /** True while a streamLoop owns this state — prevents a second concurrent loop after disconnect/reconnect. */
  looping: boolean;
}

export class TxLineAdapter implements OddsFeedAdapter {
  private readonly origin: string;
  private readonly apiToken: string;
  private readonly fetchFn: typeof fetch | undefined;
  private readonly onRawPacket: TxLineAdapterOptions['onRawPacket'];
  private readonly onParseError: TxLineAdapterOptions['onParseError'];
  private readonly snapshotOnSubscribe: boolean;

  private jwt: string | null = null;
  private connected = false;
  private readonly subscribed = new Set<string>();
  private readonly lastTickTs = new Map<string, number>();
  private readonly lastPhase = new Map<string, string>();
  private tickCbs: Array<(t: OddsTick) => void> = [];
  private eventCbs: Array<(e: MatchEvent) => void> = [];
  private readonly streams: Record<'odds' | 'scores', StreamState> = {
    odds: { abort: null, backoffMs: 0, lastEventAt: null, looping: false },
    scores: { abort: null, backoffMs: 0, lastEventAt: null, looping: false },
  };

  constructor(options: TxLineAdapterOptions) {
    if (!options.apiToken) {
      throw new FeedConfigError('TXLINE_API_TOKEN missing — run the activation script first. No stub data will be served.');
    }
    if (!options.origin) {
      throw new FeedConfigError('TXLINE_ORIGIN missing — e.g. https://txline-dev.txodds.com');
    }
    this.origin = options.origin.replace(/\/$/, '');
    this.apiToken = options.apiToken;
    this.fetchFn = options.fetchFn;
    this.onRawPacket = options.onRawPacket;
    this.onParseError = options.onParseError;
    this.snapshotOnSubscribe = options.snapshotOnSubscribe ?? true;
  }

  async connect(): Promise<void> {
    await this.renewJwt();
    this.connected = true;
  }

  async subscribe(fixtureIds: string[]): Promise<void> {
    if (!this.connected) throw new FeedConfigError('subscribe() before connect()');
    const fresh = fixtureIds.filter((id) => !this.subscribed.has(id));
    for (const id of fresh) this.subscribed.add(id);

    this.ensureStream('odds');
    this.ensureStream('scores');

    if (this.snapshotOnSubscribe) {
      await Promise.all(fresh.map((id) => this.warmSnapshot(id)));
    }
  }

  onTick(cb: (t: OddsTick) => void): void {
    this.tickCbs.push(cb);
  }

  onEvent(cb: (e: MatchEvent) => void): void {
    this.eventCbs.push(cb);
  }

  health(): FeedHealth {
    const now = Date.now();
    const lastTickAgeMs: Record<string, number> = {};
    for (const id of this.subscribed) {
      const ts = this.lastTickTs.get(id);
      lastTickAgeMs[id] = ts === undefined ? Number.POSITIVE_INFINITY : now - ts;
    }
    // `connected` = transport up (SSE loop running). It must NOT depend on
    // event freshness: pre-match the stream is open but idle (no odds yet), and
    // gating it on recent events would falsely report the feed as disconnected.
    // Data freshness is a separate signal (`streaming` + per-fixture STALE).
    const streaming = this.streams.odds.lastEventAt !== null && now - this.streams.odds.lastEventAt < 60_000;
    return { connected: this.connected, streaming, lastTickAgeMs };
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    for (const s of Object.values(this.streams)) {
      s.abort?.abort();
      s.abort = null;
    }
    this.subscribed.clear();
  }

  /**
   * Merkle proof bundle for one odds update (GET /api/odds/validation) — fed
   * to the txoracle `validate_odds` view call for on-chain verification.
   */
  async fetchOddsValidation(fixtureId: string, timestampMs: number): Promise<unknown> {
    return this.apiGet(`/api/odds/validation?fixtureId=${encodeURIComponent(fixtureId)}&timestamp=${timestampMs}`);
  }

  /** Upcoming/current fixtures — used by the server's fixture matcher and cli:watch list mode. */
  async listFixtures(params?: { competitionId?: number; startEpochDay?: number }): Promise<TxFixture[]> {
    const q = new URLSearchParams();
    if (params?.competitionId !== undefined) q.set('competitionId', String(params.competitionId));
    if (params?.startEpochDay !== undefined) q.set('startEpochDay', String(params.startEpochDay));
    const qs = q.size > 0 ? `?${q.toString()}` : '';
    const body = await this.apiGet(`/api/fixtures/snapshot${qs}`);
    const rows = z.array(z.unknown()).parse(body);
    const out: TxFixture[] = [];
    for (const raw of rows) {
      const fx = txFixtureSchema.safeParse(raw);
      if (fx.success) out.push(fx.data);
    }
    return out;
  }

  // ---- auth ----

  private async renewJwt(): Promise<string> {
    const fetchFn = this.fetchFn ?? fetch;
    const res = await fetchFn(`${this.origin}${GUEST_AUTH_PATH}`, { method: 'POST' });
    if (!res.ok) {
      throw new FeedConfigError(`guest auth failed: HTTP ${res.status} from ${this.origin}${GUEST_AUTH_PATH}`);
    }
    const parsed = guestAuthResponseSchema.parse(await res.json());
    this.jwt = parsed.token;
    return parsed.token;
  }

  private authHeaders(): Record<string, string> {
    return {
      authorization: `Bearer ${this.jwt ?? ''}`,
      'x-api-token': this.apiToken,
    };
  }

  /** GET with one automatic JWT renewal on 401/403 (official client pattern). */
  private async apiGet(path: string): Promise<unknown> {
    const fetchFn = this.fetchFn ?? fetch;
    let res = await fetchFn(`${this.origin}${path}`, { headers: { ...this.authHeaders(), accept: 'application/json' } });
    if (res.status === 401 || res.status === 403) {
      await this.renewJwt();
      res = await fetchFn(`${this.origin}${path}`, { headers: { ...this.authHeaders(), accept: 'application/json' } });
    }
    if (!res.ok) throw new Error(`txline ${path}: HTTP ${res.status}`);
    return res.json();
  }

  // ---- odds snapshot warm-up ----

  private async warmSnapshot(fixtureId: string): Promise<void> {
    try {
      const body = await this.apiGet(`/api/odds/snapshot/${encodeURIComponent(fixtureId)}`);
      const rows = z.array(z.unknown()).parse(body);
      const receivedAt = Date.now();
      for (const raw of rows) {
        this.handleOddsRecord(raw, receivedAt, fixtureId);
      }
    } catch (err) {
      this.onParseError?.({ fixtureId, reason: `snapshot warm-up failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  // ---- SSE streams ----

  private ensureStream(kind: 'odds' | 'scores'): void {
    if (this.streams[kind].looping) return;
    void this.streamLoop(kind);
  }

  private async streamLoop(kind: 'odds' | 'scores'): Promise<void> {
    const state = this.streams[kind];
    if (state.looping) return;
    state.looping = true;
    const fetchFn = this.fetchFn ?? fetch;

    try {
      while (this.connected) {
        const abort = new AbortController();
        state.abort = abort;
        try {
          let res = await fetchFn(`${this.origin}/api/${kind}/stream`, {
            headers: { ...this.authHeaders(), accept: 'text/event-stream', 'accept-encoding': 'deflate' },
            signal: abort.signal,
          });
          if (res.status === 401 || res.status === 403) {
            await this.renewJwt();
            res = await fetchFn(`${this.origin}/api/${kind}/stream`, {
              headers: { ...this.authHeaders(), accept: 'text/event-stream', 'accept-encoding': 'deflate' },
              signal: abort.signal,
            });
          }
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

          state.backoffMs = 0;
          state.lastEventAt = Date.now();
          await this.consumeSse(kind, res.body, state);
          // A cleanly ended stream still backs off before reconnecting — a
          // server that accepts and immediately closes must not be hammered.
          throw new Error('stream ended');
        } catch (err) {
          if (!this.connected) break;
          state.backoffMs = state.backoffMs === 0 ? BACKOFF_START_MS : Math.min(state.backoffMs * 2, BACKOFF_CAP_MS);
          this.onParseError?.({ fixtureId: '*', reason: `${kind} stream error, retrying in ${state.backoffMs}ms: ${err instanceof Error ? err.message : String(err)}` });
          await new Promise((r) => setTimeout(r, state.backoffMs));
        }
      }
    } finally {
      state.abort = null;
      state.looping = false;
    }
  }

  private async consumeSse(kind: 'odds' | 'scores', body: ReadableStream<Uint8Array>, state: StreamState): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sep = buffer.match(/\r?\n\r?\n/);
        while (sep?.index !== undefined) {
          const block = buffer.slice(0, sep.index);
          buffer = buffer.slice(sep.index + sep[0].length);
          this.handleSseBlock(kind, block, state);
          sep = buffer.match(/\r?\n\r?\n/);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private handleSseBlock(kind: 'odds' | 'scores', block: string, state: StreamState): void {
    let event: string | undefined;
    let data = '';
    for (const rawLine of block.split(/\r?\n/)) {
      if (!rawLine || rawLine.startsWith(':')) continue;
      const idx = rawLine.indexOf(':');
      const field = idx === -1 ? rawLine : rawLine.slice(0, idx);
      const value = idx === -1 ? '' : rawLine.slice(idx + 1).replace(/^ /, '');
      if (field === 'data') data += value;
      else if (field === 'event') event = value;
    }

    state.lastEventAt = Date.now();
    if (event === 'heartbeat' || data === '') return;

    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      this.onParseError?.({ fixtureId: '*', reason: `${kind} stream: non-JSON data message` });
      return;
    }

    const receivedAt = Date.now();
    if (kind === 'odds') this.handleOddsRecord(json, receivedAt);
    else this.handleScoreRecord(json, receivedAt, data);
  }

  // ---- record routing ----

  private handleOddsRecord(raw: unknown, receivedAt: number, sourceFixtureId?: string): void {
    // Audit BEFORE schema validation (DOCS.md §3.2): the packets a parser bug
    // rejects are exactly the ones the provenance log must not lose. Only the
    // fixture filter runs first, so the account-wide stream doesn't flood the log.
    const looseFixtureId = sourceFixtureId ?? looseFixtureIdOf(raw);
    if (looseFixtureId === null) {
      // No attributable FixtureId: the account-wide stream can carry any
      // volume of these and an unattributable row can never be /verify'd —
      // report the anomaly, don't persist it (bounds the audit table to
      // subscribed traffic).
      this.onParseError?.({ fixtureId: '*', reason: 'odds record without a FixtureId — reported, not audited' });
      return;
    }
    if (!this.subscribed.has(looseFixtureId)) return;
    this.onRawPacket?.({ fixtureId: looseFixtureId, body: JSON.stringify(raw), receivedAt });

    const rec = txOddsRecordSchema.safeParse(raw);
    if (!rec.success) {
      this.onParseError?.({ fixtureId: looseFixtureId, reason: `odds record rejected: ${rec.error.issues[0]?.message ?? 'unknown'}` });
      return;
    }
    const fixtureId = String(rec.data.FixtureId);
    if (!this.subscribed.has(fixtureId)) return;

    const { tick, reason } = toOddsTick(rec.data, receivedAt);
    if (tick === null) {
      if (reason && !reason.startsWith('unmapped market')) {
        // Unmapped markets are expected noise (props, corners, …); real anomalies are reported.
        this.onParseError?.({ fixtureId, reason });
      }
      return;
    }
    this.lastTickTs.set(fixtureId, receivedAt);
    for (const cb of this.tickCbs) cb(tick);
  }

  private handleScoreRecord(raw: unknown, receivedAt: number, rawBody: string): void {
    const rec = txScoreRecordSchema.safeParse(raw);
    if (!rec.success) return; // scores stream carries many shapes; only soccer actions are consumed
    const fixtureId = String(rec.data.fixtureId);
    if (!this.subscribed.has(fixtureId)) return;

    this.onRawPacket?.({ fixtureId, body: rawBody, receivedAt });

    const events: MatchEvent[] = [];
    const action = toActionEvent(rec.data);
    if (action) events.push(action);

    const phase = normalizePhase(rec.data.gameState);
    if (phase !== null) {
      const prev = this.lastPhase.get(fixtureId) ?? null;
      const transition = phaseTransitionEvent(rec.data, prev, phase);
      this.lastPhase.set(fixtureId, phase);
      if (transition) events.push(transition);
    }

    for (const event of events) {
      for (const cb of this.eventCbs) cb(event);
    }
  }
}

/** Best-effort FixtureId extraction from an unvalidated record, for pre-parse audit routing. */
function looseFixtureIdOf(raw: unknown): string | null {
  if (typeof raw === 'object' && raw !== null && 'FixtureId' in raw) {
    const id = (raw as { FixtureId: unknown }).FixtureId;
    if (typeof id === 'number' || typeof id === 'string') return String(id);
  }
  return null;
}
