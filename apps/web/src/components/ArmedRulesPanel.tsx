'use client';

import { useCallback, useEffect, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { clockTime } from '../lib/format';
import { api } from '../lib/server';
import type { RuleDto } from '../lib/types';
import { buildWalletAuth } from '../lib/wallet';

export function ruleTitle(rule: RuleDto): string {
  const pctLabel = `${Math.round(rule.fractionPpm / 10_000)}%`;
  return rule.template === 'GOAL_LOCK' ? `Goal lock · ${rule.team} ${pctLabel}` : `Red card reduce · ${rule.team} ${pctLabel}`;
}

export function ruleDescription(rule: RuleDto): string {
  const pctLabel = `${Math.round(rule.fractionPpm / 10_000)}%`;
  return rule.template === 'GOAL_LOCK'
    ? `If ${rule.team} scores in ${rule.fixtureId}, prepare a ${pctLabel} lock for one-tap signing.`
    : `If ${rule.team} gets a red card in ${rule.fixtureId}, prepare a ${pctLabel} reduction.`;
}

/** Fetch + cancel armed rules for a wallet; shared by Quick Rules and the Automation view. */
export function useArmedRules(wallet: string | null, refreshKey: number, onLog: (kind: 'rule' | 'error', text: string) => void) {
  const { signMessage } = useWallet();
  const [rules, setRules] = useState<RuleDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (!wallet) {
      setRules([]);
      return;
    }
    setLoading(true);
    api<{ rules: RuleDto[] }>(`/rules/${wallet}`)
      .then(({ rules: list }) => setRules(list))
      .catch((err: Error) => onLog('error', `rules: ${err.message}`))
      .finally(() => setLoading(false));
  }, [wallet, onLog]);

  useEffect(() => {
    refresh();
  }, [refresh, refreshKey]);

  const cancel = useCallback(
    async (rule: RuleDto) => {
      if (!wallet || !signMessage) {
        onLog('error', 'wallet cannot sign messages — cannot cancel rule');
        return;
      }
      setCancelling(rule.id);
      try {
        const auth = await buildWalletAuth('rules-delete', wallet, signMessage);
        await api(`/rules/${rule.id}`, { method: 'DELETE', body: JSON.stringify({ auth }) });
        onLog('rule', `rule cancelled: ${ruleTitle(rule)} on ${rule.fixtureId}`);
        setRules((current) => current.filter((r) => r.id !== rule.id));
      } catch (err) {
        onLog('error', `cancel rule: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setCancelling(null);
      }
    },
    [wallet, signMessage, onLog],
  );

  return { rules, loading, cancelling, refresh, cancel };
}

export function RuleStatusPill({ rule }: { rule: RuleDto }) {
  const d = rule.delegation;
  if (!d) return <span className="rounded-sm bg-surface-variant px-2 py-0.5 text-label-caps uppercase text-secondary">Prompt</span>;
  if (d.status === 'armed') return <span className="rounded-sm bg-primary-fixed px-2 py-0.5 text-label-caps uppercase text-primary">Delegated</span>;
  if (d.status === 'submitted')
    return (
      <span className="rounded-sm bg-primary-fixed px-2 py-0.5 text-label-caps uppercase text-primary" title={d.submittedSig ?? undefined}>
        Executed
      </span>
    );
  return <span className="rounded-sm bg-error-container px-2 py-0.5 text-label-caps uppercase text-on-error-container">Failed</span>;
}

function RuleCard({ rule, cancelling, onCancel }: { rule: RuleDto; cancelling: boolean; onCancel: () => void }) {
  return (
    <div className="rounded-lg border border-outline-variant bg-surface-container-lowest p-3 shadow-card">
      <div className="mb-2 flex items-start justify-between gap-2">
        <RuleStatusPill rule={rule} />
        <button onClick={onCancel} disabled={cancelling} className="text-label-sm text-outline transition-colors enabled:hover:text-error disabled:opacity-40">
          {cancelling ? 'Signing…' : 'Cancel'}
        </button>
      </div>
      <h4 className="mb-1 font-mono text-data-mono text-on-surface">{ruleTitle(rule)}</h4>
      <p className="text-body-sm text-outline">{ruleDescription(rule)}</p>
      <p className="mt-2 border-t border-surface-container-high pt-2 text-label-sm text-outline" title={rule.intentHash}>
        armed {clockTime(rule.createdAt)} · intent {rule.intentHash.slice(0, 12)}…
      </p>
    </div>
  );
}

/** Right-rail Quick Rules (terminal view). */
export function ArmedRulesPanel({
  wallet,
  refreshKey,
  onLog,
}: {
  wallet: string | null;
  refreshKey: number;
  onLog: (kind: 'rule' | 'error', text: string) => void;
}) {
  const { rules, loading, cancelling, cancel } = useArmedRules(wallet, refreshKey, onLog);

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-outline-variant p-4">
        <h3 className="text-title-md text-on-surface">Quick Rules</h3>
        <span className="text-label-sm text-outline">{loading ? 'loading…' : `${rules.length} armed`}</span>
      </div>
      <div className="no-scrollbar flex max-h-80 flex-col gap-3 overflow-y-auto bg-surface-container-low p-3">
        {!wallet && <p className="text-body-sm text-outline">Connect a wallet to see armed rules.</p>}
        {wallet && rules.length === 0 && !loading && <p className="text-body-sm text-outline">No rules armed. Use &ldquo;Arm Rule&rdquo; on a position.</p>}
        {rules.map((rule) => (
          <RuleCard key={rule.id} rule={rule} cancelling={cancelling === rule.id} onCancel={() => cancel(rule)} />
        ))}
      </div>
    </div>
  );
}
