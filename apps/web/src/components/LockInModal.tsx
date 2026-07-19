'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { pct, signedPts, usd } from '../lib/format';
import { api } from '../lib/server';
import type { HedgePreviewDto, ValuedPositionDto } from '../lib/types';
import { buildWalletAuth, deserializeTx } from '../lib/wallet';
import { IconClose } from './Icons';
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
  prefill?: { fraction: number; preview: HedgePreviewDto; ruleId?: string };
  onClose: (locked?: boolean) => void;
  onLog: (kind: 'lock' | 'error' | 'info', text: string) => void;
}) {
  const { publicKey, sendTransaction, signMessage } = useWallet();
  const { connection } = useConnection();
  const [fraction, setFraction] = useState(prefill?.fraction ?? 1);
  const [preview, setPreview] = useState<HedgePreviewDto | null>(prefill?.preview ?? null);
  /** The fraction the current preview was quoted at — signing is only allowed when it matches the slider. */
  const [quotedFraction, setQuotedFraction] = useState<number | null>(prefill?.fraction ?? null);
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
        .then((p) => {
          setPreview(p);
          setQuotedFraction(f);
        })
        .catch((err: Error) => {
          setPreview(null);
          setQuotedFraction(null);
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

  // quotedFraction must match the slider: during the debounce window the old
  // preview is still on screen — signing it would execute a different fraction
  // than displayed (and record the wrong one in the ledger).
  const signable = preview !== null && preview.plan.viable && preview.simulated && matrixConsistent && busy === null && quotedFraction === fraction;

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
      const confirm = await api<{ verified: boolean; memoTxBase64: string | null; lockId: string | null }>('/hedge/confirm', {
        method: 'POST',
        body: JSON.stringify({
          wallet: publicKey.toBase58(),
          positionRef: dto.position.positionRef,
          fraction,
          signature,
          packetIds: preview.packetIds,
          previewId: preview.previewId, // ledger records the server-built plan behind this signature
          ...(prefill?.ruleId !== undefined ? { ruleId: prefill.ruleId } : {}),
          auth,
        }),
      });
      if (!confirm.verified) {
        onLog('error', 'post-verification could not confirm the position change yet — re-check before trusting LOCKED state');
      }
      if (confirm.memoTxBase64) {
        const memoSig = await sendTransaction(deserializeTx(confirm.memoTxBase64), connection);
        onLog('lock', `commitment memo written: ${memoSig}`);
        // Complete the FR-33 audit chain: persist the memo signature on the ledger row.
        if (confirm.lockId) {
          try {
            const memoAuth = await buildWalletAuth('locks-memo', publicKey.toBase58(), signMessage);
            await api(`/locks/${confirm.lockId}/memo`, { method: 'PATCH', body: JSON.stringify({ memoSig, auth: memoAuth }) });
          } catch (memoErr) {
            onLog('error', `memo written on-chain but not attached to the ledger row: ${memoErr instanceof Error ? memoErr.message : memoErr}`);
          }
        }
      }
      onClose(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      onLog('error', `lock failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  }

  const plan = preview?.plan ?? null;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-tertiary/40 p-4 backdrop-blur-sm" onClick={() => onClose()}>
      <div className="w-full max-w-md rounded-xl border border-outline-variant bg-surface-container-lowest p-5 shadow-float" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-surface-container-high pb-3">
          <h3 className="text-title-md text-on-surface">Lock In</h3>
          <button onClick={() => onClose()} aria-label="Close" className="rounded-full p-1 text-outline transition-colors hover:bg-surface-container-high hover:text-on-surface">
            <IconClose className="h-4 w-4" />
          </button>
        </div>
        <p className="mt-2 font-mono text-label-sm text-outline">
          {dto.position.fixtureId} · {dto.position.market} · {dto.position.outcome}
        </p>

        <label className="mt-4 block text-label-sm text-outline">
          Lock fraction: <span className="font-mono text-data-mono text-on-surface">{Math.round(fraction * 100)}%</span>
          <input
            type="range"
            min={5}
            max={100}
            step={5}
            value={Math.round(fraction * 100)}
            onChange={(e) => setFraction(Number(e.target.value) / 100)}
            className="mt-2 w-full accent-primary"
          />
        </label>

        {busy === 'preview' && <p className="mt-3 text-body-sm text-outline">Quoting…</p>}
        {error && <p className="mt-3 text-body-sm text-error">{error}</p>}

        {plan && !plan.viable && <p className="mt-3 text-body-sm text-on-error-container">{plan.reason ?? 'lock not available at current prices'}</p>}

        {plan?.viable && preview && (
          <>
            {/* The product's soul (T2.5): better/worse than fair value, stated plainly. */}
            <p className="mt-4 text-body-md text-on-surface">
              This lock fills you at <span className="font-mono text-data-mono">{pct(plan.impliedExitProb)}</span> —{' '}
              <span className={`font-semibold ${plan.edgePts >= 0 ? 'text-primary' : 'text-error'}`}>
                {signedPts(plan.edgePts)} {plan.edgePts >= 0 ? 'above' : 'below'} TxLINE fair value
              </span>{' '}
              ({pct(plan.impliedExitProb - plan.edgePts / 100)})
              <TxBadge packetIds={preview.packetIds} asOf={preview.consensusAsOf} />
            </p>

            <div className="mt-4 overflow-hidden rounded-lg border border-outline-variant">
              <div className="border-b border-surface-container-high bg-surface-container-low px-3 py-2 text-label-caps uppercase text-outline">
                Guaranteed payout · {plan.route === 'CLOSE' ? 'direct close' : 'synthetic hedge'}
              </div>
              <table className="w-full font-mono text-data-mono">
                <tbody>
                  {plan.payoutMatrix.map((row) => (
                    <tr key={row.outcome} className="border-b border-surface-container-low last:border-0">
                      <td className="px-3 py-1.5 text-on-surface-variant">if {row.outcome}</td>
                      <td className="px-3 py-1.5 text-right text-on-surface">{usd(row.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2 text-label-sm text-outline">
              <span>Floor {usd(plan.guaranteedFloor)}</span>
              <span className="text-right">Upside kept {usd(plan.retainedUpside)}</span>
              <span>{plan.route === 'CLOSE' ? `Proceeds ${usd(plan.proceeds)}` : `Hedge cost ${usd(plan.cost)}`}</span>
              <span className={`text-right ${preview.simulated ? 'text-primary' : 'text-error'}`}>{preview.simulated ? 'Simulation ✓' : 'NOT SIMULATED'}</span>
            </div>

            {!matrixConsistent && (
              <p className="mt-3 rounded-lg bg-error-container px-3 py-2 text-body-sm text-on-error-container">
                Payout matrix failed the independent client check — do not sign. Report this.
              </p>
            )}

            <button
              disabled={!signable}
              onClick={executeLock}
              className="mt-4 w-full rounded bg-primary py-2.5 font-mono text-data-mono text-on-primary transition-colors enabled:hover:bg-primary-container disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === 'sign' ? 'Awaiting wallet…' : `Sign lock (${Math.round(fraction * 100)}%)`}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
