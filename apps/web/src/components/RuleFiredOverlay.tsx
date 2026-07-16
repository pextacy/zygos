'use client';

import { pct, signedPts, usd } from '../lib/format';
import type { RuleFiredFrame } from '../lib/types';

/**
 * Full-screen signable prompt when an armed rule fires (FR-42): the event,
 * the pre-built plan, and one tap to proceed to signing.
 */
export function RuleFiredOverlay({ frame, onSign, onDismiss }: { frame: RuleFiredFrame; onSign: () => void; onDismiss: () => void }) {
  const plan = frame.preview.plan;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4">
      <div className="w-full max-w-md rounded border-2 border-terminal-accent bg-terminal-panel p-5 text-center">
        <div className="text-3xl">{frame.event.type === 'GOAL' ? '⚽' : '🟥'}</div>
        <h2 className="mt-2 text-lg uppercase tracking-widest text-terminal-accent">
          {frame.event.type === 'GOAL' ? 'GOAL' : 'RED CARD'}
          {frame.event.team ? ` — ${frame.event.team}` : ''}
        </h2>
        <p className="mt-1 text-xs text-terminal-dim">
          rule {frame.template} fired {frame.latencyMs}ms after the event
          {frame.event.inferred && <span className="text-terminal-warn"> · ⚡ inferred from odds move</span>}
        </p>

        {plan.viable ? (
          <>
            <p className="mt-4 text-sm">
              Lock fills at <span className="tabular-nums">{pct(plan.impliedExitProb)}</span>{' '}
              <span className={plan.edgePts >= 0 ? 'text-terminal-accent' : 'text-terminal-danger'}>({signedPts(plan.edgePts)} vs fair)</span>
            </p>
            <p className="mt-1 text-sm">
              guaranteed floor <span className="tabular-nums">{usd(plan.guaranteedFloor)}</span> · upside kept{' '}
              <span className="tabular-nums">{usd(plan.retainedUpside)}</span>
            </p>
            <button
              onClick={onSign}
              className="mt-5 w-full rounded border border-terminal-accent py-3 text-base uppercase tracking-widest text-terminal-accent hover:bg-terminal-accent hover:text-terminal-bg"
            >
              Review &amp; sign
            </button>
          </>
        ) : (
          <p className="mt-4 text-sm text-terminal-warn">{plan.reason ?? 'no profitable lock at current prices'}</p>
        )}
        <button onClick={onDismiss} className="mt-2 w-full py-2 text-xs uppercase tracking-widest text-terminal-dim hover:text-terminal-text">
          Dismiss
        </button>
      </div>
    </div>
  );
}
