'use client';

import { ageLabel, usd } from '../lib/format';
import { unmappedMarketIdOf } from '../lib/positions';
import type { FeedState, ValuedPositionDto } from '../lib/types';
import { FeedStateBadge } from './FeedStateBadge';
import { IconRefresh } from './Icons';
import { TxBadge } from './TxBadge';

export function pnl(dto: ValuedPositionDto): string | null {
  if (!dto.valuation || dto.position.entryPrice === null) return null;
  const entryCost = (BigInt(dto.position.size) * BigInt(dto.position.entryPrice)) / 1_000_000n;
  return (BigInt(dto.valuation.fairValue) - entryCost).toString();
}

const OUTCOME_PILL: Record<string, string> = {
  HOME: 'bg-primary-fixed text-primary',
  AWAY: 'bg-error-container text-on-error-container',
  DRAW: 'bg-surface-variant text-secondary',
  OVER: 'bg-primary-fixed text-primary',
  UNDER: 'bg-error-container text-on-error-container',
};

/** Positions with fair value, lag delta, P&L and the Lock In action (FR-50). */
export function PositionsTable({
  positions,
  feedStates,
  walletConnected,
  loading,
  onRefresh,
  onLockIn,
  onArmRule,
  onBindMarket,
  className,
}: {
  positions: ValuedPositionDto[];
  feedStates: Map<string, FeedState>;
  walletConnected: boolean;
  loading: boolean;
  onRefresh: () => void;
  onLockIn: (dto: ValuedPositionDto) => void;
  onArmRule: (dto: ValuedPositionDto) => void;
  /** Navigate to the Market Bindings panel (Analytics) for an UNMAPPED position. */
  onBindMarket?: () => void;
  className?: string;
}) {
  return (
    <div className={`rounded-xl border border-outline-variant bg-surface-container-lowest p-4 shadow-sm md:p-6 ${className ?? ''}`}>
      <div className="mb-4 flex items-center justify-between border-b border-surface-container-high pb-2">
        <h3 className="text-title-md text-on-surface">Active Positions</h3>
        {walletConnected && (
          <button
            onClick={onRefresh}
            disabled={loading}
            className="flex items-center gap-1.5 rounded border border-outline-variant px-3 py-1.5 text-label-sm text-on-surface-variant transition-colors enabled:hover:bg-surface-container-high disabled:opacity-40"
          >
            <IconRefresh className="h-3.5 w-3.5" />
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        )}
      </div>

      {!walletConnected && <p className="text-body-md text-outline">Connect a wallet to load positions.</p>}
      {walletConnected && loading && positions.length === 0 && <p className="text-body-md text-outline">Reading positions from the venue…</p>}
      {walletConnected && !loading && positions.length === 0 && <p className="text-body-md text-outline">No open positions detected on the venue.</p>}

      {positions.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left">
            <thead>
              <tr className="text-label-caps uppercase text-outline">
                <th className="pb-2 pr-4 font-semibold">Position</th>
                <th className="pb-2 pr-4 font-semibold">Size</th>
                <th className="pb-2 pr-4 font-semibold">Entry</th>
                <th className="pb-2 pr-4 font-semibold">Fair Value</th>
                <th className="pb-2 pr-4 font-semibold">Unrealized P&amp;L</th>
                <th className="pb-2 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((dto) => {
                const feedState = feedStates.get(dto.position.fixtureId) ?? 'STALE';
                const stale = dto.state === 'STALE' || feedState === 'STALE';
                const lockable = dto.state === 'OK' && !stale;
                const unmappedId = unmappedMarketIdOf(dto.position.fixtureId);
                const unrealized = pnl(dto);
                const entry =
                  dto.position.entryPrice !== null ? usd(((BigInt(dto.position.size) * BigInt(dto.position.entryPrice)) / 1_000_000n).toString()) : '—';

                return (
                  <tr key={dto.position.positionRef} className="border-t border-surface-container-low align-top">
                    <td className="py-3 pr-4">
                      <div className="flex items-center gap-2">
                        <span className={`rounded-full px-2 py-0.5 font-mono text-label-sm ${OUTCOME_PILL[dto.position.outcome] ?? 'bg-surface-variant text-secondary'}`}>
                          {dto.position.outcome}
                        </span>
                        {unmappedId !== null ? (
                          <span className="break-all font-mono text-data-mono text-on-surface" title={`venue marketId ${unmappedId} — not bound to a TxLINE fixture`}>
                            {unmappedId.length > 20 ? `${unmappedId.slice(0, 20)}…` : unmappedId}
                          </span>
                        ) : (
                          <span className="font-mono text-data-mono text-on-surface">{dto.position.fixtureId}</span>
                        )}
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-label-sm text-outline">
                        {unmappedId !== null ? 'venue market' : dto.position.market}
                        {unmappedId === null && <FeedStateBadge state={stale ? 'STALE' : feedState} />}
                      </div>
                    </td>
                    <td className="py-3 pr-4 font-mono text-data-mono text-on-surface">{usd(dto.position.size)}</td>
                    <td className="py-3 pr-4 font-mono text-data-mono text-on-surface">{entry}</td>
                    <td className="py-3 pr-4">
                      {dto.valuation ? (
                        <>
                          <span className="font-mono text-data-mono text-on-surface">{usd(dto.valuation.fairValue)}</span>
                          <TxBadge packetIds={dto.valuation.packetIds} asOf={Date.now() - dto.valuation.feedAgeMs} />
                          <div className="mt-1 text-label-sm text-outline">
                            mark {usd(dto.valuation.markValue)} · lag Δ {usd(dto.valuation.lagDelta)} · {ageLabel(dto.valuation.feedAgeMs)} old
                          </div>
                        </>
                      ) : dto.state === 'UNMAPPED_OUTCOME' ? (
                        <div>
                          <span className="rounded-sm bg-error-container px-1.5 py-0.5 font-mono text-label-sm text-on-error-container">UNMAPPED</span>
                          <div className="mt-1 text-label-sm text-outline">
                            not valued — venue market has no TxLINE binding
                            {onBindMarket && (
                              <button
                                onClick={onBindMarket}
                                className="ml-1.5 text-primary underline decoration-dotted underline-offset-2 hover:text-primary-container"
                              >
                                Bind market →
                              </button>
                            )}
                          </div>
                        </div>
                      ) : dto.state === 'NO_CONSENSUS' ? (
                        <div>
                          <span className="rounded-sm bg-surface-variant px-1.5 py-0.5 font-mono text-label-sm text-secondary">NO CONSENSUS</span>
                          <div className="mt-1 text-label-sm text-outline">no TxLINE snapshot for this market yet — watch its fixture in the Match Feed</div>
                        </div>
                      ) : (
                        <span className="font-mono text-data-mono text-error">{dto.state}</span>
                      )}
                    </td>
                    <td className="py-3 pr-4 font-mono text-data-mono">
                      {unrealized !== null ? <span className={BigInt(unrealized) >= 0n ? 'text-primary' : 'text-error'}>{usd(unrealized)}</span> : '—'}
                    </td>
                    <td className="py-3">
                      <div className="flex gap-2">
                        <button
                          disabled={!lockable}
                          onClick={() => onLockIn(dto)}
                          title={
                            stale
                              ? 'Feed stale — lock-in disabled (FR-14)'
                              : dto.state === 'UNMAPPED_OUTCOME'
                                ? 'Venue market not bound to a TxLINE fixture — bind it in Analytics → Market Bindings'
                                : dto.state === 'NO_CONSENSUS'
                                  ? 'No TxLINE consensus for this market yet'
                                  : dto.state !== 'OK'
                                    ? dto.state
                                    : 'Lock in a guaranteed payout'
                          }
                          className="rounded bg-primary px-3 py-1.5 font-mono text-label-sm text-on-primary transition-colors enabled:hover:bg-primary-container disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          Lock In
                        </button>
                        <button
                          disabled={!lockable || (dto.position.outcome !== 'HOME' && dto.position.outcome !== 'AWAY')}
                          onClick={() => onArmRule(dto)}
                          className="rounded border border-outline-variant px-3 py-1.5 font-mono text-label-sm text-on-surface-variant transition-colors enabled:hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          Arm Rule
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
