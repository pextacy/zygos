'use client';

import { useState } from 'react';
import { ageLabel, clockTime, pct } from '../lib/format';
import type { ConsensusFrame, FeedState, MatchEventDto } from '../lib/types';
import { ExplainerPanel } from './ExplainerPanel';
import { FeedStateBadge } from './FeedStateBadge';
import { TxBadge } from './TxBadge';

/** Left column (FR-50): live consensus per market + event ticker. */
export function MatchBoard({
  consensus,
  feedStates,
  events,
  onWatch,
}: {
  consensus: Map<string, ConsensusFrame>;
  feedStates: Map<string, FeedState>;
  events: MatchEventDto[];
  onWatch: (fixtureId: string) => void;
}) {
  const [fixtureInput, setFixtureInput] = useState('');
  const [explain, setExplain] = useState<ConsensusFrame | null>(null);
  const frames = [...consensus.values()].sort((a, b) => a.fixtureId.localeCompare(b.fixtureId) || a.market.localeCompare(b.market));

  return (
    <section className="flex min-h-0 flex-col gap-2">
      <h2 className="text-xs uppercase tracking-widest text-terminal-dim">Match board</h2>

      <form
        className="flex gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (fixtureInput.trim()) onWatch(fixtureInput.trim());
          setFixtureInput('');
        }}
      >
        <input
          value={fixtureInput}
          onChange={(e) => setFixtureInput(e.target.value)}
          placeholder="watch fixture id…"
          className="w-full rounded border border-terminal-border bg-terminal-panel px-2 py-1 text-xs outline-none placeholder:text-terminal-dim"
        />
        <button type="submit" className="rounded border border-terminal-border px-2 text-xs text-terminal-dim hover:text-terminal-text">
          +
        </button>
      </form>

      <div className="flex-1 space-y-2 overflow-y-auto">
        {frames.length === 0 && <p className="text-xs text-terminal-dim">No consensus yet — subscribe to a fixture.</p>}
        {frames.map((frame) => {
          const state = feedStates.get(frame.fixtureId) ?? 'STALE';
          return (
            <div key={`${frame.fixtureId}|${frame.market}`} className="rounded border border-terminal-border bg-terminal-panel p-2">
              <div className="flex items-center justify-between text-[10px] text-terminal-dim">
                <span>
                  {frame.fixtureId} · {frame.market}
                </span>
                <FeedStateBadge state={state} />
              </div>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                {Object.entries(frame.probs).map(([outcome, p]) => (
                  <span key={outcome}>
                    <span className="text-terminal-dim">{outcome}</span> <span className="tabular-nums">{pct(p)}</span>
                  </span>
                ))}
                <TxBadge packetIds={frame.packetIds} asOf={frame.asOf} />
              </div>
              <div className="mt-1 flex items-center justify-between text-[10px] text-terminal-dim">
                <span>
                  {frame.bookCount} books{frame.confidence === 'LOW_CONFIDENCE' ? ' · LOW CONFIDENCE' : ''} · {ageLabel(Date.now() - frame.asOf)} old
                </span>
                <button onClick={() => setExplain(frame)} className="underline decoration-dotted hover:text-terminal-text">
                  why this price?
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="max-h-40 overflow-y-auto rounded border border-terminal-border bg-terminal-panel p-2">
        <h3 className="text-[10px] uppercase tracking-widest text-terminal-dim">Event ticker</h3>
        {events.length === 0 && <p className="mt-1 text-xs text-terminal-dim">no events</p>}
        <ul className="mt-1 space-y-0.5 text-xs">
          {events.slice(0, 12).map((ev) => (
            <li key={ev.packetId}>
              <span className="text-terminal-dim">{clockTime(ev.sourceTs)}</span>{' '}
              <span className={ev.type === 'GOAL' ? 'text-terminal-accent' : ev.type === 'RED_CARD' ? 'text-terminal-danger' : ''}>{ev.type}</span>
              {ev.team ? ` ${ev.team}` : ''} · {ev.fixtureId}
              {ev.inferred && <span className="text-terminal-warn"> ⚡ inferred from odds move</span>}
            </li>
          ))}
        </ul>
      </div>

      {explain && <ExplainerPanel frame={explain} onClose={() => setExplain(null)} />}
    </section>
  );
}
