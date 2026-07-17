'use client';

import { useState } from 'react';
import { clockTime, pct } from '../lib/format';
import { api } from '../lib/server';
import type { ConsensusFrame } from '../lib/types';
import { IconClose } from './Icons';

interface OddsVerification {
  verified: boolean;
  rootsAccount: string;
  programId: string;
  epochDay: number;
}

/**
 * Fair-value explainer (FR-51 / US-5): how the consensus price is built.
 * Per-book odds rows join once live vocabulary confirms the per-book feed
 * shape; the method walkthrough and provenance are fully real today.
 */
export function ExplainerPanel({ frame, onClose }: { frame: ConsensusFrame; onClose: () => void }) {
  const [verify, setVerify] = useState<{ state: 'idle' | 'busy' | 'done' | 'error'; result?: OddsVerification; error?: string }>({ state: 'idle' });

  async function verifyOnChain() {
    const packetId = frame.packetIds[0];
    if (!packetId) return;
    setVerify({ state: 'busy' });
    try {
      const result = await api<OddsVerification>('/verify/odds', { method: 'POST', body: JSON.stringify({ packetId }) });
      setVerify({ state: 'done', result });
    } catch (err) {
      setVerify({ state: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-tertiary/40 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="max-h-[80vh] w-full max-w-md overflow-y-auto rounded-xl border border-outline-variant bg-surface-container-lowest p-5 shadow-float" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-surface-container-high pb-3">
          <h3 className="text-title-md text-on-surface">Why this price?</h3>
          <button onClick={onClose} aria-label="Close" className="rounded-full p-1 text-outline transition-colors hover:bg-surface-container-high hover:text-on-surface">
            <IconClose className="h-4 w-4" />
          </button>
        </div>

        <p className="mt-3 text-body-sm leading-5 text-on-surface-variant">
          Fair value comes from TxLINE&apos;s multi-bookmaker feed, not from the (laggy) on-chain price:
        </p>
        <ol className="mt-2 list-decimal space-y-1.5 pl-4 text-body-sm leading-5 text-on-surface-variant">
          <li>Each bookmaker&apos;s decimal odds are inverted to raw probabilities (q = 1/odds), which sum to more than 1 — the bookmaker margin (&quot;vig&quot;).</li>
          <li>Each book is de-vigged multiplicatively: p = q / Σq, so its probabilities sum to exactly 1.</li>
          <li>Books are blended with recency weights (w = e^(−age/20s)); books older than 60s drop out; outliers &gt;10 pts from the median are excluded.</li>
        </ol>

        <div className="mt-4 rounded-lg border border-outline-variant bg-surface-container-low p-3">
          <div className="text-label-caps uppercase text-outline">Current consensus — {frame.market}</div>
          <div className="mt-2 flex flex-wrap gap-x-4 font-mono text-data-mono text-on-surface">
            {Object.entries(frame.probs).map(([o, p]) => (
              <span key={o}>
                {o} {pct(p, 2)}
              </span>
            ))}
          </div>
          <div className="mt-2 text-label-sm text-outline">
            {frame.bookCount} contributing books · as of {clockTime(frame.asOf)}
            {frame.confidence === 'LOW_CONFIDENCE' && <span className="text-on-error-container"> · low confidence (&lt;2 books)</span>}
          </div>
        </div>

        <div className="mt-4 text-label-sm leading-4 text-outline">
          <div className="text-label-caps uppercase">Source packets (TxLINE)</div>
          <ul className="mt-1 break-all font-mono">
            {frame.packetIds.slice(0, 8).map((id) => (
              <li key={id}>{id}</li>
            ))}
            {frame.packetIds.length > 8 && <li>… +{frame.packetIds.length - 8} more</li>}
          </ul>
          <p className="mt-2">Every packet is hashed into the audit log and anchored by TxLINE on Solana — this price is reproducible from source data.</p>

          <div className="mt-3">
            {verify.state === 'idle' && (
              <button
                onClick={verifyOnChain}
                className="rounded border border-outline-variant px-3 py-1.5 text-label-sm text-on-surface-variant transition-colors hover:bg-surface-container-high"
              >
                Verify newest packet on-chain
              </button>
            )}
            {verify.state === 'busy' && <span>Validating Merkle proof against the on-chain root…</span>}
            {verify.state === 'done' && verify.result && (
              <span className={verify.result.verified ? 'text-primary' : 'text-error'}>
                {verify.result.verified ? '✓ proven against on-chain root' : '✗ proof REJECTED by the oracle program'} · roots account{' '}
                <span className="break-all font-mono">{verify.result.rootsAccount}</span> (epoch day {verify.result.epochDay})
              </span>
            )}
            {verify.state === 'error' && <span className="text-on-error-container">Verification unavailable: {verify.error}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
