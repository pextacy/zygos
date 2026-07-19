'use client';

import { useEffect, useState } from 'react';
import { clockTime, ppmPct, signedPts, usd } from '../lib/format';
import { api, explorerTxUrl } from '../lib/server';
import type { LockRecordDto, LockStatsDto } from '../lib/types';
import { TxBadge } from './TxBadge';

/**
 * Lock ledger (extends FR-33): every verified executed lock, persisted
 * server-side — route, guaranteed floor, and the edge vs TxLINE fair value
 * captured at signature time, each traceable to its source packets.
 */
/** CSV field per RFC 4180: quote when the value contains a delimiter, quote, or newline. */
function csvField(value: string | number | null): string {
  const s = value === null ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** Session export (FR-41: in-memory state + optional export — no browser storage). */
function locksToCsv(locks: LockRecordDto[]): string {
  const header = ['executed_at_iso', 'fixture_id', 'market', 'outcome', 'fraction_pct', 'route', 'guaranteed_floor_usd6', 'edge_pts', 'implied_exit_prob', 'source', 'rule_id', 'tx_sig', 'memo_sig', 'packet_ids'];
  const rows = locks.map((l) =>
    [
      new Date(l.executedAt).toISOString(),
      l.fixtureId,
      l.market,
      l.outcome,
      Math.round(l.fractionPpm / 10_000),
      l.route,
      l.guaranteedFloor,
      l.edgePts,
      l.impliedExitProb,
      l.source,
      l.ruleId,
      l.txSig,
      l.memoSig,
      l.packetIds.join(';'),
    ]
      .map(csvField)
      .join(','),
  );
  return [header.join(','), ...rows].join('\n');
}

function downloadCsv(locks: LockRecordDto[], wallet: string): void {
  const blob = new Blob([locksToCsv(locks)], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `zygos-locks-${wallet.slice(0, 8)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function LockLedgerPanel({ wallet, refreshKey }: { wallet: string | null; refreshKey: number }) {
  const [locks, setLocks] = useState<LockRecordDto[]>([]);
  const [stats, setStats] = useState<LockStatsDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!wallet) {
      setLocks([]);
      setStats(null);
      return;
    }
    setLoading(true);
    setError(null);
    api<{ locks: LockRecordDto[]; stats: LockStatsDto }>(`/locks/${wallet}`)
      .then((res) => {
        setLocks(res.locks);
        setStats(res.stats);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [wallet, refreshKey]);

  return (
    <div className="mt-6 rounded-xl border border-outline-variant bg-surface-container-lowest shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-surface-container-high p-4">
        <div className="flex items-center gap-3">
          <h3 className="text-title-md text-on-surface">Lock Ledger</h3>
          {wallet && locks.length > 0 && (
            <button
              onClick={() => downloadCsv(locks, wallet)}
              className="rounded border border-outline-variant px-2 py-0.5 text-label-sm text-on-surface-variant transition-colors hover:border-primary hover:text-primary"
            >
              Export CSV
            </button>
          )}
        </div>
        {stats && stats.count > 0 && (
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-label-sm text-outline">
            <span>
              locks <span className="font-mono text-on-surface">{stats.count}</span>
            </span>
            <span>
              floors secured <span className="font-mono text-on-surface">{usd(stats.totalGuaranteedFloor)}</span>
            </span>
            {stats.avgEdgePts !== null && (
              <span>
                avg edge{' '}
                <span className={`font-mono ${stats.avgEdgePts >= 0 ? 'text-primary' : 'text-error'}`}>{signedPts(stats.avgEdgePts)}</span>
              </span>
            )}
            {stats.avgEdgePts !== null && (
              <span title="locks whose signed preview beat TxLINE fair value">
                beat fair <span className="font-mono text-on-surface">{stats.positiveEdgeCount}/{stats.count}</span>
              </span>
            )}
          </div>
        )}
      </div>

      <div className="overflow-x-auto p-4 pt-0">
        {!wallet && <p className="pt-4 text-body-md text-outline">Connect a wallet to see your executed locks.</p>}
        {wallet && loading && locks.length === 0 && <p className="pt-4 text-body-md text-outline">Loading history…</p>}
        {wallet && error && <p className="pt-4 text-body-md text-error">ledger unavailable: {error}</p>}
        {wallet && !loading && !error && locks.length === 0 && (
          <p className="pt-4 text-body-md text-outline">No executed locks yet — this ledger records every verified lock with the edge it captured.</p>
        )}

        {locks.length > 0 && (
          <table className="w-full min-w-[720px] text-left">
            <thead>
              <tr className="text-label-caps uppercase text-outline">
                <th className="py-2 pr-4 font-semibold">Time</th>
                <th className="py-2 pr-4 font-semibold">Position</th>
                <th className="py-2 pr-4 font-semibold">Fraction</th>
                <th className="py-2 pr-4 font-semibold">Route</th>
                <th className="py-2 pr-4 font-semibold">Floor</th>
                <th className="py-2 pr-4 font-semibold">Edge vs fair</th>
                <th className="py-2 pr-4 font-semibold">Source</th>
                <th className="py-2 font-semibold">Tx / Provenance</th>
              </tr>
            </thead>
            <tbody>
              {locks.map((lock) => (
                <tr key={lock.id} className="border-t border-surface-container-low align-top">
                  <td className="py-2.5 pr-4 font-mono text-data-mono text-on-surface-variant">{clockTime(lock.executedAt)}</td>
                  <td className="py-2.5 pr-4">
                    <span className="font-mono text-data-mono text-on-surface">{lock.fixtureId}</span>
                    <div className="text-label-sm text-outline">
                      {lock.market} · {lock.outcome}
                    </div>
                  </td>
                  <td className="py-2.5 pr-4 font-mono text-data-mono text-on-surface">{ppmPct(lock.fractionPpm)}</td>
                  <td className="py-2.5 pr-4 text-label-sm text-on-surface-variant">
                    {lock.route === 'CLOSE' ? 'direct close' : lock.route === 'HEDGE' ? 'synthetic' : '—'}
                  </td>
                  <td className="py-2.5 pr-4 font-mono text-data-mono text-on-surface">{usd(lock.guaranteedFloor)}</td>
                  <td className="py-2.5 pr-4 font-mono text-data-mono">
                    {lock.edgePts !== null ? (
                      <span className={lock.edgePts >= 0 ? 'text-primary' : 'text-error'}>{signedPts(lock.edgePts)}</span>
                    ) : (
                      <span className="text-outline">—</span>
                    )}
                  </td>
                  <td className="py-2.5 pr-4">
                    <span className="rounded-full border border-outline-variant px-2 py-0.5 text-label-sm text-on-surface-variant">
                      {lock.source === 'DELEGATED' ? 'delegated' : lock.source === 'RULE' ? 'rule' : 'manual'}
                    </span>
                  </td>
                  <td className="py-2.5">
                    {lock.txSig ? (
                      <a
                        href={explorerTxUrl(lock.txSig)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-label-sm text-primary underline decoration-dotted underline-offset-2 hover:text-primary-container"
                      >
                        {lock.txSig.slice(0, 12)}…
                      </a>
                    ) : (
                      <span className="text-label-sm text-outline">—</span>
                    )}
                    {lock.memoSig && (
                      <a
                        href={explorerTxUrl(lock.memoSig)}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="On-chain memo commitment (FR-33)"
                        className="ml-2 font-mono text-label-sm text-secondary underline decoration-dotted underline-offset-2 hover:text-primary"
                      >
                        memo
                      </a>
                    )}
                    {lock.packetIds.length > 0 && <TxBadge packetIds={lock.packetIds} asOf={lock.consensusAsOf ?? lock.executedAt} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
