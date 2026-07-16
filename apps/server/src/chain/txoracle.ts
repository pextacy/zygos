import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as anchor from '@coral-xyz/anchor';
import { ComputeBudgetProgram, Connection, Keypair, PublicKey } from '@solana/web3.js';
import { z } from 'zod';

/**
 * TxLINE oracle (txoracle) on-chain layer. Zygos deploys no program of its
 * own — its smart-contract surface is (a) the venue program, (b) the Memo
 * program for commitments, and (c) this oracle, against which we
 * cryptographically VERIFY the odds we display: any audited packet can be
 * proven to belong to the Merkle root TxODDS anchored on Solana
 * (`validate_odds`, view-only simulation — no state change, no fees paid).
 *
 * PDA and mapping rules follow the official docs (programs/addresses):
 * derive the epoch day from the PROOF's own timestamp, never from the clock.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

export const TXORACLE = {
  devnet: { programId: '6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J', idlPath: join(HERE, 'idl', 'txoracle.devnet.json') },
  'mainnet-beta': { programId: '9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA', idlPath: join(HERE, 'idl', 'txoracle.mainnet.json') },
} as const;

export type OracleNetwork = keyof typeof TXORACLE;

export function loadOracleIdl(network: OracleNetwork): anchor.Idl {
  return JSON.parse(readFileSync(TXORACLE[network].idlPath, 'utf8')) as anchor.Idl;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Epoch day from a proof/record timestamp (ms). NEVER derive from Date.now() (official docs rule). */
export function epochDayOf(tsMs: number): number {
  return Math.floor(tsMs / MS_PER_DAY);
}

/** Odds proofs verify against the daily batch roots account: seeds ["daily_batch_roots", epochDay u16 LE]. */
export function dailyBatchRootsPda(programId: PublicKey, epochDay: number): PublicKey {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(epochDay, 0);
  return PublicKey.findProgramAddressSync([Buffer.from('daily_batch_roots'), buf], programId)[0];
}

/** Fixture roots live in 10-day windows: seeds ["ten_daily_fixtures_roots", windowStartDay u16 LE]. */
export function tenDailyFixturesRootsPda(programId: PublicKey, epochDay: number): PublicKey {
  const windowStartDay = Math.floor(epochDay / 10) * 10;
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(windowStartDay, 0);
  return PublicKey.findProgramAddressSync([Buffer.from('ten_daily_fixtures_roots'), buf], programId)[0];
}

/** Fixture ids on-chain pack the game state above 2^48: unpack both halves. */
export function unpackFixtureId(packed: number): { fixtureId: number; gameState: number } {
  const SHIFT = 2 ** 48;
  return { fixtureId: packed % SHIFT, gameState: Math.floor(packed / SHIFT) };
}

/** 32-byte value from the proof API: hex (with/without 0x) or base64. Fails loudly on anything else. */
export function toBytes32(value: unknown): number[] {
  if (Array.isArray(value) && value.length === 32) return value.map((v) => Number(v));
  if (typeof value === 'string') {
    const hex = value.startsWith('0x') ? value.slice(2) : value;
    if (/^[0-9a-fA-F]{64}$/.test(hex)) return [...Buffer.from(hex, 'hex')];
    const b64 = Buffer.from(value, 'base64');
    if (b64.length === 32) return [...b64];
  }
  throw new RangeError(`cannot interpret Merkle hash as 32 bytes: ${JSON.stringify(value).slice(0, 80)}`);
}

const proofNodeSchema = z
  .object({
    hash: z.unknown(),
    isRightSibling: z.boolean().optional(),
    is_right_sibling: z.boolean().optional(),
  })
  .passthrough();

export interface AnchorProofNode {
  hash: number[];
  isRightSibling: boolean;
}

export function toProofNodes(value: unknown): AnchorProofNode[] {
  const arr = z.array(proofNodeSchema).parse(value);
  return arr.map((n) => ({
    hash: toBytes32(n.hash),
    isRightSibling: n.isRightSibling ?? n.is_right_sibling ?? false,
  }));
}

