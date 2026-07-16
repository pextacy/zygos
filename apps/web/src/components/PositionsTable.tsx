'use client';

import { ageLabel, usd } from '../lib/format';
import type { FeedState, ValuedPositionDto } from '../lib/types';
import { FeedStateBadge } from './FeedStateBadge';
import { TxBadge } from './TxBadge';

function pnl(dto: ValuedPositionDto): string | null {
  if (!dto.valuation || dto.position.entryPrice === null) return null;
  const entryCost = (BigInt(dto.position.size) * BigInt(dto.position.entryPrice)) / 1_000_000n;
  return (BigInt(dto.valuation.fairValue) - entryCost).toString();
}

/** Center column (FR-50): positions with fair value, lag delta, P&L, Lock In. */
export function PositionsTable({
  positions,
  feedStates,
  walletConnected,
  onLockIn,
  onArmRule,
}: {
  positions: ValuedPositionDto[];
  feedStates: Map<string, FeedState>;
  walletConnected: boolean;
  onLockIn: (dto: ValuedPositionDto) => void;
  onArmRule: (dto: ValuedPositionDto) => void;
}) {
  return (
    <section className="flex min-h-0 flex-col gap-2">
      <h2 className="text-xs uppercase tracking-widest text-terminal-dim">Positions</h2>
      {!walletConnected && <p className="text-xs text-terminal-dim">Connect a wallet to load positions.</p>}
      {walletConnected && positions.length === 0 && <p className="text-xs text-terminal-dim">No open positions detected on the venue.</p>}

      <div className="flex-1 space-y-2 overflow-y-auto">
        {positions.map((dto) => {
          const feedState = feedStates.get(dto.position.fixtureId) ?? 'STALE';
          const stale = dto.state === 'STALE' || feedState === 'STALE';
          const lockable = dto.state === 'OK' && !stale;
          const unrealized = pnl(dto);

          return (
            <div key={dto.position.positionRef} className="rounded border border-terminal-border bg-terminal-panel p-2">
              <div className="flex items-center justify-between text-[10px] text-terminal-dim">
                <span>
                  {dto.position.fixtureId} · {dto.position.market} · <span className="text-terminal-text">{dto.position.outcome}</span>
                </span>
                <FeedStateBadge state={stale ? 'STALE' : feedState} />
              </div>

              <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-sm tabular-nums sm:grid-cols-4">
                <Cell label="size" value={usd(dto.position.size)} />
                <Cell label="entry" value={dto.position.entryPrice !== null ? usd(((BigInt(dto.position.size) * BigInt(dto.position.entryPrice)) / 1_000_000n).toString()) : '—'} />
                <Cell
                  label="fair value"
                  value={
                    dto.valuation ? (
                      <>
                        {usd(dto.valuation.fairValue)}
                        <TxBadge packetIds={dto.valuation.packetIds} asOf={Date.now() - dto.valuation.feedAgeMs} />
                      </>
                    ) : (
                      <span className="text-terminal-danger">{dto.state}</span>
                    )
                  }
                />
                <Cell
                  label="unrealized P&L"
                  value={
                    unrealized !== null ? (
                      <span className={BigInt(unrealized) >= 0n ? 'text-terminal-accent' : 'text-terminal-danger'}>{usd(unrealized)}</span>
                    ) : (
                      '—'
                    )
                  }
                />
              </div>

              {dto.valuation && (
                <div className="mt-1 text-[10px] text-terminal-dim">
                  mark {usd(dto.valuation.markValue)} · lag Δ {usd(dto.valuation.lagDelta)} · feed {ageLabel(dto.valuation.feedAgeMs)} old
                </div>
              )}

              <div className="mt-2 flex gap-2">
                <button
                  disabled={!lockable}
                  onClick={() => onLockIn(dto)}
                  title={stale ? 'Feed STALE — lock-in disabled (FR-14)' : dto.state !== 'OK' ? dto.state : 'Lock in a guaranteed payout'}
                  className="rounded border border-terminal-accent px-3 py-1 text-xs uppercase tracking-wider text-terminal-accent enabled:hover:bg-terminal-accent enabled:hover:text-terminal-bg disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Lock In
                </button>
                <button
                  disabled={!lockable || (dto.position.outcome !== 'HOME' && dto.position.outcome !== 'AWAY')}
                  onClick={() => onArmRule(dto)}
                  className="rounded border border-terminal-border px-3 py-1 text-xs uppercase tracking-wider text-terminal-dim enabled:hover:text-terminal-text disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Arm rule
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Cell({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-widest text-terminal-dim">{label}</div>
      <div>{value}</div>
    </div>
  );
}
