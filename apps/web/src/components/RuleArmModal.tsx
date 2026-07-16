'use client';

import { Buffer } from 'buffer';
import { useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { api } from '../lib/server';
import type { RuleDto, ValuedPositionDto } from '../lib/types';
import { buildWalletAuth, deserializeTx } from '../lib/wallet';

/** Arm a protective rule (FR-40/41): stored server-side, intent hash committed on-chain by the user's own signature. */
export function RuleArmModal({
  dto,
  onClose,
  onLog,
}: {
  dto: ValuedPositionDto;
  onClose: () => void;
  onLog: (kind: 'rule' | 'error', text: string) => void;
}) {
  const { publicKey, signMessage, signTransaction, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const [template, setTemplate] = useState<'GOAL_LOCK' | 'RED_CARD_REDUCE'>('GOAL_LOCK');
  const [fraction, setFraction] = useState(70);
  const [delegated, setDelegated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const team = dto.position.outcome as 'HOME' | 'AWAY';

  /** Phase 4 delegated flow: nonce setup (if needed) → pre-sign the durable-nonce lock → server stores it. */
  async function delegate(ruleId: string) {
    if (!publicKey || !signMessage || !signTransaction) {
      onLog('error', 'wallet does not support signTransaction — delegated mode unavailable, rule stays prompt-based');
      return;
    }
    const authFor = (action: string) => buildWalletAuth(action, publicKey.toBase58(), signMessage);

    let step = await api<
      | { kind: 'NONCE_SETUP'; noncePubkey: string; setupTxBase64: string }
      | { kind: 'DELEGATE_TX'; noncePubkey: string; delegateTxBase64: string }
    >(`/rules/${ruleId}/delegate`, { method: 'POST', body: JSON.stringify({ auth: await authFor('rules-delegate') }) });

    if (step.kind === 'NONCE_SETUP') {
      onLog('rule', 'creating your durable-nonce account (one-time)…');
      const sig = await sendTransaction(deserializeTx(step.setupTxBase64), connection);
      await connection.confirmTransaction(sig, 'confirmed');
      step = await api<typeof step>(`/rules/${ruleId}/delegate`, {
        method: 'POST',
        body: JSON.stringify({ auth: await authFor('rules-delegate'), noncePubkey: step.noncePubkey }),
      });
    }
    if (step.kind !== 'DELEGATE_TX') throw new Error('unexpected delegation step');

    const tx = deserializeTx(step.delegateTxBase64);
    if ('version' in tx) throw new Error('versioned tx cannot be delegated');
    const signed = await signTransaction(tx);
    await api(`/rules/${ruleId}/delegate`, {
      method: 'PUT',
      body: JSON.stringify({
        auth: await authFor('rules-delegate-store'),
        noncePubkey: step.noncePubkey,
        signedTxBase64: Buffer.from(signed.serialize({ requireAllSignatures: false })).toString('base64'),
      }),
    });
    onLog('rule', 'delegated execution armed: your pre-signed lock will be submitted the moment the rule fires — no signature needed at match time');
  }

  async function arm() {
    if (!publicKey || !signMessage) return;
    setBusy(true);
    setError(null);
    try {
      const auth = await buildWalletAuth('rules-create', publicKey.toBase58(), signMessage);
      const { rule, memoTxBase64 } = await api<{ rule: RuleDto; memo: string; memoTxBase64: string | null }>('/rules', {
        method: 'POST',
        body: JSON.stringify({
          wallet: publicKey.toBase58(),
          positionRef: dto.position.positionRef,
          template,
          team,
          fraction: fraction / 100,
          auth,
        }),
      });
      onLog('rule', `rule armed: ${template} ${fraction}% on ${dto.position.fixtureId} (intent ${rule.intentHash.slice(0, 12)}…)`);

      if (delegated) {
        try {
          await delegate(rule.id);
        } catch (delegateErr) {
          onLog('error', `delegation failed — rule stays prompt-based: ${delegateErr instanceof Error ? delegateErr.message : delegateErr}`);
        }
      }

      // On-chain intent pre-commitment (FR-41): server-built unsigned memo tx, signed only here.
      if (memoTxBase64) {
        try {
          const sig = await sendTransaction(deserializeTx(memoTxBase64), connection);
          onLog('rule', `intent hash committed on-chain: ${sig}`);
        } catch (memoErr) {
          onLog('error', `rule armed but intent memo not committed: ${memoErr instanceof Error ? memoErr.message : memoErr}`);
        }
      } else {
        onLog('error', 'rule armed without on-chain commitment (server has no RPC) — re-arm once RPC is configured');
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded border border-terminal-border bg-terminal-panel p-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-xs uppercase tracking-widest text-terminal-dim">Arm rule — {dto.position.fixtureId} · {team}</h3>
          <button onClick={onClose} className="text-terminal-dim hover:text-terminal-text">✕</button>
        </div>

        <div className="mt-3 space-y-2 text-sm">
          <label className="flex items-center gap-2">
            <input type="radio" checked={template === 'GOAL_LOCK'} onChange={() => setTemplate('GOAL_LOCK')} className="accent-terminal-accent" />
            <span>
              If <span className="text-terminal-accent">{team} scores</span>, prepare a {fraction}% lock
            </span>
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={template === 'RED_CARD_REDUCE'} onChange={() => setTemplate('RED_CARD_REDUCE')} className="accent-terminal-accent" />
            <span>
              If <span className="text-terminal-danger">{team} gets a red card</span>, prepare a {fraction}% reduction
            </span>
          </label>
        </div>

        <label className="mt-3 block text-xs text-terminal-dim">
          Fraction: <span className="text-terminal-text">{fraction}%</span>
          <input type="range" min={10} max={100} step={5} value={fraction} onChange={(e) => setFraction(Number(e.target.value))} className="mt-1 w-full accent-terminal-accent" />
        </label>

        <label className="mt-3 flex items-start gap-2 text-[11px] leading-4 text-terminal-dim">
          <input type="checkbox" checked={delegated} onChange={(e) => setDelegated(e.target.checked)} className="mt-0.5 accent-terminal-accent" />
          <span>
            <span className="text-terminal-text">Delegate execution (v2):</span> pre-sign the exact lock now on a durable nonce; it is
            submitted automatically when the event fires. The server can only ever land this one pre-agreed transaction.
          </span>
        </label>

        <p className="mt-3 text-[11px] leading-4 text-terminal-dim">
          {delegated
            ? 'You sign once, up front, with slippage bounds baked in — nothing to tap at match time.'
            : 'Rules never auto-sign. When the event fires, a pre-built simulated transaction appears for one-tap signing — you stay in control.'}
        </p>

        {error && <p className="mt-2 text-xs text-terminal-danger">{error}</p>}

        <button
          disabled={busy || !publicKey}
          onClick={arm}
          className="mt-3 w-full rounded border border-terminal-accent py-2 text-sm uppercase tracking-widest text-terminal-accent enabled:hover:bg-terminal-accent enabled:hover:text-terminal-bg disabled:opacity-40"
        >
          {busy ? 'signing…' : 'Arm rule'}
        </button>
      </div>
    </div>
  );
}
