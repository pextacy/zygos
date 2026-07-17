import type { FeedState } from '../lib/types';

const STYLES: Record<FeedState, string> = {
  LIVE: 'bg-secondary-container text-on-secondary-container',
  DEGRADED: 'bg-surface-variant text-secondary',
  STALE: 'bg-error-container text-on-error-container',
};

/** FR-14: feed health is always visible; STALE additionally locks out Lock-In. */
export function FeedStateBadge({ state }: { state: FeedState }) {
  return <span className={`rounded-full px-2 py-0.5 font-sans text-label-sm ${STYLES[state]}`}>{state === 'LIVE' ? 'Live' : state === 'DEGRADED' ? 'Degraded' : 'Stale'}</span>;
}
