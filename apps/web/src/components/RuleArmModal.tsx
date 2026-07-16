'use client';

import { Buffer } from 'buffer';
import { useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { api } from '../lib/server';
import type { RuleDto, ValuedPositionDto } from '../lib/types';
import { buildWalletAuth } from '../lib/wallet';

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

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
  const { publicKey, signMessage, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const [template, setTemplate] = useState<'GOAL_LOCK' | 'RED_CARD_REDUCE'>('GOAL_LOCK');
  const [fraction, setFraction] = useState(70);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const team = dto.position.outcome as 'HOME' | 'AWAY';

  async function arm() {
    if (!publicKey || !signMessage) return;
    setBusy(true);
    setError(null);
    try {
      const auth = await buildWalletAuth('rules-create', publicKey.toBase58(), signMessage);
      const { rule, memo } = await api<{ rule: RuleDto; memo: string }>('/rules', {
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

      // On-chain intent pre-commitment (FR-41): the user signs the memo themselves.
      try {
        const tx = new Transaction().add(
          new TransactionInstruction({ keys: [], programId: MEMO_PROGRAM_ID, data: Buffer.from(memo, 'utf8') }),
        );
        tx.feePayer = publicKey;
        tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
        const sig = await sendTransaction(tx, connection);
        onLog('rule', `intent hash committed on-chain: ${sig}`);
      } catch (memoErr) {
        onLog('error', `rule armed but intent memo not committed: ${memoErr instanceof Error ? memoErr.message : memoErr}`);
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

        <p className="mt-3 text-[11px] leading-4 text-terminal-dim">
          Rules never auto-sign. When the event fires, a pre-built simulated transaction appears for one-tap signing — you stay in control.
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
