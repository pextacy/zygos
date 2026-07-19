'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { clockTime } from '../lib/format';
import { api } from '../lib/server';
import type { BindingCandidatesDto, MarketBindingDto } from '../lib/types';
import { buildWalletAuth } from '../lib/wallet';

/**
 * Market binding registry: maps venue marketIds onto TxLINE fixtures so
 * positions on them can be valued. Candidates (unbound marketIds, tracked
 * fixtures/markets) all come from live session data — nothing is invented.
 * Writes are wallet-signed; deployments can restrict them via ADMIN_WALLETS.
 */

/** Mirror of OUTCOMES_BY_KIND in packages/core/src/consensus.ts — the web talks to the server over HTTP only and cannot import that package. Keep in sync. */
const OUTCOMES_BY_MARKET = (market: string): string[] => (market.startsWith('TOTAL') ? ['OVER', 'UNDER'] : ['HOME', 'DRAW', 'AWAY']);

export function MarketBindingsPanel({ onLog }: { onLog: (kind: 'info' | 'error', text: string) => void }) {
  const { publicKey, signMessage } = useWallet();
  const wallet = publicKey?.toBase58() ?? null;

  const [bindings, setBindings] = useState<MarketBindingDto[]>([]);
  const [adminRestricted, setAdminRestricted] = useState(false);
  const [candidates, setCandidates] = useState<BindingCandidatesDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [marketId, setMarketId] = useState('');
  const [fixtureId, setFixtureId] = useState('');
  const [market, setMarket] = useState('1X2');
  const [yesOutcome, setYesOutcome] = useState('HOME');
  const [busy, setBusy] = useState<string | null>(null); // 'save' | marketId being deleted

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      api<{ bindings: MarketBindingDto[]; adminRestricted: boolean }>('/bindings'),
      api<BindingCandidatesDto>('/bindings/candidates'),
    ])
      .then(([b, c]) => {
        setBindings(b.bindings);
        setAdminRestricted(b.adminRestricted);
        setCandidates(c);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const marketOptions = useMemo(() => {
    const fromFeed = candidates?.markets.filter((m) => m.fixtureId === fixtureId).map((m) => m.market) ?? [];
    return [...new Set(['1X2', ...fromFeed])];
  }, [candidates, fixtureId]);

  const outcomes = OUTCOMES_BY_MARKET(market);
  // If the market kind changed under the selection, snap to its first valid outcome.
  const effectiveYesOutcome = outcomes.includes(yesOutcome) ? yesOutcome : outcomes[0]!;

  const save = useCallback(async () => {
    if (!wallet || !signMessage) {
      onLog('error', 'wallet cannot sign messages — connect a signing wallet to edit bindings');
      return;
    }
    setBusy('save');
    try {
      const auth = await buildWalletAuth('bindings-upsert', wallet, signMessage);
      await api(`/bindings/${encodeURIComponent(marketId.trim())}`, {
        method: 'PUT',
        body: JSON.stringify({ fixtureId: fixtureId.trim(), market, yesOutcome: effectiveYesOutcome, auth }),
      });
      onLog('info', `binding saved: ${marketId.trim()} → ${fixtureId.trim()} ${market} YES=${effectiveYesOutcome}`);
      setMarketId('');
      setFormOpen(false);
      refresh();
    } catch (err) {
      onLog('error', `save binding: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  }, [wallet, signMessage, marketId, fixtureId, market, effectiveYesOutcome, onLog, refresh]);

  const remove = useCallback(
    async (binding: MarketBindingDto) => {
      if (!wallet || !signMessage) {
        onLog('error', 'wallet cannot sign messages — connect a signing wallet to edit bindings');
        return;
      }
      setBusy(binding.marketId);
      try {
        const auth = await buildWalletAuth('bindings-delete', wallet, signMessage);
        await api(`/bindings/${encodeURIComponent(binding.marketId)}`, { method: 'DELETE', body: JSON.stringify({ auth }) });
        onLog('info', `binding removed: ${binding.marketId}`);
        refresh();
      } catch (err) {
        onLog('error', `remove binding: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setBusy(null);
      }
    },
    [wallet, signMessage, onLog, refresh],
  );

  const saveDisabled = busy !== null || marketId.trim().length === 0 || fixtureId.trim().length === 0;

  return (
    <div className="mt-6 rounded-xl border border-outline-variant bg-surface-container-lowest shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-surface-container-high p-4">
        <div>
          <h3 className="text-title-md text-on-surface">Market Bindings</h3>
          <p className="text-label-sm text-outline">
            Venue market → TxLINE fixture mapping. Unbound positions show as UNMAPPED until bound here.
            {adminRestricted && ' Writes restricted to admin wallets on this deployment.'}
          </p>
        </div>
        <button
          onClick={() => setFormOpen((v) => !v)}
          className="rounded-lg border border-outline-variant px-3 py-1.5 text-label-sm text-on-surface-variant transition-colors hover:border-primary hover:text-primary"
        >
          {formOpen ? 'Close' : 'Add binding'}
        </button>
      </div>

      {formOpen && (
        <div className="border-b border-surface-container-high bg-surface-container-low p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="flex flex-col gap-1">
              <span className="text-label-caps uppercase text-outline">Venue market id</span>
              <input
                value={marketId}
                onChange={(e) => setMarketId(e.target.value)}
                list="zygos-unmapped-markets"
                placeholder="Jupiter marketId"
                className="rounded border border-outline-variant bg-surface-container-lowest px-2 py-1.5 font-mono text-data-mono text-on-surface outline-none focus:border-primary"
              />
              <datalist id="zygos-unmapped-markets">
                {candidates?.unmappedMarketIds.map((id) => <option key={id} value={id} />)}
              </datalist>
              {candidates && candidates.unmappedMarketIds.length > 0 && (
                <span className="text-label-sm text-outline">{candidates.unmappedMarketIds.length} unbound seen on positions</span>
              )}
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-label-caps uppercase text-outline">TxLINE fixture</span>
              <input
                value={fixtureId}
                onChange={(e) => setFixtureId(e.target.value)}
                list="zygos-fixtures"
                placeholder="fixtureId"
                className="rounded border border-outline-variant bg-surface-container-lowest px-2 py-1.5 font-mono text-data-mono text-on-surface outline-none focus:border-primary"
              />
              <datalist id="zygos-fixtures">
                {candidates?.fixtures.map((id) => <option key={id} value={id} />)}
              </datalist>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-label-caps uppercase text-outline">Market</span>
              <select
                value={market}
                onChange={(e) => setMarket(e.target.value)}
                className="rounded border border-outline-variant bg-surface-container-lowest px-2 py-1.5 font-mono text-data-mono text-on-surface outline-none focus:border-primary"
              >
                {marketOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-label-caps uppercase text-outline">YES contract =</span>
              <select
                value={effectiveYesOutcome}
                onChange={(e) => setYesOutcome(e.target.value)}
                className="rounded border border-outline-variant bg-surface-container-lowest px-2 py-1.5 font-mono text-data-mono text-on-surface outline-none focus:border-primary"
              >
                {outcomes.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={save}
              disabled={saveDisabled}
              className="rounded-lg bg-primary px-4 py-1.5 text-label-sm text-on-primary transition-opacity disabled:opacity-40"
            >
              {busy === 'save' ? 'Signing…' : 'Sign & save'}
            </button>
            {!wallet && <span className="text-label-sm text-outline">Connect a wallet — writes are signature-authenticated.</span>}
          </div>
        </div>
      )}

      <div className="overflow-x-auto p-4 pt-0">
        {loading && bindings.length === 0 && <p className="pt-4 text-body-md text-outline">Loading bindings…</p>}
        {error && <p className="pt-4 text-body-md text-error">bindings unavailable: {error}</p>}
        {!loading && !error && bindings.length === 0 && (
          <p className="pt-4 text-body-md text-outline">No bindings yet — positions on venue markets stay UNMAPPED (never mis-valued) until bound.</p>
        )}

        {bindings.length > 0 && (
          <table className="w-full min-w-[680px] text-left">
            <thead>
              <tr className="text-label-caps uppercase text-outline">
                <th className="py-2 pr-4 font-semibold">Venue market</th>
                <th className="py-2 pr-4 font-semibold">Fixture</th>
                <th className="py-2 pr-4 font-semibold">Market</th>
                <th className="py-2 pr-4 font-semibold">YES =</th>
                <th className="py-2 pr-4 font-semibold">Source</th>
                <th className="py-2 pr-4 font-semibold">Added</th>
                <th className="py-2 font-semibold" />
              </tr>
            </thead>
            <tbody>
              {bindings.map((b) => (
                <tr key={b.marketId} className="border-t border-surface-container-low align-top">
                  <td className="py-2.5 pr-4 break-all font-mono text-data-mono text-on-surface">{b.marketId}</td>
                  <td className="py-2.5 pr-4 font-mono text-data-mono text-on-surface">{b.fixtureId}</td>
                  <td className="py-2.5 pr-4 font-mono text-data-mono text-on-surface-variant">{b.market}</td>
                  <td className="py-2.5 pr-4 font-mono text-data-mono text-on-surface-variant">{b.yesOutcome}</td>
                  <td className="py-2.5 pr-4">
                    <span className="rounded-full border border-outline-variant px-2 py-0.5 text-label-sm text-on-surface-variant">
                      {b.source === 'MATCHED' ? 'matched' : 'manual'}
                    </span>
                  </td>
                  <td className="py-2.5 pr-4 font-mono text-label-sm text-outline" title={`by ${b.createdBy.slice(0, 4)}…${b.createdBy.slice(-4)}`}>
                    {clockTime(b.createdAt)}
                  </td>
                  <td className="py-2.5 text-right">
                    <button
                      onClick={() => remove(b)}
                      disabled={busy !== null}
                      className="text-label-sm text-outline transition-colors enabled:hover:text-error disabled:opacity-40"
                    >
                      {busy === b.marketId ? 'Signing…' : 'Remove'}
                    </button>
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
