'use client';

import { useState } from 'react';
import { ageLabel, pct } from '../lib/format';
import type { HistoryPoint } from '../lib/store';
import type { ConsensusFrame, FeedState } from '../lib/types';
import { lastMovePts } from './DashboardCards';
import { FeedStateBadge } from './FeedStateBadge';
import { IconPlus } from './Icons';

/** Left column: live consensus feed per market (FR-50). Click a card to pin it in the dashboard. */
export function MatchBoard({
  consensus,
  histories,
  feedStates,
  selectedKey,
  onSelect,
  onWatch,
}: {
  consensus: Map<string, ConsensusFrame>;
  histories: Map<string, HistoryPoint[]>;
  feedStates: Map<string, FeedState>;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  onWatch: (fixtureId: string) => void;
}) {
  const [fixtureInput, setFixtureInput] = useState('');
  const frames = [...consensus.values()].sort((a, b) => a.fixtureId.localeCompare(b.fixtureId) || a.market.localeCompare(b.market));

  return (
    <section className="flex w-full flex-shrink-0 flex-col overflow-hidden border-b border-outline-variant bg-surface md:w-80 md:border-b-0 md:border-r">
      <div className="border-b border-outline-variant p-4 md:p-6">
        <h3 className="text-title-md text-on-surface">Match Feed</h3>
        <form
          className="mt-2 flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (fixtureInput.trim()) onWatch(fixtureInput.trim());
            setFixtureInput('');
          }}
        >
          <input
            value={fixtureInput}
            onChange={(e) => setFixtureInput(e.target.value)}
            placeholder="Watch fixture id…"
            className="w-full rounded border border-outline-variant bg-surface-container-lowest p-2 font-mono text-data-mono text-on-surface placeholder:text-outline focus:border-primary"
          />
          <button type="submit" aria-label="Watch fixture" className="rounded border border-outline-variant px-2 text-outline transition-colors hover:border-primary hover:text-primary">
            <IconPlus className="h-4 w-4" />
          </button>
        </form>
      </div>

      <div className="no-scrollbar flex max-h-72 flex-1 flex-col gap-2 overflow-y-auto p-2 md:max-h-none">
        {frames.length === 0 && <p className="p-2 text-body-sm text-outline">No consensus yet — watch a fixture to subscribe.</p>}
        {frames.map((frame) => {
          const key = `${frame.fixtureId}|${frame.market}`;
          const state = feedStates.get(frame.fixtureId) ?? 'STALE';
          const selected = key === selectedKey;
          return (
            <button
              key={key}
              onClick={() => onSelect(key)}
              className={`group rounded-lg border bg-surface-container-lowest p-2 text-left transition-colors ${selected ? 'border-primary' : 'border-outline-variant hover:border-primary'}`}
            >
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="truncate font-mono text-data-mono text-primary">{frame.fixtureId}</span>
                <span className="whitespace-nowrap text-label-sm text-outline">{ageLabel(Date.now() - frame.asOf)} ago</span>
              </div>
              <div className="flex flex-wrap gap-x-3 font-mono text-data-mono text-on-surface">
                {Object.entries(frame.probs).map(([o, p]) => {
                  const move = lastMovePts(histories.get(key) ?? [], o);
                  return (
                    <span key={o}>
                      {o} {pct(p)}
                      {move !== null && Math.abs(move) >= 0.05 && (
                        <span className={`ml-0.5 text-[10px] ${move > 0 ? 'text-primary' : 'text-error'}`} title={`${move > 0 ? '+' : ''}${move.toFixed(1)}pp since previous update`}>
                          {move > 0 ? '▲' : '▼'}
                        </span>
                      )}
                    </span>
                  );
                })}
              </div>
              <div className="mt-2 flex items-center justify-between">
                <span className="text-label-sm text-outline">
                  {frame.market} · {frame.bookCount} books
                  {frame.confidence === 'LOW_CONFIDENCE' && <span className="text-on-error-container"> · low confidence</span>}
                </span>
                <FeedStateBadge state={state} />
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
