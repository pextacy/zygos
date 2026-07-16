'use client';

import { useState } from 'react';
import { clockTime, pct } from '../lib/format';
import { api } from '../lib/server';
import type { ConsensusFrame } from '../lib/types';

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
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="max-h-[80vh] w-full max-w-md overflow-y-auto rounded border border-terminal-border bg-terminal-panel p-4 text-sm" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-xs uppercase tracking-widest text-terminal-dim">Why this price?</h3>
          <button onClick={onClose} className="text-terminal-dim hover:text-terminal-text">✕</button>
        </div>

        <p className="mt-2 text-xs leading-5 text-terminal-dim">
          Fair value comes from TxLINE&apos;s multi-bookmaker feed, not from the (laggy) on-chain price:
        </p>
        <ol className="mt-2 list-decimal space-y-1 pl-4 text-xs leading-5">
          <li>Each bookmaker&apos;s decimal odds are inverted to raw probabilities (q = 1/odds), which sum to more than 1 — the bookmaker margin (&quot;vig&quot;).</li>
          <li>Each book is de-vigged multiplicatively: p = q / Σq, so its probabilities sum to exactly 1.</li>
          <li>Books are blended with recency weights (w = e^(−age/20s)); books older than 60s drop out; outliers &gt;10 pts from the median are excluded.</li>
        </ol>

        <div className="mt-3 rounded border border-terminal-border p-2">
          <div className="text-[10px] uppercase tracking-widest text-terminal-dim">Current consensus — {frame.market}</div>
          <div className="mt-1 flex flex-wrap gap-x-4 text-sm tabular-nums">
            {Object.entries(frame.probs).map(([o, p]) => (
              <span key={o}>
                {o} {pct(p, 2)}
              </span>
            ))}
          </div>
          <div className="mt-1 text-[10px] text-terminal-dim">
            {frame.bookCount} contributing books · as of {clockTime(frame.asOf)}
            {frame.confidence === 'LOW_CONFIDENCE' && <span className="text-terminal-warn"> · LOW CONFIDENCE (&lt;2 books)</span>}
          </div>
        </div>

        <div className="mt-3 text-[10px] leading-4 text-terminal-dim">
          <div className="uppercase tracking-widest">Source packets (TxLINE)</div>
          <ul className="mt-1 break-all">
            {frame.packetIds.slice(0, 8).map((id) => (
              <li key={id}>{id}</li>
            ))}
            {frame.packetIds.length > 8 && <li>… +{frame.packetIds.length - 8} more</li>}
          </ul>
          <p className="mt-2">Every packet is hashed into the audit log and anchored by TxLINE on Solana — this price is reproducible from source data.</p>

          <div className="mt-2">
            {verify.state === 'idle' && (
              <button onClick={verifyOnChain} className="rounded border border-terminal-border px-2 py-1 uppercase tracking-widest hover:text-terminal-text">
                verify newest packet on-chain
              </button>
            )}
            {verify.state === 'busy' && <span>validating Merkle proof against the on-chain root…</span>}
            {verify.state === 'done' && verify.result && (
              <span className={verify.result.verified ? 'text-terminal-accent' : 'text-terminal-danger'}>
                {verify.result.verified ? '✓ proven against on-chain root' : '✗ proof REJECTED by the oracle program'} · roots account{' '}
                <span className="break-all">{verify.result.rootsAccount}</span> (epoch day {verify.result.epochDay})
              </span>
            )}
            {verify.state === 'error' && <span className="text-terminal-warn">verification unavailable: {verify.error}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
