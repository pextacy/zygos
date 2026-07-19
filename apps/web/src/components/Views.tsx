'use client';

import { ageLabel, pct, ppmPct, usd } from '../lib/format';
import { explorerTxUrl } from '../lib/server';
import type { ConsensusFrame, FeedState, HealthDto, MatchEventDto, ValuedPositionDto } from '../lib/types';
import { useArmedRules, RuleStatusPill, ruleTitle, ruleDescription, thresholdLabel } from './ArmedRulesPanel';
import { EventTickerCard, SystemStatusCard } from './DashboardCards';
import { FeedStateBadge } from './FeedStateBadge';
import { IconPlus } from './Icons';
import { LockLedgerPanel } from './LockLedgerPanel';
import { MarketBindingsPanel } from './MarketBindingsPanel';
import { PositionsTable, pnl } from './PositionsTable';
import { TxBadge } from './TxBadge';
import { clockTime } from '../lib/format';

function sumMicro(values: Array<string | null>): string {
  let total = 0n;
  for (const v of values) if (v !== null) total += BigInt(v);
  return total.toString();
}

/** Portfolio view: totals + the full positions table (per the portfolio screen). */
export function PortfolioView({
  positions,
  feedStates,
  wallet,
  loading,
  ledgerKey,
  onRefresh,
  onLockIn,
  onArmRule,
  onBindMarket,
}: {
  positions: ValuedPositionDto[];
  feedStates: Map<string, FeedState>;
  wallet: string | null;
  loading: boolean;
  ledgerKey: number;
  onRefresh: () => void;
  onLockIn: (dto: ValuedPositionDto) => void;
  onArmRule: (dto: ValuedPositionDto) => void;
  onBindMarket?: () => void;
}) {
  const walletConnected = wallet !== null;
  const totalFair = sumMicro(positions.map((p) => p.valuation?.fairValue ?? null));
  const totalPnl = sumMicro(positions.map(pnl));
  const totalLag = sumMicro(positions.map((p) => p.valuation?.lagDelta ?? null));
  const pnlPositive = BigInt(totalPnl) >= 0n;
  const lagPositive = BigInt(totalLag) >= 0n;
  const valued = positions.filter((p) => p.valuation !== null);

  const ALLOC_COLORS = ['#2a14b4', '#4338ca', '#c3c0ff', '#565e74', '#bec6e0', '#e3dfff'];

  return (
    <div className="mx-auto w-full max-w-5xl p-4 md:p-6">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <span className="text-label-caps uppercase text-outline">Total fair value</span>
          <div className="mt-1 text-headline-lg text-on-surface md:text-display-lg">{usd(totalFair)}</div>
        </div>
        <div className="flex flex-wrap gap-3">
          <div className="rounded-lg border border-outline-variant bg-surface-container-lowest px-4 py-2 shadow-sm">
            <span className="text-label-sm text-outline">Unrealized P&amp;L</span>
            <div className={`font-mono text-data-mono ${pnlPositive ? 'text-primary' : 'text-error'}`}>
              {pnlPositive ? '↑' : '↓'} {usd(totalPnl)}
            </div>
          </div>
          <div className="rounded-lg border border-outline-variant bg-surface-container-lowest px-4 py-2 shadow-sm" title="Σ (TxLINE fair value − on-chain mark) across open positions — the lag the chain hasn't priced yet">
            <span className="text-label-sm text-outline">TxLINE lead (fair − mark)</span>
            <div className={`font-mono text-data-mono ${lagPositive ? 'text-primary' : 'text-error'}`}>
              {lagPositive ? '↑' : '↓'} {usd(totalLag)}
            </div>
          </div>
          <div className="rounded-lg border border-outline-variant bg-surface-container-lowest px-4 py-2 shadow-sm">
            <span className="text-label-sm text-outline">Open positions</span>
            <div className="font-mono text-data-mono text-on-surface">{positions.length}</div>
          </div>
        </div>
      </div>

      {valued.length > 0 && BigInt(totalFair) > 0n && (
        <div className="mb-6 rounded-xl border border-outline-variant bg-surface-container-lowest p-4 shadow-sm md:p-6">
          <h3 className="mb-4 border-b border-surface-container-high pb-2 text-title-md text-on-surface">Allocation by fair value</h3>
          <div className="flex h-4 w-full overflow-hidden rounded-full bg-surface-container-high">
            {valued.map((p, i) => {
              const share = Number((BigInt(p.valuation!.fairValue) * 10_000n) / BigInt(totalFair)) / 100;
              return (
                <div
                  key={p.position.positionRef}
                  style={{ width: `${share}%`, backgroundColor: ALLOC_COLORS[i % ALLOC_COLORS.length] }}
                  title={`${p.position.fixtureId} · ${p.position.outcome} — ${share.toFixed(1)}%`}
                />
              );
            })}
          </div>
          <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5">
            {valued.map((p, i) => {
              const share = Number((BigInt(p.valuation!.fairValue) * 10_000n) / BigInt(totalFair)) / 100;
              return (
                <li key={p.position.positionRef} className="flex items-center gap-1.5 text-label-sm text-on-surface-variant">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: ALLOC_COLORS[i % ALLOC_COLORS.length] }} />
                  <span className="font-mono">{p.position.fixtureId}</span> · {p.position.outcome} · {share.toFixed(1)}%
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <PositionsTable
        positions={positions}
        feedStates={feedStates}
        walletConnected={walletConnected}
        loading={loading}
        onRefresh={onRefresh}
        onLockIn={onLockIn}
        onArmRule={onArmRule}
        {...(onBindMarket ? { onBindMarket } : {})}
      />

      <LockLedgerPanel wallet={wallet} refreshKey={ledgerKey} />
    </div>
  );
}

/** Automation view: rule stats, rule cards, delegation table (per the automation screen). */
export function AutomationView({
  wallet,
  refreshKey,
  sessionFirings,
  onLog,
  onArmNew,
}: {
  wallet: string | null;
  refreshKey: number;
  sessionFirings: number;
  onLog: (kind: 'rule' | 'error', text: string) => void;
  onArmNew: () => void;
}) {
  const { rules, loading, cancelling, cancel, revoke } = useArmedRules(wallet, refreshKey, onLog);
  const delegated = rules.filter((r) => r.delegation && r.delegation.status !== 'failed');

  return (
    <div className="mx-auto w-full max-w-5xl p-4 md:p-6">
      <h1 className="text-headline-lg text-on-surface">Automation Rules</h1>
      <p className="mt-2 max-w-2xl border-b border-outline-variant pb-6 text-body-lg text-on-surface-variant">
        Manage armed triggers and delegated execution. Rules never auto-sign unless you pre-signed the exact transaction yourself.
      </p>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Armed rules" value={loading ? '…' : String(rules.length)} />
        <StatCard label="Delegated" value={loading ? '…' : String(delegated.length)} />
        <StatCard label="Firings this session" value={String(sessionFirings)} />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {rules.map((rule) => (
          <div key={rule.id} className="rounded-xl border border-outline-variant bg-surface-container-lowest p-4 shadow-card">
            <div className="mb-2 flex items-start justify-between gap-2">
              <RuleStatusPill rule={rule} />
              <span className="flex gap-3">
                {rule.delegation?.status === 'armed' && (
                  <button
                    onClick={() => revoke(rule)}
                    disabled={cancelling === rule.id}
                    title="Erase the stored pre-signed tx and void it on-chain via a nonce advance"
                    className="text-label-sm text-outline transition-colors enabled:hover:text-error disabled:opacity-40"
                  >
                    Revoke
                  </button>
                )}
                <button onClick={() => cancel(rule)} disabled={cancelling === rule.id} className="text-label-sm text-outline transition-colors enabled:hover:text-error disabled:opacity-40">
                  {cancelling === rule.id ? 'Signing…' : 'Cancel'}
                </button>
              </span>
            </div>
            <h4 className="font-mono text-data-mono text-on-surface">{ruleTitle(rule)}</h4>
            <div className="mt-2 rounded border border-surface-container-high bg-surface-container-low p-2 font-mono text-label-sm text-on-surface-variant">
              <div className="flex justify-between gap-2">
                <span className="text-outline">IF</span>
                <span>
                  {rule.template === 'PRICE_LOCK'
                    ? `consensus ${thresholdLabel(rule)} · ${rule.team}`
                    : rule.template === 'GOAL_LOCK'
                      ? `goal · ${rule.team}`
                      : `red card · ${rule.team}`}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-outline">THEN</span>
                <span>lock {ppmPct(rule.fractionPpm)} of position</span>
              </div>
            </div>
            <p className="mt-2 text-body-sm text-outline">{ruleDescription(rule)}</p>
            <p className="mt-2 border-t border-surface-container-high pt-2 text-label-sm text-outline" title={rule.intentHash}>
              armed {clockTime(rule.createdAt)} · intent {rule.intentHash.slice(0, 12)}…
            </p>
          </div>
        ))}

        <button
          onClick={onArmNew}
          className="flex min-h-44 flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-outline-variant p-4 text-center transition-colors hover:border-primary"
        >
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-container-high text-on-surface-variant">
            <IconPlus className="h-6 w-6" />
          </span>
          <span className="text-title-md text-on-surface-variant">Arm a new rule</span>
          <span className="text-body-sm text-outline">Rules attach to a position — pick one in the Terminal and use &ldquo;Arm Rule&rdquo;.</span>
        </button>
      </div>

      {delegated.length > 0 && (
        <div className="mt-6 rounded-xl border border-outline-variant bg-surface-container-lowest shadow-sm">
          <div className="flex items-center justify-between border-b border-surface-container-high p-4">
            <h3 className="text-title-md text-on-surface">Active Delegations</h3>
            <span className="text-label-sm text-outline">{delegated.length} pre-signed</span>
          </div>
          <div className="overflow-x-auto p-4 pt-0">
            <table className="w-full min-w-[520px] text-left">
              <thead>
                <tr className="text-label-caps uppercase text-outline">
                  <th className="py-2 pr-4 font-semibold">Rule</th>
                  <th className="py-2 pr-4 font-semibold">Fixture</th>
                  <th className="py-2 pr-4 font-semibold">Status</th>
                  <th className="py-2 font-semibold">Submitted Tx</th>
                </tr>
              </thead>
              <tbody>
                {delegated.map((rule) => (
                  <tr key={rule.id} className="border-t border-surface-container-low">
                    <td className="py-2.5 pr-4 font-mono text-data-mono text-on-surface">{ruleTitle(rule)}</td>
                    <td className="py-2.5 pr-4 font-mono text-data-mono text-on-surface-variant">{rule.fixtureId}</td>
                    <td className="py-2.5 pr-4">
                      <RuleStatusPill rule={rule} />
                    </td>
                    <td className="py-2.5 break-all font-mono text-label-sm text-outline">
                      {rule.delegation?.submittedSig ? (
                        <a
                          href={explorerTxUrl(rule.delegation.submittedSig)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary underline decoration-dotted underline-offset-2 hover:text-primary-container"
                        >
                          {rule.delegation.submittedSig.slice(0, 16)}…
                        </a>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-outline-variant bg-surface-container-lowest p-4 shadow-sm">
      <span className="text-label-caps uppercase text-outline">{label}</span>
      <div className="mt-2 text-headline-lg text-on-surface">{value}</div>
    </div>
  );
}

/** Analytics view: consensus market table + event history — all TxLINE-derived. */
export function AnalyticsView({
  consensus,
  feedStates,
  events,
  health,
  onExplain,
  onLog,
}: {
  consensus: Map<string, ConsensusFrame>;
  feedStates: Map<string, FeedState>;
  events: MatchEventDto[];
  health: HealthDto | null;
  onExplain: (frame: ConsensusFrame) => void;
  onLog: (kind: 'info' | 'error', text: string) => void;
}) {
  const frames = [...consensus.values()].sort((a, b) => a.fixtureId.localeCompare(b.fixtureId) || a.market.localeCompare(b.market));

  return (
    <div className="mx-auto w-full max-w-5xl p-4 md:p-6">
      <h1 className="text-headline-lg text-on-surface">Analytics</h1>
      <p className="mt-2 max-w-2xl border-b border-outline-variant pb-6 text-body-lg text-on-surface-variant">
        Every market tracked this session, with the TxLINE consensus behind it and on-chain provenance one click away.
      </p>

      <div className="mt-6">
        <SystemStatusCard health={health} />
      </div>

      <div className="mt-6 rounded-xl border border-outline-variant bg-surface-container-lowest shadow-sm">
        <div className="border-b border-surface-container-high p-4">
          <h3 className="text-title-md text-on-surface">Markets</h3>
        </div>
        <div className="overflow-x-auto p-4 pt-0">
          {frames.length === 0 && <p className="pt-4 text-body-md text-outline">No consensus data yet — watch a fixture in the Terminal.</p>}
          {frames.length > 0 && (
            <table className="w-full min-w-[640px] text-left">
              <thead>
                <tr className="text-label-caps uppercase text-outline">
                  <th className="py-2 pr-4 font-semibold">Market</th>
                  <th className="py-2 pr-4 font-semibold">Consensus</th>
                  <th className="py-2 pr-4 font-semibold">Books</th>
                  <th className="py-2 pr-4 font-semibold">Feed</th>
                  <th className="py-2 pr-4 font-semibold">Age</th>
                  <th className="py-2 font-semibold">Provenance</th>
                </tr>
              </thead>
              <tbody>
                {frames.map((frame) => {
                  const state = feedStates.get(frame.fixtureId) ?? 'STALE';
                  return (
                    <tr key={`${frame.fixtureId}|${frame.market}`} className="border-t border-surface-container-low align-top">
                      <td className="py-2.5 pr-4">
                        <span className="font-mono text-data-mono text-on-surface">{frame.fixtureId}</span>
                        <div className="text-label-sm text-outline">{frame.market}</div>
                      </td>
                      <td className="py-2.5 pr-4 font-mono text-data-mono text-on-surface">
                        {Object.entries(frame.probs)
                          .map(([o, p]) => `${o} ${pct(p)}`)
                          .join('  ')}
                      </td>
                      <td className="py-2.5 pr-4 font-mono text-data-mono text-on-surface">
                        {frame.bookCount}
                        {frame.confidence === 'LOW_CONFIDENCE' && <div className="text-label-sm text-on-error-container">low confidence</div>}
                      </td>
                      <td className="py-2.5 pr-4">
                        <FeedStateBadge state={state} />
                      </td>
                      <td className="py-2.5 pr-4 font-mono text-data-mono text-on-surface-variant">{ageLabel(Date.now() - frame.asOf)}</td>
                      <td className="py-2.5">
                        <TxBadge packetIds={frame.packetIds} asOf={frame.asOf} />
                        <button onClick={() => onExplain(frame)} className="ml-2 text-label-sm text-primary underline decoration-dotted underline-offset-2 hover:text-primary-container">
                          Explain
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <MarketBindingsPanel onLog={onLog} />

      <div className="mt-6">
        <EventTickerCard events={events} />
      </div>
    </div>
  );
}
