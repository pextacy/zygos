'use client';

import { clockTime } from '../lib/format';
import type { ActivityEntry } from '../lib/types';

const COLORS: Record<ActivityEntry['kind'], string> = {
  lock: 'text-terminal-accent',
  rule: 'text-terminal-warn',
  feed: 'text-terminal-danger',
  event: 'text-terminal-text',
  error: 'text-terminal-danger',
  info: 'text-terminal-dim',
};

/** Right column (FR-50): locks executed, rules armed/fired, feed health. */
export function ActivityLog({ entries }: { entries: ActivityEntry[] }) {
  return (
    <section className="flex min-h-0 flex-col gap-2">
      <h2 className="text-xs uppercase tracking-widest text-terminal-dim">Activity</h2>
      <div className="flex-1 overflow-y-auto rounded border border-terminal-border bg-terminal-panel p-2">
        {entries.length === 0 && <p className="text-xs text-terminal-dim">quiet…</p>}
        <ul className="space-y-1 text-xs leading-4">
          {entries.map((e) => (
            <li key={e.id} className="break-words">
              <span className="text-terminal-dim">{clockTime(e.ts)}</span> <span className={COLORS[e.kind]}>{e.text}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
