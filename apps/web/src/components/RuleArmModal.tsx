'use client';

import { Buffer } from 'buffer';
import { useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { SystemProgram } from '@solana/web3.js';
import { api } from '../lib/server';
import type { RuleDto, ValuedPositionDto } from '../lib/types';
import { buildWalletAuth, deserializeTx, isNonceAdvanceFor } from '../lib/wallet';
import { IconClose } from './Icons';

/** Arm a protective rule (FR-40/41): stored server-side, intent hash committed on-chain by the user's own signature. */
export function RuleArmModal({
  dto,
  onClose,
  onLog,
}: {
  dto: ValuedPositionDto;
  onClose: (armed?: boolean) => void;
  onLog: (kind: 'rule' | 'error', text: string) => void;
}) {
  const { publicKey, signMessage, signTransaction, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const [template, setTemplate] = useState<'GOAL_LOCK' | 'RED_CARD_REDUCE' | 'PRICE_LOCK'>('GOAL_LOCK');
  const [fraction, setFraction] = useState(70);
  const [threshold, setThreshold] = useState(() => Math.min(95, Math.round((dto.valuation?.consensusProb ?? 0.5) * 100) + 10));
  const [direction, setDirection] = useState<'ABOVE' | 'BELOW'>('ABOVE');
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
    // Independent client-side check before signing (security-review req 2,
    // bounded): the server-built tx must pay fees from THIS wallet, lead with
    // exactly one nonceAdvance on the declared nonce account, and contain no
    // other System-program instruction (blocks hidden SOL transfers /
    // account closes). The wallet's own instruction display remains the
    // final review surface.
    if (!tx.feePayer?.equals(publicKey)) throw new Error('refusing to sign: delegated tx fee payer is not this wallet');
    const [first, ...rest] = tx.instructions;
    if (!isNonceAdvanceFor(first, publicKey, step.noncePubkey)) {
      throw new Error('refusing to sign: first instruction must be a nonce advance on the declared nonce account, authorized by this wallet');
    }
    if (rest.some((ix) => ix.programId.equals(SystemProgram.programId))) {
      throw new Error('refusing to sign: unexpected extra System-program instruction in delegated tx');
    }
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
          ...(template === 'PRICE_LOCK' ? { threshold: threshold / 100, direction } : {}),
          auth,
        }),
      });
      onLog(
        'rule',
        `rule armed: ${template}${template === 'PRICE_LOCK' ? ` ${direction === 'ABOVE' ? '≥' : '≤'}${threshold}%` : ''} ${fraction}% on ${dto.position.fixtureId} (intent ${rule.intentHash.slice(0, 12)}…)`,
      );

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
      onClose(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-tertiary/40 p-4 backdrop-blur-sm" onClick={() => onClose()}>
      <div className="w-full max-w-sm rounded-xl border border-outline-variant bg-surface-container-lowest p-5 shadow-float" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-surface-container-high pb-3">
          <h3 className="text-title-md text-on-surface">Arm Rule</h3>
          <button onClick={() => onClose()} aria-label="Close" className="rounded-full p-1 text-outline transition-colors hover:bg-surface-container-high hover:text-on-surface">
            <IconClose className="h-4 w-4" />
          </button>
        </div>
        <p className="mt-2 font-mono text-label-sm text-outline">
          {dto.position.fixtureId} · {team}
        </p>

        <div className="mt-4 space-y-2 text-body-md text-on-surface">
          <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-outline-variant p-2.5 has-[:checked]:border-primary has-[:checked]:bg-primary-fixed/40">
            <input type="radio" checked={template === 'GOAL_LOCK'} onChange={() => setTemplate('GOAL_LOCK')} className="accent-primary" />
            <span>
              If <span className="font-semibold text-primary">{team} scores</span>, prepare a {fraction}% lock
            </span>
          </label>
          <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-outline-variant p-2.5 has-[:checked]:border-primary has-[:checked]:bg-primary-fixed/40">
            <input type="radio" checked={template === 'RED_CARD_REDUCE'} onChange={() => setTemplate('RED_CARD_REDUCE')} className="accent-primary" />
            <span>
              If <span className="font-semibold text-error">{team} gets a red card</span>, prepare a {fraction}% reduction
            </span>
          </label>
          <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-outline-variant p-2.5 has-[:checked]:border-primary has-[:checked]:bg-primary-fixed/40">
            <input type="radio" checked={template === 'PRICE_LOCK'} onChange={() => setTemplate('PRICE_LOCK')} className="accent-primary" />
            <span>
              If <span className="font-semibold text-primary">TxLINE consensus for {team}</span> crosses a target, prepare a {fraction}% lock (one-shot)
            </span>
          </label>
        </div>

        {template === 'PRICE_LOCK' && (
          <div className="mt-3 rounded-lg border border-outline-variant bg-surface-container-low p-3">
            <div className="flex items-center gap-2">
              <select
                value={direction}
                onChange={(e) => setDirection(e.target.value as 'ABOVE' | 'BELOW')}
                className="rounded border border-outline-variant bg-surface-container-lowest p-1.5 text-body-sm text-on-surface"
                aria-label="Trigger direction"
              >
                <option value="ABOVE">rises above</option>
                <option value="BELOW">falls below</option>
              </select>
              <span className="font-mono text-data-mono text-on-surface">{threshold}%</span>
              {dto.valuation && <span className="text-label-sm text-outline">(now {Math.round(dto.valuation.consensusProb * 100)}%)</span>}
            </div>
            <input type="range" min={1} max={99} step={1} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} className="mt-2 w-full accent-primary" aria-label="Consensus threshold" />
            <p className="mt-1 text-label-sm text-outline">
              Fires once, on the tick that crosses the target — a take-profit ({direction === 'ABOVE' ? 'lock strength' : 'cut weakness'}) on TxLINE fair value.
            </p>
          </div>
        )}

        <label className="mt-4 block text-label-sm text-outline">
          Fraction: <span className="font-mono text-data-mono text-on-surface">{fraction}%</span>
          <input type="range" min={10} max={100} step={5} value={fraction} onChange={(e) => setFraction(Number(e.target.value))} className="mt-2 w-full accent-primary" />
        </label>

        <label className="mt-4 flex items-start gap-2 text-body-sm leading-4 text-outline">
          <input type="checkbox" checked={delegated} onChange={(e) => setDelegated(e.target.checked)} className="mt-0.5 accent-primary" />
          <span>
            <span className="font-semibold text-on-surface">Delegate execution (v2):</span> pre-sign the exact lock now on a durable nonce; it is
            submitted automatically when the event fires. The server can only ever land this one pre-agreed transaction.
          </span>
        </label>

        <p className="mt-3 text-body-sm leading-4 text-outline">
          {delegated
            ? 'You sign once, up front, with slippage bounds baked in — nothing to tap at match time.'
            : 'Rules never auto-sign. When the event fires, a pre-built simulated transaction appears for one-tap signing — you stay in control.'}
        </p>

        {error && <p className="mt-3 text-body-sm text-error">{error}</p>}

        <button
          disabled={busy || !publicKey}
          onClick={arm}
          className="mt-4 w-full rounded bg-primary py-2.5 font-mono text-data-mono text-on-primary transition-colors enabled:hover:bg-primary-container disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? 'Signing…' : 'Arm Rule'}
        </button>
      </div>
    </div>
  );
}
