import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { locks, type Db } from './db.js';

/**
 * Lock ledger: the persistent record of every verified executed lock and the
 * edge it captured vs TxLINE fair value. Extends FR-33: the on-chain memo
 * timestamps the lock, this ledger makes it queryable — per-wallet history
 * plus cumulative edge stats survive restarts and power GET /locks/:wallet.
 * Plan-derived fields come only from server-built previews (never trusted
 * from the client), so a record's edge is exactly what the user signed against.
 */

export type LockSource = 'MANUAL' | 'RULE' | 'DELEGATED';

export interface LockRecord {
  id: string;
  wallet: string;
  positionRef: string;
  fixtureId: string;
  market: string;
  outcome: string;
  fractionPpm: number;
  route: 'CLOSE' | 'HEDGE' | null;
  /** µUSD as string; null when no server-side preview backed the execution. */
  guaranteedFloor: string | null;
  edgePts: number | null;
  impliedExitProb: number | null;
  packetIds: string[];
  consensusAsOf: number | null;
  txSig: string | null;
  /** Signature of the on-chain memo commitment (FR-33); attached once the user signs it. */
  memoSig: string | null;
  source: LockSource;
  ruleId: string | null;
  sizeBefore: string | null;
  sizeAfter: string | null;
  executedAt: number;
}

export interface LockStats {
  count: number;
  /** Σ guaranteedFloor over locks that carry one, µUSD as string. */
  totalGuaranteedFloor: string;
  /** Mean edge (probability points) over locks with a preview-backed edge. */
  avgEdgePts: number | null;
  positiveEdgeCount: number;
  lastLockAt: number | null;
}

export class LockLedger {
  constructor(private readonly db: Db) {}

  /** memoSig is never known at record time — it is attached later via attachMemoSig. */
  async record(entry: Omit<LockRecord, 'id' | 'memoSig'>): Promise<LockRecord> {
    const rec: LockRecord = { ...entry, id: randomUUID(), memoSig: null };
    await this.db
      .insert(locks)
      .values({
        id: rec.id,
        wallet: rec.wallet,
        positionRef: rec.positionRef,
        fixtureId: rec.fixtureId,
        market: rec.market,
        outcome: rec.outcome,
        fractionPpm: rec.fractionPpm,
        route: rec.route,
        guaranteedFloor: rec.guaranteedFloor,
        edgePts: rec.edgePts,
        impliedExitProb: rec.impliedExitProb,
        packetIds: JSON.stringify(rec.packetIds),
        consensusAsOf: rec.consensusAsOf,
        txSig: rec.txSig,
        memoSig: null,
        source: rec.source,
        ruleId: rec.ruleId,
        sizeBefore: rec.sizeBefore,
        sizeAfter: rec.sizeAfter,
        executedAt: rec.executedAt,
      });
    return rec;
  }

  /**
   * Attach the memo-commitment signature to a lock after the user signs the
   * memo tx (FR-33: completes the audit chain lock-tx → memo-tx). Wallet-bound:
   * only the lock's owner can attach. Returns false when no such lock exists.
   */
  async attachMemoSig(id: string, wallet: string, memoSig: string): Promise<boolean> {
    const updated = await this.db
      .update(locks)
      .set({ memoSig })
      .where(and(eq(locks.id, id), eq(locks.wallet, wallet)))
      .returning({ id: locks.id });
    return updated.length > 0;
  }

  /** Newest first. */
  async list(wallet: string): Promise<LockRecord[]> {
    const rows = await this.db.select().from(locks).where(eq(locks.wallet, wallet)).orderBy(desc(locks.executedAt));
    return rows.map(rowToRecord);
  }

  /** Pass `prefetched` rows from a prior list() call to avoid re-running the same query. */
  async stats(wallet: string, prefetched?: LockRecord[]): Promise<LockStats> {
    const rows = prefetched ?? (await this.list(wallet));
    let totalFloor = 0n;
    let edgeSum = 0;
    let edgeCount = 0;
    let positiveEdgeCount = 0;
    for (const row of rows) {
      if (row.guaranteedFloor !== null) totalFloor += BigInt(row.guaranteedFloor);
      if (row.edgePts !== null) {
        edgeSum += row.edgePts;
        edgeCount += 1;
        if (row.edgePts > 0) positiveEdgeCount += 1;
      }
    }
    return {
      count: rows.length,
      totalGuaranteedFloor: totalFloor.toString(),
      avgEdgePts: edgeCount > 0 ? edgeSum / edgeCount : null,
      positiveEdgeCount,
      lastLockAt: rows[0]?.executedAt ?? null,
    };
  }
}

function rowToRecord(row: typeof locks.$inferSelect): LockRecord {
  let packetIds: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.packetIds);
    if (Array.isArray(parsed)) packetIds = parsed.filter((p): p is string => typeof p === 'string');
  } catch {
    // corrupt row survives as an empty provenance list rather than a 500
  }
  return {
    id: row.id,
    wallet: row.wallet,
    positionRef: row.positionRef,
    fixtureId: row.fixtureId,
    market: row.market,
    outcome: row.outcome,
    fractionPpm: row.fractionPpm,
    route: row.route === 'CLOSE' || row.route === 'HEDGE' ? row.route : null,
    guaranteedFloor: row.guaranteedFloor,
    edgePts: row.edgePts,
    impliedExitProb: row.impliedExitProb,
    packetIds,
    consensusAsOf: row.consensusAsOf,
    txSig: row.txSig,
    memoSig: row.memoSig,
    source: row.source as LockSource,
    ruleId: row.ruleId,
    sizeBefore: row.sizeBefore,
    sizeAfter: row.sizeAfter,
    executedAt: row.executedAt,
  };
}
