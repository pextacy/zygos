'use client';

import { useCallback, useEffect, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { clockTime, ppmPct } from '../lib/format';
import { api } from '../lib/server';
import type { RuleDto } from '../lib/types';
import { buildWalletAuth, deserializeTx, isNonceAdvanceFor } from '../lib/wallet';

/** The rule's trigger condition, one way, everywhere it renders (cards + Automation table). */
export function thresholdLabel(rule: RuleDto): string {
  const sign = rule.direction === 'ABOVE' ? '≥' : '≤';
  return `${sign} ${ppmPct(rule.thresholdPpm ?? 0)}`;
}

export function ruleTitle(rule: RuleDto): string {
  const pctLabel = ppmPct(rule.fractionPpm);
  if (rule.template === 'PRICE_LOCK') return `Price lock · ${rule.team} ${thresholdLabel(rule)} · ${pctLabel}`;
  return rule.template === 'GOAL_LOCK' ? `Goal lock · ${rule.team} ${pctLabel}` : `Red card reduce · ${rule.team} ${pctLabel}`;
}

export function ruleDescription(rule: RuleDto): string {
  const pctLabel = ppmPct(rule.fractionPpm);
  if (rule.template === 'PRICE_LOCK') {
    const verb = rule.direction === 'ABOVE' ? 'rises above' : 'falls below';
    return `If TxLINE consensus for ${rule.team} in ${rule.fixtureId} ${verb} ${ppmPct(rule.thresholdPpm ?? 0)}, prepare a ${pctLabel} lock (one-shot).`;
  }
  return rule.template === 'GOAL_LOCK'
    ? `If ${rule.team} scores in ${rule.fixtureId}, prepare a ${pctLabel} lock for one-tap signing.`
    : `If ${rule.team} gets a red card in ${rule.fixtureId}, prepare a ${pctLabel} reduction.`;
}

/** Fetch + cancel armed rules for a wallet; shared by Quick Rules and the Automation view. */
export function useArmedRules(wallet: string | null, refreshKey: number, onLog: (kind: 'rule' | 'error', text: string) => void) {
  const { signMessage, sendTransaction } = useWallet();
  const { connection } = useConnection();
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

  /**
   * Revoke a delegation (security-review req 1): the server erases its stored
   * pre-signed tx immediately, then the wallet signs a nonce advance that
   * voids any leaked copy on-chain.
   */
  const revoke = useCallback(
    async (rule: RuleDto) => {
      if (!wallet || !signMessage) {
        onLog('error', 'wallet cannot sign messages — cannot revoke delegation');
        return;
      }
      setCancelling(rule.id);
      try {
        const auth = await buildWalletAuth('rules-revoke', wallet, signMessage);
        const res = await api<{ revoked: true; noncePubkey: string; revokeTxBase64: string | null }>(`/rules/${rule.id}/revoke`, {
          method: 'POST',
          body: JSON.stringify({ auth }),
        });
        onLog('rule', `delegation revoked server-side for ${ruleTitle(rule)} — pre-signed tx erased`);
        if (res.revokeTxBase64) {
          // Simulate-before-sign (CLAUDE.md §2.4) + independent shape check:
          // the server-supplied tx must be exactly one nonce advance on the
          // declared account, fee-paid and authorized by THIS wallet — a
          // compromised response never reaches the signature prompt.
          const revokeTx = deserializeTx(res.revokeTxBase64);
          if ('version' in revokeTx) throw new Error('refusing to sign: revoke tx must be a legacy transaction');
          if (!revokeTx.feePayer?.equals(new PublicKey(wallet))) throw new Error('refusing to sign: revoke tx fee payer is not this wallet');
          if (revokeTx.instructions.length !== 1 || !isNonceAdvanceFor(revokeTx.instructions[0], new PublicKey(wallet), res.noncePubkey)) {
            throw new Error('refusing to sign: revoke tx must contain exactly one nonce advance on the declared nonce account');
          }
          const sim = await connection.simulateTransaction(revokeTx);
          if (sim.value.err) throw new Error(`revoke tx failed simulation — not signing: ${JSON.stringify(sim.value.err)}`);
          const sig = await sendTransaction(revokeTx, connection);
          onLog('rule', `nonce advanced on-chain (${sig}) — every outstanding pre-signed tx on ${res.noncePubkey.slice(0, 8)}… is now void`);
        } else {
          onLog('error', 'no RPC on server: stored tx erased, but sign a nonce advance later to void any leaked copy');
        }
        refresh();
      } catch (err) {
        onLog('error', `revoke: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setCancelling(null);
      }
    },
    [wallet, signMessage, sendTransaction, connection, onLog, refresh],
  );

  return { rules, loading, cancelling, refresh, cancel, revoke };
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
  if (d.status === 'revoked') return <span className="rounded-sm bg-surface-variant px-2 py-0.5 text-label-caps uppercase text-outline">Revoked</span>;
  return <span className="rounded-sm bg-error-container px-2 py-0.5 text-label-caps uppercase text-on-error-container">Failed</span>;
}

function RuleCard({ rule, cancelling, onCancel, onRevoke }: { rule: RuleDto; cancelling: boolean; onCancel: () => void; onRevoke: () => void }) {
  return (
    <div className="rounded-lg border border-outline-variant bg-surface-container-lowest p-3 shadow-card">
      <div className="mb-2 flex items-start justify-between gap-2">
        <RuleStatusPill rule={rule} />
        <span className="flex gap-3">
          {rule.delegation?.status === 'armed' && (
            <button
              onClick={onRevoke}
              disabled={cancelling}
              title="Erase the stored pre-signed tx and void it on-chain via a nonce advance"
              className="text-label-sm text-outline transition-colors enabled:hover:text-error disabled:opacity-40"
            >
              Revoke
            </button>
          )}
          <button onClick={onCancel} disabled={cancelling} className="text-label-sm text-outline transition-colors enabled:hover:text-error disabled:opacity-40">
            {cancelling ? 'Signing…' : 'Cancel'}
          </button>
        </span>
      </div>
      <h4 className="mb-1 font-mono text-data-mono text-on-surface">{ruleTitle(rule)}</h4>
      <p className="text-body-sm text-outline">{ruleDescription(rule)}</p>
      <p className="mt-2 border-t border-surface-container-high pt-2 text-label-sm text-outline" title={rule.intentHash}>
        armed {clockTime(rule.createdAt)} · intent {rule.intentHash.slice(0, 12)}…
        {rule.firedAt !== null && rule.firedAt !== undefined && <span className="text-primary"> · fired {clockTime(rule.firedAt)}</span>}
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
  const { rules, loading, cancelling, cancel, revoke } = useArmedRules(wallet, refreshKey, onLog);

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
          <RuleCard key={rule.id} rule={rule} cancelling={cancelling === rule.id} onCancel={() => cancel(rule)} onRevoke={() => revoke(rule)} />
        ))}
      </div>
    </div>
  );
}
