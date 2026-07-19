'use client';

import { ageLabel, clockTime, pct } from '../lib/format';
import type { HistoryPoint } from '../lib/store';
import type { ConsensusFrame, HealthDto, MatchEventDto, OutcomeKey } from '../lib/types';
import { TxBadge } from './TxBadge';

/** Outcome line colors: home/over indigo, draw slate, away/under red (design tokens). */
export const OUTCOME_COLOR: Record<string, string> = {
  HOME: '#2a14b4',
  OVER: '#2a14b4',
  DRAW: '#565e74',
  AWAY: '#ba1a1a',
  UNDER: '#ba1a1a',
};

/** Probability change (in percentage points) between the last two observed samples. */
export function lastMovePts(history: HistoryPoint[], outcome: string): number | null {
  if (history.length < 2) return null;
  const cur = history[history.length - 1]!.probs[outcome as OutcomeKey];
  const prev = history[history.length - 2]!.probs[outcome as OutcomeKey];
  if (cur === undefined || prev === undefined) return null;
  return (cur - prev) * 100;
}

function MoveArrow({ pts }: { pts: number | null }) {
  if (pts === null || Math.abs(pts) < 0.05) return null;
  return (
    <span className={`ml-1 font-mono text-[10px] ${pts > 0 ? 'text-primary' : 'text-error'}`} title={`${pts > 0 ? '+' : ''}${pts.toFixed(1)}pp since previous update`}>
      {pts > 0 ? '▲' : '▼'}
      {Math.abs(pts).toFixed(1)}
    </span>
  );
}

/** Session timeline of consensus probabilities — every point is a received TxLINE frame. */
function ProbabilityTimeline({ history }: { history: HistoryPoint[] }) {
  const t0 = history[0]!.asOf;
  const t1 = history[history.length - 1]!.asOf;
  const span = Math.max(1, t1 - t0);
  const outcomes = Object.keys(history[history.length - 1]!.probs) as OutcomeKey[];

  return (
    <svg viewBox="0 0 100 48" preserveAspectRatio="none" className="h-48 w-full" role="img" aria-label="Consensus probability timeline">
      {[12, 24, 36].map((y) => (
        <line key={y} x1="0" y1={y} x2="100" y2={y} stroke="#e0e3e5" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      ))}
      {outcomes.map((outcome) => {
        const points = history
          .filter((h) => h.probs[outcome] !== undefined)
          .map((h) => `${(((h.asOf - t0) / span) * 100).toFixed(2)},${(48 - (h.probs[outcome] ?? 0) * 48).toFixed(2)}`)
          .join(' ');
        return (
          <polyline
            key={outcome}
            points={points}
            fill="none"
            stroke={OUTCOME_COLOR[outcome] ?? '#565e74'}
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        );
      })}
    </svg>
  );
}

/**
 * Honest TxLINE-feed status. `connected` is transport (SSE open); `streaming`
 * is fresh odds within the window. Pre-match the stream is open but idle — that
 * is "Connected · idle", NOT "Disconnected" (which would misread as a fault).
 */
function feedLabel(health: HealthDto | null): string {
  if (!health) return '—';
  if (!health.txline.configured) return 'Not configured';
  if (!health.feed.connected) return 'Disconnected';
  return health.feed.streaming ? 'Streaming' : 'Connected · idle';
}
function feedTone(health: HealthDto | null): 'primary' | 'error' | undefined {
  if (!health) return undefined;
  if (!health.txline.configured || !health.feed.connected) return 'error';
  return 'primary';
}

