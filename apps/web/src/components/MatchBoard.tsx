'use client';

import { useState } from 'react';
import { ageLabel, pct } from '../lib/format';
import type { HistoryPoint } from '../lib/store';
import type { ConsensusFrame, FeedState } from '../lib/types';
import { lastMovePts } from './DashboardCards';
import { FeedStateBadge } from './FeedStateBadge';

type Filter = 'live' | 'all';

/** Left column: live consensus feed per market, styled per the Stitch Match Feed. Click a card to pin it. */
export function MatchBoard({
  consensus,
  histories,
  feedStates,
  selectedKey,
  onSelect,
}: {
  consensus: Map<string, ConsensusFrame>;
  histories: Map<string, HistoryPoint[]>;
  feedStates: Map<string, FeedState>;
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const all = [...consensus.values()].sort((a, b) => a.fixtureId.localeCompare(b.fixtureId) || a.market.localeCompare(b.market));
  const frames = filter === 'live' ? all.filter((f) => (feedStates.get(f.fixtureId) ?? 'PENDING') === 'LIVE') : all;

  const chip = (id: Filter, label: string) => (
    <button
      onClick={() => setFilter(id)}
      className={`rounded-full px-3 py-1 text-label-sm transition-colors ${
        filter === id ? 'bg-primary-fixed font-medium text-primary' : 'border border-outline-variant text-on-surface-variant hover:bg-surface-container-high'
      }`}
    >
      {label}
    </button>
  );

  return (
    <section className="flex w-full flex-shrink-0 flex-col overflow-hidden border-b border-outline-variant bg-surface md:w-80 md:border-b-0 md:border-r">
      <div className="border-b border-outline-variant px-5 pb-4 pt-6">
        <h3 className="text-title-md text-on-surface">Match Feed</h3>
        <div className="mt-3 flex gap-2">
          {chip('live', 'Live')}
          {chip('all', 'All')}
        </div>
      </div>

      <div className="no-scrollbar flex max-h-72 flex-1 flex-col gap-3 overflow-y-auto p-4 md:max-h-none">
        {all.length === 0 && <p className="px-1 text-body-sm text-outline">No consensus yet — watch a fixture id from the header search to subscribe.</p>}
        {all.length > 0 && frames.length === 0 && <p className="px-1 text-body-sm text-outline">No live markets right now.</p>}
        {frames.map((frame) => {
          const key = `${frame.fixtureId}|${frame.market}`;
          const state = feedStates.get(frame.fixtureId) ?? 'PENDING';
          const selected = key === selectedKey;
          // Lead outcome = the one the consensus currently favors.
          const entries = Object.entries(frame.probs);
          const [leadOutcome, leadProb] = entries.reduce((best, cur) => (cur[1] > best[1] ? cur : best), entries[0] ?? ['—', 0]);
          const move = lastMovePts(histories.get(key) ?? [], leadOutcome);
          return (
            <button
              key={key}
              onClick={() => onSelect(key)}
              className={`rounded-lg border bg-surface-container-lowest p-4 text-left shadow-card transition-colors ${
                selected ? 'border-primary ring-1 ring-primary' : 'border-outline-variant hover:border-primary'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-mono text-data-mono font-semibold text-primary">{frame.fixtureId}</span>
                <span className="whitespace-nowrap text-label-sm text-outline">{ageLabel(Date.now() - frame.asOf)} ago</span>
              </div>
              <div className="mt-2 flex items-baseline justify-between gap-2">
                <span className="font-mono text-headline-sm text-on-surface">{pct(leadProb, 1)}</span>
                <span className={`font-mono text-data-mono ${move !== null && move < 0 ? 'text-error' : 'text-positive'}`}>
                  {move === null ? leadOutcome : `${move > 0 ? '+' : ''}${move.toFixed(2)}pp`}
                </span>
              </div>
              <div className="mt-2 flex items-center justify-between">
                <span className="text-label-sm text-outline">
                  {leadOutcome} lead · {frame.market} · {frame.bookCount} books
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
