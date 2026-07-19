'use client';

import { pct, signedPts, usd } from '../lib/format';
import type { RuleFiredFrame } from '../lib/types';

/**
 * Full-screen signable prompt when an armed rule fires (FR-42): the event,
 * the pre-built plan, and one tap to proceed to signing.
 */
export function RuleFiredOverlay({ frame, onSign, onDismiss }: { frame: RuleFiredFrame; onSign: () => void; onDismiss: () => void }) {
  const plan = frame.preview.plan;
  const trigger = frame.event;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-tertiary/60 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl border-2 border-primary bg-surface-container-lowest p-6 text-center shadow-float">
        <div className="text-3xl">{trigger.type === 'PRICE_CROSS' ? '🎯' : trigger.type === 'GOAL' ? '⚽' : '🟥'}</div>
        <h2 className="mt-2 text-headline-sm text-primary">
          {trigger.type === 'PRICE_CROSS'
            ? `PRICE TARGET — ${trigger.outcome} ${pct(trigger.prob)}`
            : `${trigger.type === 'GOAL' ? 'GOAL' : 'RED CARD'}${trigger.team ? ` — ${trigger.team}` : ''}`}
        </h2>
        <p className="mt-1 text-body-sm text-outline">
          {trigger.type === 'PRICE_CROSS'
            ? `Rule ${frame.template} fired ${frame.latencyMs}ms after TxLINE consensus crossed ${trigger.direction === 'ABOVE' ? 'above' : 'below'} ${pct(trigger.threshold)}`
            : `Rule ${frame.template} fired ${frame.latencyMs}ms after the event`}
          {trigger.type !== 'PRICE_CROSS' && trigger.inferred && <span className="text-primary-fixed"> · inferred from odds move</span>}
        </p>

        {plan.viable ? (
          <>
            <p className="mt-5 text-body-md text-on-surface">
              Lock fills at <span className="font-mono text-data-mono">{pct(plan.impliedExitProb)}</span>{' '}
              <span className={`font-semibold ${plan.edgePts >= 0 ? 'text-primary' : 'text-error'}`}>({signedPts(plan.edgePts)} vs fair)</span>
            </p>
            <p className="mt-1 text-body-md text-on-surface">
              Guaranteed floor <span className="font-mono text-data-mono">{usd(plan.guaranteedFloor)}</span> · upside kept{' '}
              <span className="font-mono text-data-mono">{usd(plan.retainedUpside)}</span>
            </p>
            <button
              onClick={onSign}
              className="mt-6 w-full rounded bg-primary py-3 font-mono text-data-mono text-on-primary transition-colors hover:bg-primary-container"
            >
              Review &amp; sign
            </button>
          </>
        ) : (
          <p className="mt-5 text-body-md text-on-error-container">{plan.reason ?? 'no profitable lock at current prices'}</p>
        )}
        <button onClick={onDismiss} className="mt-3 w-full py-2 text-label-sm text-outline transition-colors hover:text-on-surface">
          Dismiss
        </button>
      </div>
    </div>
  );
}
