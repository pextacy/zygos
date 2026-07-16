'use client';

import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { api } from '../lib/server';
import { initialState, reducer } from '../lib/store';
import type { HedgePreviewDto, RuleFiredFrame, ValuedPositionDto } from '../lib/types';
import { useZygosSocket } from '../lib/useZygosSocket';
import { ActivityLog } from './ActivityLog';
import { LockInModal } from './LockInModal';
import { MatchBoard } from './MatchBoard';
import { PositionsTable } from './PositionsTable';
import { RuleArmModal } from './RuleArmModal';
import { RuleFiredOverlay } from './RuleFiredOverlay';

/** Single-page terminal (FR-50): match board / positions / activity log. */
export function Terminal() {
  const { publicKey } = useWallet();
  const wallet = publicKey?.toBase58() ?? null;
  const [state, dispatch] = useReducer(reducer, initialState);
  const [watched, setWatched] = useState<string[]>([]);
  const [lockTarget, setLockTarget] = useState<{ dto: ValuedPositionDto; prefill?: { fraction: number; preview: HedgePreviewDto } } | null>(null);
  const [ruleTarget, setRuleTarget] = useState<ValuedPositionDto | null>(null);
  const [disclaimerAck, setDisclaimerAck] = useState(false);

  useZygosSocket(dispatch, wallet, watched);

  // Initial position load over HTTP; live updates then flow via VALUATION frames.
  useEffect(() => {
    if (!wallet) return;
    api<{ positions: ValuedPositionDto[] }>(`/positions/${wallet}`)
      .then(({ positions }) => {
        dispatch({ type: 'positions', list: positions });
        const fixtures = [...new Set(positions.map((p) => p.position.fixtureId).filter((f) => !f.startsWith('unmapped:')))];
        if (fixtures.length > 0) setWatched((w) => [...new Set([...w, ...fixtures])]);
      })
      .catch((err: Error) => dispatch({ type: 'log', kind: 'error', text: `positions: ${err.message}` }));
  }, [wallet]);

  const onWatch = useCallback((fixtureId: string) => setWatched((w) => [...new Set([...w, fixtureId])]), []);
  const onLog = useCallback((kind: 'lock' | 'rule' | 'error' | 'info', text: string) => dispatch({ type: 'log', kind, text }), []);

  const positions = useMemo(() => [...state.positions.values()], [state.positions]);

  const ruleFire: RuleFiredFrame | null = state.pendingRuleFire;

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-terminal-border px-3 py-2">
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg tracking-[0.3em] text-terminal-accent">ZYGOS</h1>
          <span className="hidden text-[10px] uppercase tracking-widest text-terminal-dim sm:inline">position risk management for prediction markets</span>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-[10px] uppercase ${state.connected ? 'text-terminal-accent' : 'text-terminal-danger'}`}>
            {state.connected ? '● server' : '○ offline'}
          </span>
          <WalletMultiButton />
        </div>
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-1 gap-3 p-3 lg:grid-cols-[1fr_1.4fr_1fr]">
        <MatchBoard consensus={state.consensus} feedStates={state.feedStates} events={state.events} onWatch={onWatch} />
        <PositionsTable
          positions={positions}
          feedStates={state.feedStates}
          walletConnected={wallet !== null}
          onLockIn={(dto) => setLockTarget({ dto })}
          onArmRule={(dto) => setRuleTarget(dto)}
        />
        <ActivityLog entries={state.activity} />
      </main>

      {wallet && !disclaimerAck && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-terminal-border bg-terminal-panel p-3 text-center text-[11px] text-terminal-dim">
          Zygos is decision-support and self-directed execution tooling. It holds no funds and offers no odds. Availability and terms of the
          underlying venue are the venue&apos;s responsibility — check your jurisdiction.{' '}
          <button onClick={() => setDisclaimerAck(true)} className="underline hover:text-terminal-text">
            understood
          </button>
        </div>
      )}

      {lockTarget && (
        <LockInModal dto={lockTarget.dto} prefill={lockTarget.prefill} onClose={() => setLockTarget(null)} onLog={onLog} />
      )}
      {ruleTarget && <RuleArmModal dto={ruleTarget} onClose={() => setRuleTarget(null)} onLog={onLog} />}
      {ruleFire && (
        <RuleFiredOverlay
          frame={ruleFire}
          onDismiss={() => dispatch({ type: 'dismissRuleFire' })}
          onSign={() => {
            const dto = state.positions.get(ruleFire.positionRef);
            dispatch({ type: 'dismissRuleFire' });
            if (dto) {
              const fractionPct = ruleFire.preview.plan.hedgeSize && dto.position.size !== '0' ? Number(BigInt(ruleFire.preview.plan.hedgeSize) * 100n / BigInt(dto.position.size)) / 100 : 1;
              setLockTarget({ dto, prefill: { fraction: Math.min(1, Math.max(0.05, fractionPct)), preview: ruleFire.preview } });
            } else {
              onLog('error', 'position for fired rule not found locally — refresh positions');
            }
          }}
        />
      )}
    </div>
  );
}
