'use client';

import { clockTime } from '../lib/format';
import { explorerTxUrl } from '../lib/server';
import type { ActivityEntry } from '../lib/types';

const COLORS: Record<ActivityEntry['kind'], string> = {
  lock: 'text-primary',
  rule: 'text-on-secondary-container',
  feed: 'text-on-error-container',
  event: 'text-on-surface',
  error: 'text-error',
  info: 'text-outline',
};

// Solana signatures are 86–88 base58 chars; linkify them to the explorer.
const SIGNATURE_RE = /([1-9A-HJ-NP-Za-km-z]{80,90})/g;

function withTxLinks(text: string): React.ReactNode[] {
  return text.split(SIGNATURE_RE).map((part, i) =>
    i % 2 === 1 ? (
      <a
        key={i}
        href={explorerTxUrl(part)}
        target="_blank"
        rel="noopener noreferrer"
        className="font-mono underline decoration-dotted underline-offset-2 hover:text-primary-container"
        title={part}
      >
        {part.slice(0, 8)}…{part.slice(-8)}
      </a>
    ) : (
      part
    ),
  );
}

/** Right rail: locks executed, rules armed/fired, feed health (FR-50). */
export function ActivityLog({ entries }: { entries: ActivityEntry[] }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-t border-outline-variant p-4">
        <h3 className="text-title-md text-on-surface">Activity</h3>
      </div>
      <div className="no-scrollbar max-h-72 flex-1 overflow-y-auto bg-surface-container-low p-3 md:max-h-none">
        {entries.length === 0 && <p className="text-body-sm text-outline">No activity yet.</p>}
        <ul className="flex flex-col gap-1.5">
          {entries.map((e) => (
            <li key={e.id} className="break-words text-body-sm leading-4">
              <span className="font-mono text-label-sm text-outline">{clockTime(e.ts)}</span> <span className={COLORS[e.kind]}>{withTxLinks(e.text)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