/** GET /api/odds/validation response (api-reference/odds proof endpoint). */
export const oddsValidationResponseSchema = z
  .object({
    odds: z
      .object({
        FixtureId: z.number().int(),
        MessageId: z.string(),
        Ts: z.number().int(),
        Bookmaker: z.string(),
        BookmakerId: z.number().int(),
        SuperOddsType: z.string(),
        InRunning: z.boolean(),
        GameState: z.string().nullish(),
        MarketParameters: z.string().nullish(),
        MarketPeriod: z.string().nullish(),
        PriceNames: z.array(z.string()).default([]),
        Prices: z.array(z.number().int()).default([]),
      })
      .passthrough(),
    summary: z
      .object({
        fixtureId: z.number().int(),
        updateStats: z.object({
          updateCount: z.number().int(),
          minTimestamp: z.number().int(),
          maxTimestamp: z.number().int(),
        }),
        oddsSubTreeRoot: z.unknown(),
      })
      .passthrough(),
    subTreeProof: z.unknown(),
    mainTreeProof: z.unknown(),
  })
  .passthrough();

export type OddsValidationResponse = z.infer<typeof oddsValidationResponseSchema>;

/** Map the proof response into the Anchor arg shapes of `validate_odds`. */
export function buildValidateOddsArgs(v: OddsValidationResponse) {
  const BN = anchor.BN;
  return {
    ts: new BN(v.odds.Ts),
    oddsSnapshot: {
      fixtureId: new BN(v.odds.FixtureId),
      messageId: v.odds.MessageId,
      ts: new BN(v.odds.Ts),
      bookmaker: v.odds.Bookmaker,
      bookmakerId: v.odds.BookmakerId,
      superOddsType: v.odds.SuperOddsType,
      gameState: v.odds.GameState ?? null,
      inRunning: v.odds.InRunning,
      marketParameters: v.odds.MarketParameters ?? null,
      marketPeriod: v.odds.MarketPeriod ?? null,
      priceNames: v.odds.PriceNames,
      prices: v.odds.Prices,
    },
    summary: {
      fixtureId: new BN(v.summary.fixtureId),
      updateStats: {
        updateCount: v.summary.updateStats.updateCount,
        minTimestamp: new BN(v.summary.updateStats.minTimestamp),
        maxTimestamp: new BN(v.summary.updateStats.maxTimestamp),
      },
      oddsSubTreeRoot: toBytes32(v.summary.oddsSubTreeRoot),
    },
    subTreeProof: toProofNodes(v.subTreeProof),
    mainTreeProof: toProofNodes(v.mainTreeProof),
  };
}

export interface OddsVerification {
  verified: boolean;
  fixtureId: number;
  messageId: string;
  ts: number;
  epochDay: number;
  rootsAccount: string;
  programId: string;
}

/**
 * Verify one odds record against the on-chain Merkle root via read-only
 * simulation (`.view()`): proves the displayed price is exactly what TxODDS
 * anchored on Solana. Costs nothing and changes no state; the throwaway
 * keypair below only fills Anchor's provider slot for simulation.
 */
export class TxOracleValidator {
  private readonly program: anchor.Program;

  constructor(connection: Connection, network: OracleNetwork) {
    const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(Keypair.generate()), { commitment: 'confirmed' });
    this.program = new anchor.Program(loadOracleIdl(network), provider);
    if (this.program.programId.toBase58() !== TXORACLE[network].programId) {
      throw new Error(`IDL program ${this.program.programId.toBase58()} does not match ${network}`);
    }
  }

  async validateOdds(raw: unknown): Promise<OddsVerification> {
    const v = oddsValidationResponseSchema.parse(raw);
    const args = buildValidateOddsArgs(v);
    const epochDay = epochDayOf(v.odds.Ts);
    const pda = dailyBatchRootsPda(this.program.programId, epochDay);

    const method = this.program.methods['validateOdds'];
    if (method === undefined) throw new Error('IDL has no validateOdds instruction');

    const verified = (await method(args.ts, args.oddsSnapshot, args.summary, args.subTreeProof, args.mainTreeProof)
      .accounts({ dailyOddsMerkleRoots: pda })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })])
      .view()) as boolean;

    return {
      verified,
      fixtureId: v.odds.FixtureId,
      messageId: v.odds.MessageId,
      ts: v.odds.Ts,
      epochDay,
      rootsAccount: pda.toBase58(),
      programId: this.program.programId.toBase58(),
    };
  }
}
