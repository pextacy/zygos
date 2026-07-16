import type { FeedState } from '../lib/types';

const STYLES: Record<FeedState, string> = {
  LIVE: 'text-terminal-accent border-terminal-accent',
  DEGRADED: 'text-terminal-warn border-terminal-warn',
  STALE: 'text-terminal-danger border-terminal-danger',
};

/** FR-14: feed health is always visible; STALE additionally locks out Lock-In. */
export function FeedStateBadge({ state }: { state: FeedState }) {
  return <span className={`rounded border px-1 text-[9px] uppercase tracking-wider ${STYLES[state]}`}>{state}</span>;
}