function originHost(origin: string | undefined): string | null {
  if (!origin) return null;
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/**
 * Center dashboard chart card: the selected market's consensus probabilities
 * as horizontal bars — every number traceable to TxLINE packets (FR-54).
 */
export function ConsensusChartCard({
  frames,
  histories,
  selectedKey,
  onSelect,
  onExplain,
  className,
}: {
  frames: ConsensusFrame[];
  histories: Map<string, HistoryPoint[]>;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  onExplain: (frame: ConsensusFrame) => void;
  className?: string;
}) {
  const selected = frames.find((f) => `${f.fixtureId}|${f.market}` === selectedKey) ?? frames[0] ?? null;
  const siblings = selected ? frames.filter((f) => f.fixtureId === selected.fixtureId) : [];
  const history = selected ? (histories.get(`${selected.fixtureId}|${selected.market}`) ?? []) : [];

  return (
    <div className={`rounded-xl border border-outline-variant bg-surface-container-lowest p-4 shadow-sm md:p-6 ${className ?? ''}`}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-surface-container-high pb-2">
        <h3 className="text-title-md text-on-surface">{selected ? `Consensus · ${selected.fixtureId}` : 'Consensus'}</h3>
        {siblings.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {siblings.map((f) => {
              const key = `${f.fixtureId}|${f.market}`;
              const active = selected !== null && f.market === selected.market;
              return (
                <button
                  key={key}
                  onClick={() => onSelect(key)}
                  className={`rounded px-3 py-1 text-label-sm ${active ? 'bg-secondary-container text-on-secondary-container' : 'bg-surface-container-low text-on-surface-variant hover:bg-surface-container-high'}`}
                >
                  {f.market}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {!selected && (
        <div className="flex h-64 w-full items-center justify-center rounded border border-surface-variant bg-surface-container-low">
          <span className="rounded bg-surface/80 px-2 py-1 font-mono text-data-mono text-outline">Waiting for TxLINE consensus…</span>
        </div>
      )}

      {selected && (
        <>
          {history.length >= 2 ? (
            <div className="rounded border border-surface-variant bg-surface-container-low p-4">
              <ProbabilityTimeline history={history} />
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-surface-container-high pt-3">
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {Object.entries(selected.probs).map(([outcome, p]) => (
                    <span key={outcome} className="flex items-center gap-1.5 font-mono text-data-mono text-on-surface">
                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: OUTCOME_COLOR[outcome] ?? '#565e74' }} />
                      {outcome} {pct(p, 1)}
                      <MoveArrow pts={lastMovePts(history, outcome)} />
                    </span>
                  ))}
                </div>
                <span className="text-label-sm text-outline">
                  {history.length} live samples · {ageLabel(history[history.length - 1]!.asOf - history[0]!.asOf)} window
                </span>
              </div>
            </div>
          ) : (
            <div className="flex min-h-64 w-full flex-col justify-center gap-4 rounded border border-surface-variant bg-surface-container-low p-4">
              {Object.entries(selected.probs).map(([outcome, p]) => (
                <div key={outcome} className="flex items-center gap-3">
                  <span className="w-14 shrink-0 font-mono text-data-mono text-on-surface-variant">{outcome}</span>
                  <div className="h-7 flex-1 overflow-hidden rounded bg-surface-container-high">
                    <div
                      className="h-full rounded-r border-r border-primary/40 bg-gradient-to-r from-primary/10 to-primary/30"
                      style={{ width: `${Math.max(2, (p ?? 0) * 100)}%` }}
                    />
                  </div>
                  <span className="w-16 shrink-0 text-right font-mono text-data-mono text-primary">{pct(p, 1)}</span>
                </div>
              ))}
              <p className="text-center text-label-sm text-outline">Timeline appears after the next live frame — one sample so far.</p>
            </div>
          )}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <span className="text-label-sm text-outline">
              {selected.bookCount} contributing books · {ageLabel(Date.now() - selected.asOf)} old
              {selected.confidence === 'LOW_CONFIDENCE' && <span className="text-on-error-container"> · low confidence</span>}
              <TxBadge packetIds={selected.packetIds} asOf={selected.asOf} />
            </span>
            <button onClick={() => onExplain(selected)} className="text-label-sm text-primary underline decoration-dotted underline-offset-2 hover:text-primary-container">
              Why this price?
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Live feed/session metrics — every value observed this session, none synthetic. */
export function FeedMetricsCard({
  connected,
  everConnected,
  fixtures,
  markets,
  eventsSeen,
  cluster,
  health,
  clockSkewMs,
}: {
  connected: boolean;
  everConnected: boolean;
  fixtures: number;
  markets: number;
  eventsSeen: number;
  cluster: string;
  health: HealthDto | null;
  clockSkewMs: number | null;
}) {
  const feedHost = originHost(health?.txline.origin);
  // Same tri-state as the header: neutral "Connecting…" before the first open.
  const link = connected
    ? { value: 'Live', tone: 'primary' as const }
    : everConnected
      ? { value: 'Reconnecting…', tone: 'error' as const }
      : { value: 'Connecting…', tone: undefined };
  return (
    <div className="rounded-xl border border-outline-variant bg-surface-container-lowest p-4 shadow-sm md:p-6">
      <h3 className="mb-4 border-b border-surface-container-high pb-2 text-title-md text-on-surface">Feed Metrics</h3>
      <div className="grid grid-cols-2 gap-4">
        <Metric label="Server link" value={link.value} tone={link.tone} />
        <Metric label="TxLINE feed" value={feedLabel(health)} tone={feedTone(health)} />
        <Metric label="Feed origin" value={feedHost ?? '—'} />
        <Metric label="RPC" value={health ? (health.rpc.configured ? health.rpc.cluster : 'not configured') : cluster} />
        <Metric label="Fixtures watched" value={String(fixtures)} />
        <Metric label="Markets tracked" value={String(markets)} />
        <Metric label="Events seen" value={String(eventsSeen)} />
        <Metric label="Clock skew" value={clockSkewMs === null ? '—' : `${clockSkewMs >= 0 ? '+' : ''}${clockSkewMs}ms`} />
      </div>
    </div>
  );
}

/** Full server diagnostics from GET /healthz (analytics view). */
export function SystemStatusCard({ health, phase = 'ok' }: { health: HealthDto | null; phase?: 'loading' | 'ok' | 'unreachable' }) {
  const tickAges = Object.entries(health?.feed.lastTickAgeMs ?? {});
  // Distinguish "still loading" (neutral) from "genuinely unreachable" (red) —
  // never flash red on the initial poll or one transient blip.
  const statusChip =
    phase === 'loading'
      ? { text: 'Checking…', cls: 'bg-surface-container-high text-on-surface-variant' }
      : phase === 'unreachable'
        ? { text: 'server unreachable', cls: 'bg-error-container text-on-error-container' }
        : health?.status === 'ok'
          ? { text: 'ok', cls: 'bg-secondary-container text-on-secondary-container' }
          : { text: 'feed not configured', cls: 'bg-surface-variant text-secondary' };
  return (
    <div className="rounded-xl border border-outline-variant bg-surface-container-lowest shadow-sm">
      <div className="flex items-center justify-between border-b border-surface-container-high p-4">
        <h3 className="text-title-md text-on-surface">System Status</h3>
        <span className={`rounded-full px-2 py-0.5 text-label-sm ${statusChip.cls}`}>{statusChip.text}</span>
      </div>
      <div className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
        <Metric label="TxLINE feed" value={feedLabel(health)} tone={feedTone(health)} />
        <Metric label="Feed origin" value={originHost(health?.txline.origin) ?? '—'} />
        <Metric label="RPC" value={health ? (health.rpc.configured ? health.rpc.cluster : 'not configured') : '—'} />
        <Metric label="Audit DB" value={health ? (health.db.configured ? 'configured' : 'missing') : '—'} />
      </div>
      {tickAges.length > 0 && (
        <div className="border-t border-surface-container-high p-4">
          <span className="mb-2 block text-label-caps uppercase text-outline">Last tick per fixture</span>
          <ul className="flex flex-col gap-1">
            {tickAges.map(([fixtureId, ageMs]) => (
              <li key={fixtureId} className="flex items-baseline justify-between gap-2 font-mono text-data-mono">
                <span className="truncate text-on-surface">{fixtureId}</span>
                {Number.isFinite(ageMs) ? (
                  <span className={ageMs > 30_000 ? 'text-error' : 'text-on-surface-variant'}>{ageLabel(ageMs)} ago</span>
                ) : (
                  <span className="text-on-surface-variant">awaiting first odds</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'primary' | 'error' }) {
  return (
    <div>
      <span className="mb-1 block text-label-sm text-outline">{label}</span>
      <span className={`font-mono text-data-mono ${tone === 'primary' ? 'text-primary' : tone === 'error' ? 'text-error' : 'text-on-surface'}`}>{value}</span>
    </div>
  );
}

const STEPS = [
  {
    title: 'Connect your wallet',
    body: 'Open positions are read straight from the venue on-chain. Zygos holds no funds and never sees your keys.',
  },
  {
    title: 'TxLINE prices every market',
    body: 'Multi-bookmaker odds are de-vigged, recency-weighted and outlier-guarded into a fair value the on-chain price has not caught up to yet.',
  },
  {
    title: 'Lock In — one signed transaction',
    body: 'Lock a guaranteed payout with the edge vs fair value stated in plain probability points. Armed rules can do it hands-free on a goal or red card.',
  },
];

/** First-run hero: what the terminal does, in the product's own mechanics — shown until live data arrives. */
export function OnboardingCard({ className }: { className?: string }) {
  return (
    <div className={`rounded-xl border border-outline-variant bg-surface-container-lowest p-4 shadow-sm md:p-6 ${className ?? ''}`}>
      <h3 className="text-title-md text-on-surface">Cash out mid-match, priced by consensus — not by a lagging chain</h3>
      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
        {STEPS.map((step, i) => (
          <div key={step.title} className="rounded-lg border border-surface-container-high bg-surface-container-low p-3">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary-fixed font-mono text-data-mono text-primary">{i + 1}</span>
            <h4 className="mt-2 text-body-md font-semibold text-on-surface">{step.title}</h4>
            <p className="mt-1 text-body-sm leading-4 text-outline">{step.body}</p>
          </div>
        ))}
      </div>
      <p className="mt-4 text-label-sm text-outline">
        Live markets appear automatically while the server is subscribed to TxLINE fixtures — or add a fixture id in the Match Feed.
      </p>
    </div>
  );
}

/** Live match events, incl. §6 odds-discontinuity inferences. */
export function EventTickerCard({ events }: { events: MatchEventDto[] }) {
  return (
    <div className="rounded-xl border border-outline-variant bg-surface-container-lowest p-4 shadow-sm md:p-6">
      <h3 className="mb-4 border-b border-surface-container-high pb-2 text-title-md text-on-surface">Event Ticker</h3>
      {events.length === 0 && <p className="text-body-sm text-outline">No match events yet.</p>}
      <ul className="flex flex-col gap-2">
        {events.slice(0, 8).map((ev) => (
          <li key={ev.packetId} className="flex items-baseline gap-2 text-body-sm">
            <span className="font-mono text-label-sm text-outline">{clockTime(ev.sourceTs)}</span>
            <span className={`font-mono text-data-mono ${ev.type === 'GOAL' ? 'text-primary' : ev.type === 'RED_CARD' ? 'text-error' : 'text-on-surface'}`}>{ev.type}</span>
            <span className="truncate text-outline">
              {ev.team ? `${ev.team} · ` : ''}
              {ev.fixtureId}
              {ev.inferred && <span className="text-on-error-container"> · inferred from odds move</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
