'use client';

import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import pkg from '../../package.json';
import { api, CLUSTER } from '../lib/server';
import { unmappedMarketIdOf } from '../lib/positions';
import { initialState, reducer } from '../lib/store';
import type { ConsensusFrame, FixtureDto, HedgePreviewDto, RuleFiredFrame, ValuedPositionDto } from '../lib/types';
import { useHealth } from '../lib/useHealth';
import { useZygosSocket } from '../lib/useZygosSocket';
import { ActivityLog } from './ActivityLog';
import { ArmedRulesPanel } from './ArmedRulesPanel';
import { ConsensusChartCard, EventTickerCard, FeedMetricsCard, OnboardingCard } from './DashboardCards';
import { ExplainerPanel } from './ExplainerPanel';
import { IconAnalytics, IconAutomation, IconPortfolio, IconTerminal } from './Icons';
import { LockInModal } from './LockInModal';
import { MatchBoard } from './MatchBoard';
import { PositionsTable } from './PositionsTable';
import { RuleArmModal } from './RuleArmModal';
import { RuleFiredOverlay } from './RuleFiredOverlay';
import { AnalyticsView, AutomationView, PortfolioView } from './Views';

type View = 'terminal' | 'portfolio' | 'automation' | 'analytics';

const NAV: Array<{ id: View; label: string; icon: (p: { className?: string }) => React.ReactNode }> = [
  { id: 'terminal', label: 'Terminal', icon: IconTerminal },
  { id: 'portfolio', label: 'Portfolio', icon: IconPortfolio },
  { id: 'automation', label: 'Automation', icon: IconAutomation },
  { id: 'analytics', label: 'Analytics', icon: IconAnalytics },
];

