'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { pct, signedPts, usd } from '../lib/format';
import { api } from '../lib/server';
import type { HedgePreviewDto, ValuedPositionDto } from '../lib/types';
import { buildWalletAuth, deserializeTx } from '../lib/wallet';
import { TxBadge } from './TxBadge';

/**
 * Lock-In flow (FR-31/32, T2.5): fraction slider → live preview with the
 * guaranteed-payout matrix and the better/worse-than-fair line → sign.
 * The client independently sanity-checks the matrix (all non-hold rows equal)
 * before enabling the sign button (DOCS.md §9).
 */
export function LockInModal({
  dto,
  prefill,
  onClose,
  onLog,
}: {
  dto: ValuedPositionDto;
  prefill?: { fraction: number; preview: HedgePreviewDto };
  onClose: () => void;
  onLog: (kind: 'lock' | 'error' | 'info', text: string) => void;
}) {
  const { publicKey, sendTransaction, signMessage } = useWallet();
  const { connection } = useConnection();
  const [fraction, setFraction] = useState(prefill?.fraction ?? 1);
  const [preview, setPreview] = useState<HedgePreviewDto | null>(prefill?.preview ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'preview' | 'sign' | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchPreview = useCallback(
    (f: number) => {
      if (!publicKey) return;
      setBusy('preview');
      setError(null);
      api<HedgePreviewDto>('/hedge/preview', {
        method: 'POST',
        body: JSON.stringify({ wallet: publicKey.toBase58(), positionRef: dto.position.positionRef, fraction: f }),
      })
        .then((p) => setPreview(p))
        .catch((err: Error) => {
          setPreview(null);
          setError(err.message);
        })
        .finally(() => setBusy(null));
    },
    [publicKey, dto.position.positionRef],
  );

  useEffect(() => {
    if (prefill && fraction === prefill.fraction) return; // rule-fired previews arrive prebuilt
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchPreview(fraction), 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [fraction, fetchPreview, prefill]);

  // Independent client check: every non-hold row must carry the same floor.
  const matrixConsistent =
    preview !== null &&
    preview.plan.payoutMatrix.length > 1 &&
    preview.plan.payoutMatrix.slice(1).every((r) => r.total === preview.plan.payoutMatrix[1]?.total);

  const signable = preview !== null && preview.plan.viable && preview.simulated && matrixConsistent && busy === null;

  async function executeLock() {
    if (!preview || !publicKey || !signMessage) return;
    setBusy('sign');
    setError(null);
    try {
      const tx = deserializeTx(preview.unsignedTxBase64);
      const signature = await sendTransaction(tx, connection);
      onLog('info', `lock sent: ${signature}`);
      await connection.confirmTransaction(signature, 'confirmed');
      onLog('lock', `lock confirmed on-chain: ${signature}`);

      const auth = await buildWalletAuth('hedge-confirm', publicKey.toBase58(), signMessage);
      const confirm = await api<{ verified: boolean; memoTxBase64: string | null }>('/hedge/confirm', {
        method: 'POST',
        body: JSON.stringify({
          wallet: publicKey.toBase58(),
          positionRef: dto.position.positionRef,
          fraction,
          signature,
          packetIds: preview.packetIds,
          auth,
        }),
      });
      if (!confirm.verified) {
        onLog('error', 'post-verification could not confirm the position change yet — re-check before trusting LOCKED state');
      }
      if (confirm.memoTxBase64) {
        const memoSig = await sendTransaction(deserializeTx(confirm.memoTxBase64), connection);
        onLog('lock', `commitment memo written: ${memoSig}`);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      onLog('error', `lock failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  }

  const plan = preview?.plan ?? null;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded border border-terminal-border bg-terminal-panel p-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-xs uppercase tracking-widest text-terminal-dim">
            Lock In — {dto.position.fixtureId} · {dto.position.outcome}
          </h3>
          <button onClick={onClose} className="text-terminal-dim hover:text-terminal-text">✕</button>
        </div>

        <label className="mt-3 block text-xs text-terminal-dim">
          Lock fraction: <span className="text-terminal-text">{Math.round(fraction * 100)}%</span>
          <input
            type="range"
            min={5}
            max={100}
            step={5}
            value={Math.round(fraction * 100)}
            onChange={(e) => setFraction(Number(e.target.value) / 100)}
            className="mt-1 w-full accent-terminal-accent"
          />
        </label>

        {busy === 'preview' && <p className="mt-3 text-xs text-terminal-dim">quoting…</p>}
        {error && <p className="mt-3 text-xs text-terminal-danger">{error}</p>}

        {plan && !plan.viable && <p className="mt-3 text-xs text-terminal-warn">{plan.reason ?? 'lock not available at current prices'}</p>}

        {plan?.viable && preview && (
          <>
            {/* The product's soul (T2.5): better/worse than fair value, stated plainly. */}
            <p className="mt-3 text-sm">
              This lock fills you at <span className="tabular-nums">{pct(plan.impliedExitProb)}</span> —{' '}
              <span className={plan.edgePts >= 0 ? 'text-terminal-accent' : 'text-terminal-danger'}>
                {signedPts(plan.edgePts)} {plan.edgePts >= 0 ? 'above' : 'below'} TxLINE fair value
              </span>{' '}
              ({pct(plan.impliedExitProb - plan.edgePts / 100)})
              <TxBadge packetIds={preview.packetIds} asOf={preview.consensusAsOf} />
            </p>

            <div className="mt-3 rounded border border-terminal-border">
              <div className="border-b border-terminal-border px-2 py-1 text-[10px] uppercase tracking-widest text-terminal-dim">
                Guaranteed payout matrix · route: {plan.route === 'CLOSE' ? 'direct close' : 'synthetic hedge'}
              </div>
              <table className="w-full text-sm tabular-nums">
                <tbody>
                  {plan.payoutMatrix.map((row) => (
                    <tr key={row.outcome} className="border-b border-terminal-border/50 last:border-0">
                      <td className="px-2 py-1 text-terminal-dim">if {row.outcome}</td>
                      <td className="px-2 py-1 text-right">{usd(row.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] text-terminal-dim">
              <span>floor {usd(plan.guaranteedFloor)}</span>
              <span className="text-right">upside kept {usd(plan.retainedUpside)}</span>
              <span>{plan.route === 'CLOSE' ? `proceeds ${usd(plan.proceeds)}` : `hedge cost ${usd(plan.cost)}`}</span>
              <span className="text-right">{preview.simulated ? 'simulation ✓' : 'NOT SIMULATED'}</span>
            </div>

            {!matrixConsistent && (
              <p className="mt-2 text-xs text-terminal-danger">
                ⚠ payout matrix failed the independent client check — do not sign. Report this.
              </p>
            )}

            <button
              disabled={!signable}
              onClick={executeLock}
              className="mt-3 w-full rounded border border-terminal-accent py-2 text-sm uppercase tracking-widest text-terminal-accent enabled:hover:bg-terminal-accent enabled:hover:text-terminal-bg disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === 'sign' ? 'awaiting wallet…' : `Sign lock (${Math.round(fraction * 100)}%)`}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