/** App shell per the Zygos Terminal design: top nav, operations sidebar, views, footer. */
export function Terminal() {
  const { publicKey } = useWallet();
  const wallet = publicKey?.toBase58() ?? null;
  const [state, dispatch] = useReducer(reducer, initialState);
  const [view, setView] = useState<View>('terminal');
  const [watched, setWatched] = useState<string[]>([]);
  const [selectedMarket, setSelectedMarket] = useState<string | null>(null);
  const [explain, setExplain] = useState<ConsensusFrame | null>(null);
  const [lockTarget, setLockTarget] = useState<{ dto: ValuedPositionDto; prefill?: { fraction: number; preview: HedgePreviewDto; ruleId?: string } } | null>(null);
  const [ruleTarget, setRuleTarget] = useState<ValuedPositionDto | null>(null);
  const [disclaimerAck, setDisclaimerAck] = useState(false);
  const [loadingPositions, setLoadingPositions] = useState(false);
  const [rulesRefresh, setRulesRefresh] = useState(0);
  const [locksRefresh, setLocksRefresh] = useState(0);

  useZygosSocket(dispatch, wallet, watched);
  const health = useHealth();

  // Bootstrap from the server's already-subscribed fixtures so a reload doesn't start with an empty board.
  useEffect(() => {
    api<{ fixtures: FixtureDto[] }>('/fixtures')
      .then(({ fixtures }) => {
        if (fixtures.length === 0) return;
        setWatched((w) => [...new Set([...w, ...fixtures.map((f) => f.fixtureId)])]);
        for (const fixture of fixtures) {
          dispatch({ type: 'feedHealth', fixtureId: fixture.fixtureId, state: fixture.state });
          for (const m of fixture.markets) {
            dispatch({ type: 'consensus', frame: { type: 'CONSENSUS', fixtureId: fixture.fixtureId, ...m } });
          }
        }
      })
      .catch((err: Error) => dispatch({ type: 'log', kind: 'info', text: `fixtures unavailable: ${err.message}` }));
  }, []);

  // Initial + on-demand position load over HTTP; live updates then flow via VALUATION frames.
  const refreshPositions = useCallback(() => {
    if (!wallet) return;
    setLoadingPositions(true);
    api<{ positions: ValuedPositionDto[] }>(`/positions/${wallet}`)
      .then(({ positions }) => {
        dispatch({ type: 'positions', list: positions });
        const fixtures = [...new Set(positions.map((p) => p.position.fixtureId).filter((f) => unmappedMarketIdOf(f) === null))];
        if (fixtures.length > 0) setWatched((w) => [...new Set([...w, ...fixtures])]);
      })
      .catch((err: Error) => dispatch({ type: 'log', kind: 'error', text: `positions: ${err.message}` }))
      .finally(() => setLoadingPositions(false));
  }, [wallet]);

  useEffect(() => {
    refreshPositions();
  }, [refreshPositions]);

  // Keep a market pinned in the dashboard once consensus starts flowing.
  useEffect(() => {
    if (selectedMarket === null && state.consensus.size > 0) {
      setSelectedMarket([...state.consensus.keys()].sort()[0] ?? null);
    }
  }, [state.consensus, selectedMarket]);

  const onWatch = useCallback((fixtureId: string) => setWatched((w) => [...new Set([...w, fixtureId])]), []);
  const onLog = useCallback((kind: 'lock' | 'rule' | 'error' | 'info', text: string) => dispatch({ type: 'log', kind, text }), []);

  const positions = useMemo(() => [...state.positions.values()], [state.positions]);
  const frames = useMemo(
    () => [...state.consensus.values()].sort((a, b) => a.fixtureId.localeCompare(b.fixtureId) || a.market.localeCompare(b.market)),
    [state.consensus],
  );

  // Quick Execute: open Lock In on the largest currently lockable position.
  const quickTarget = useMemo(() => {
    const lockable = positions.filter((p) => p.state === 'OK' && (state.feedStates.get(p.position.fixtureId) ?? 'STALE') !== 'STALE' && p.valuation !== null);
    return lockable.sort((a, b) => (BigInt(b.valuation?.fairValue ?? '0') > BigInt(a.valuation?.fairValue ?? '0') ? 1 : -1))[0] ?? null;
  }, [positions, state.feedStates]);

  const ruleFire: RuleFiredFrame | null = state.pendingRuleFire;
  const rulesKey = rulesRefresh + state.ruleActivitySeq;

  const navLink = (item: (typeof NAV)[number], base: string) => (
    <button
      key={item.id}
      onClick={() => setView(item.id)}
      className={`${base} ${
        view === item.id
          ? 'border-b-2 border-primary text-primary'
          : 'text-on-surface-variant transition-colors hover:bg-surface-container-highest hover:text-on-surface'
      }`}
    >
      {item.label}
    </button>
  );

  return (
    <div className="flex h-screen flex-col">
      {/* Top nav bar */}
      <header className="sticky top-0 z-30 border-b border-outline-variant bg-background px-4 md:px-6">
        <div className="flex h-14 items-center justify-between gap-3 md:h-16">
          <div className="flex min-w-0 items-center gap-6">
            <div className="whitespace-nowrap text-lg font-bold tracking-tighter text-primary md:text-headline-md">ZYGOS_TERMINAL</div>
            <nav className="hidden h-full items-center gap-4 font-mono text-data-mono md:flex">
              {NAV.map((item) => navLink(item, 'flex h-16 items-center px-2 pt-1'))}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <span
              className={`whitespace-nowrap font-mono text-label-sm ${state.connected ? 'text-primary' : 'text-error'}`}
              title={state.connected ? 'Server link live' : 'Server link offline'}
            >
              <span className="sm:hidden">{state.connected ? '●' : '○'}</span>
              <span className="hidden sm:inline">{state.connected ? '● LIVE' : '○ OFFLINE'}</span>
            </span>
            <WalletMultiButton />
          </div>
        </div>
        <nav className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 pb-2 font-mono text-data-mono md:hidden">
          {NAV.map((item) => navLink(item, 'whitespace-nowrap rounded px-2 py-1'))}
        </nav>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Operations sidebar */}
        <aside className="hidden w-56 flex-shrink-0 flex-col border-r border-outline-variant bg-surface-container-low py-4 lg:flex">
          <div className="mb-6 px-5">
            <h2 className="text-headline-sm text-on-surface">OPERATIONS</h2>
            <p className="mt-1 text-label-sm text-outline">v{pkg.version}</p>
          </div>
          <nav className="flex flex-1 flex-col gap-1 pr-3">
            {NAV.map((item) => {
              const active = view === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setView(item.id)}
                  className={`flex items-center gap-3 rounded-r-full px-5 py-2.5 text-left text-label-caps uppercase transition-colors ${
                    active
                      ? 'border-l-4 border-secondary bg-secondary-container pl-4 text-on-secondary-container'
                      : 'text-outline hover:bg-surface-container-high hover:text-on-surface-variant'
                  }`}
                >
                  <item.icon className="h-5 w-5" />
                  {item.label}
                </button>
              );
            })}
          </nav>
          <div className="mt-auto px-5">
            <button
              onClick={() => quickTarget && setLockTarget({ dto: quickTarget })}
              disabled={!quickTarget}
              title={quickTarget ? `Lock In ${quickTarget.position.fixtureId} · ${quickTarget.position.outcome}` : 'No lockable position'}
              className="mb-4 w-full rounded-lg border border-outline-variant bg-surface px-4 py-2 font-mono text-data-mono text-secondary shadow-float transition-colors enabled:hover:bg-surface-container-high disabled:opacity-40"
            >
              Quick Execute
            </button>
            <div className="flex flex-col gap-1.5 border-t border-outline-variant pt-4 text-label-caps uppercase text-outline">
              <span>Cluster · {CLUSTER}</span>
              <span>Feed · TxLINE</span>
              <span>Non-custodial</span>
            </div>
          </div>
        </aside>

        {/* Views */}
        <main className="min-h-0 flex-1 overflow-hidden bg-background">
          {view === 'terminal' && (
            <div className="flex h-full flex-col overflow-y-auto md:flex-row md:overflow-hidden">
              <MatchBoard
                consensus={state.consensus}
                histories={state.history}
                feedStates={state.feedStates}
                selectedKey={selectedMarket}
                onSelect={setSelectedMarket}
                onWatch={onWatch}
              />

              <section className="flex-1 md:overflow-y-auto">
                <div className="mx-auto max-w-4xl p-4 md:p-6">
                  <h1 className="mb-6 text-headline-lg text-on-surface">Terminal Dashboard</h1>
                  <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                    {frames.length === 0 && positions.length === 0 && <OnboardingCard className="lg:col-span-2" />}
                    <ConsensusChartCard
                      frames={frames}
                      histories={state.history}
                      selectedKey={selectedMarket}
                      onSelect={setSelectedMarket}
                      onExplain={setExplain}
                      className="lg:col-span-2"
                    />
                    <PositionsTable
                      positions={positions}
                      feedStates={state.feedStates}
                      walletConnected={wallet !== null}
                      loading={loadingPositions}
                      onRefresh={refreshPositions}
                      onLockIn={(dto) => setLockTarget({ dto })}
                      onArmRule={(dto) => setRuleTarget(dto)}
                      onBindMarket={() => setView('analytics')}
                      className="lg:col-span-2"
                    />
                    <FeedMetricsCard
                      connected={state.connected}
                      fixtures={state.feedStates.size}
                      markets={state.consensus.size}
                      eventsSeen={state.events.length}
                      cluster={CLUSTER}
                      health={health}
                      clockSkewMs={state.clockSkewMs}
                    />
                    <EventTickerCard events={state.events} />
                  </div>
                </div>
              </section>

              <section className="flex w-full flex-shrink-0 flex-col border-t border-outline-variant bg-surface md:w-72 md:border-l md:border-t-0">
                <ArmedRulesPanel wallet={wallet} refreshKey={rulesKey} onLog={onLog} />
                <ActivityLog entries={state.activity} />
              </section>
            </div>
          )}

          {view === 'portfolio' && (
            <div className="h-full overflow-y-auto">
              <PortfolioView
                positions={positions}
                feedStates={state.feedStates}
                wallet={wallet}
                loading={loadingPositions}
                ledgerKey={locksRefresh + state.ruleExecutedSeq}
                onRefresh={refreshPositions}
                onLockIn={(dto) => setLockTarget({ dto })}
                onArmRule={(dto) => setRuleTarget(dto)}
                onBindMarket={() => setView('analytics')}
              />
            </div>
          )}

          {view === 'automation' && (
            <div className="h-full overflow-y-auto">
              <AutomationView wallet={wallet} refreshKey={rulesKey} sessionFirings={state.ruleActivitySeq} onLog={onLog} onArmNew={() => setView('terminal')} />
            </div>
          )}

          {view === 'analytics' && (
            <div className="h-full overflow-y-auto">
              <AnalyticsView consensus={state.consensus} feedStates={state.feedStates} events={state.events} health={health} onExplain={setExplain} onLog={onLog} />
            </div>
          )}
        </main>
      </div>

      {/* Footer */}
      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-outline-variant bg-background px-4 py-1.5 md:px-6">
        <div className="text-label-caps uppercase text-outline">© 2026 ZYGOS PROTOCOL [HACKATHON_BUILD]</div>
        <div className="flex gap-4 text-body-sm text-outline">
          <span>Priced by TxLINE</span>
          <span className="hidden sm:inline">Non-custodial</span>
          <span className="font-mono">{CLUSTER}</span>
        </div>
      </footer>

      {/* One-time disclaimer */}
      {wallet && !disclaimerAck && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-outline-variant bg-surface-container-lowest p-3 text-center text-body-sm text-on-surface-variant shadow-float">
          Zygos is decision-support and self-directed execution tooling. It holds no funds and offers no odds. Availability and terms of the underlying
          venue are the venue&apos;s responsibility — check your jurisdiction.{' '}
          <button onClick={() => setDisclaimerAck(true)} className="font-semibold text-primary underline underline-offset-2 hover:text-primary-container">
            Understood
          </button>
        </div>
      )}

      {/* Modals */}
      {explain && <ExplainerPanel frame={explain} onClose={() => setExplain(null)} />}
      {lockTarget && (
        <LockInModal
          dto={lockTarget.dto}
          prefill={lockTarget.prefill}
          onClose={(locked) => {
            setLockTarget(null);
            if (locked) {
              refreshPositions(); // table must reflect the shrunk/closed position immediately
              setLocksRefresh((k) => k + 1); // and the lock ledger must show the new entry
            }
          }}
          onLog={onLog}
        />
      )}
      {ruleTarget && (
        <RuleArmModal
          dto={ruleTarget}
          onClose={(armed) => {
            setRuleTarget(null);
            if (armed) setRulesRefresh((k) => k + 1); // panel must show the new rule (and its delegation state) immediately
          }}
          onLog={onLog}
        />
      )}
      {ruleFire && (
        <RuleFiredOverlay
          frame={ruleFire}
          onDismiss={() => dispatch({ type: 'dismissRuleFire' })}
          onSign={() => {
            const dto = state.positions.get(ruleFire.positionRef);
            dispatch({ type: 'dismissRuleFire' });
            if (dto) {
              const fractionPct =
                ruleFire.preview.plan.hedgeSize && dto.position.size !== '0'
                  ? Number((BigInt(ruleFire.preview.plan.hedgeSize) * 100n) / BigInt(dto.position.size)) / 100
                  : 1;
              setLockTarget({ dto, prefill: { fraction: Math.min(1, Math.max(0.05, fractionPct)), preview: ruleFire.preview, ruleId: ruleFire.ruleId } });
            } else {
              onLog('error', 'position for fired rule not found locally — refresh positions');
            }
          }}
        />
      )}
    </div>
  );
}
