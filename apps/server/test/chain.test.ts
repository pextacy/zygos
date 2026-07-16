import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { buildUnsignedMemoTx, lockCommitment, MEMO_PROGRAM_ID, memoInstruction, ruleCommitment } from '../src/chain/memo.js';
import {
  buildValidateOddsArgs,
  dailyBatchRootsPda,
  epochDayOf,
  loadOracleIdl,
  oddsValidationResponseSchema,
  tenDailyFixturesRootsPda,
  toBytes32,
  toProofNodes,
  TXORACLE,
  unpackFixtureId,
} from '../src/chain/txoracle.js';

const DEVNET_PROGRAM = new PublicKey(TXORACLE.devnet.programId);

describe('txoracle PDA derivation (official docs rules)', () => {
  it('derives epoch day from the proof timestamp, never the clock', () => {
    // 2026-07-16T18:00:00Z → ms/86_400_000
    expect(epochDayOf(1_784_224_800_000)).toBe(20_650);
  });

  it('daily_batch_roots PDA: seeds ["daily_batch_roots", epochDay u16 LE], deterministic and day-sensitive', () => {
    const a = dailyBatchRootsPda(DEVNET_PROGRAM, 20_650);
    const b = dailyBatchRootsPda(DEVNET_PROGRAM, 20_650);
    const c = dailyBatchRootsPda(DEVNET_PROGRAM, 20_651);
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
    // Independent re-derivation with raw seeds must agree.
    const buf = Buffer.alloc(2);
    buf.writeUInt16LE(20_650, 0);
    const [expected] = PublicKey.findProgramAddressSync([Buffer.from('daily_batch_roots'), buf], DEVNET_PROGRAM);
    expect(a.equals(expected)).toBe(true);
  });

  it('fixture roots use 10-day windows (floor(epochDay/10)*10)', () => {
    expect(tenDailyFixturesRootsPda(DEVNET_PROGRAM, 20_650).equals(tenDailyFixturesRootsPda(DEVNET_PROGRAM, 20_659))).toBe(true);
    expect(tenDailyFixturesRootsPda(DEVNET_PROGRAM, 20_650).equals(tenDailyFixturesRootsPda(DEVNET_PROGRAM, 20_660))).toBe(false);
  });

  it('unpacks game state from packed fixture ids (2^48 split)', () => {
    const packed = 5 * 2 ** 48 + 17_588_320; // gameState F (5) + fixture id
    expect(unpackFixtureId(packed)).toEqual({ fixtureId: 17_588_320, gameState: 5 });
    expect(unpackFixtureId(17_588_320)).toEqual({ fixtureId: 17_588_320, gameState: 0 });
  });

  it('both vendored IDLs load and carry the documented program addresses', () => {
    for (const network of ['devnet', 'mainnet-beta'] as const) {
      const idl = loadOracleIdl(network) as { address?: string };
      expect(idl.address).toBe(TXORACLE[network].programId);
    }
  });
});

describe('proof payload mapping', () => {
  it('toBytes32 accepts hex, 0x-hex, base64, and byte arrays; rejects garbage', () => {
    const hex = 'ab'.repeat(32);
    expect(toBytes32(hex)).toHaveLength(32);
    expect(toBytes32(`0x${hex}`)).toEqual(toBytes32(hex));
    expect(toBytes32(Buffer.from(hex, 'hex').toString('base64'))).toEqual(toBytes32(hex));
    expect(toBytes32(new Array(32).fill(7))).toEqual(new Array(32).fill(7));
    expect(() => toBytes32('not-a-hash')).toThrow(RangeError);
    expect(() => toBytes32(42)).toThrow(RangeError);
  });

  it('toProofNodes maps camelCase and snake_case sibling flags', () => {
    const hash = 'cd'.repeat(32);
    const nodes = toProofNodes([
      { hash, isRightSibling: true },
      { hash, is_right_sibling: false },
      { hash },
    ]);
    expect(nodes.map((n) => n.isRightSibling)).toEqual([true, false, false]);
    expect(nodes[0]?.hash).toHaveLength(32);
  });

  it('buildValidateOddsArgs maps the documented /api/odds/validation response into Anchor shapes', () => {
    const raw = {
      odds: {
        FixtureId: 17588320,
        MessageId: 'msg-1',
        Ts: 1_784_224_800_000,
        Bookmaker: 'book',
        BookmakerId: 7,
        SuperOddsType: '1x2',
        InRunning: true,
        GameState: 'H1',
        MarketParameters: null,
        MarketPeriod: 'FT',
        PriceNames: ['1', 'X', '2'],
        Prices: [2100, 3400, 3800],
      },
      summary: {
        fixtureId: 17588320,
        updateStats: { updateCount: 3, minTimestamp: 1_784_224_000_000, maxTimestamp: 1_784_225_000_000 },
        oddsSubTreeRoot: 'ef'.repeat(32),
      },
      subTreeProof: [{ hash: '11'.repeat(32), isRightSibling: true }],
      mainTreeProof: [{ hash: '22'.repeat(32), isRightSibling: false }],
    };
    const parsed = oddsValidationResponseSchema.parse(raw);
    const args = buildValidateOddsArgs(parsed);
    expect(args.oddsSnapshot.messageId).toBe('msg-1');
    expect(args.oddsSnapshot.prices).toEqual([2100, 3400, 3800]);
    expect(args.oddsSnapshot.gameState).toBe('H1');
    expect(args.summary.oddsSubTreeRoot).toHaveLength(32);
    expect(args.subTreeProof[0]?.isRightSibling).toBe(true);
    expect(args.ts.toString()).toBe('1784224800000');
  });
});

describe('memo commitments (single shared builder)', () => {
  it('lock commitment is order-insensitive over packet ids', () => {
    const a = lockCommitment({ fixtureId: 'fx', market: '1X2', side: 'HOME', fraction: 0.5, packetIds: ['p1', 'p2'] });
    const b = lockCommitment({ fixtureId: 'fx', market: '1X2', side: 'HOME', fraction: 0.5, packetIds: ['p2', 'p1'] });
    expect(a).toBe(b);
    expect(a).toMatch(/^zygos:lock:[0-9a-f]{64}$/);
    expect(ruleCommitment('ab'.repeat(32))).toBe(`zygos:rule:${'ab'.repeat(32)}`);
  });

  it('buildUnsignedMemoTx: unsigned, payer-set, compute-bounded, memo parseable back out', async () => {
    const payer = Keypair.generate().publicKey;
    const connection = {
      getLatestBlockhash: async () => ({ blockhash: '4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM', lastValidBlockHeight: 42 }),
    } as never;
    const memo = lockCommitment({ fixtureId: 'fx', market: '1X2', side: 'HOME', fraction: 1, packetIds: [] });

    const { txBase64, lastValidBlockHeight } = await buildUnsignedMemoTx(connection, payer, memo);
    expect(lastValidBlockHeight).toBe(42);

    const tx = Transaction.from(Buffer.from(txBase64, 'base64'));
    expect(tx.feePayer?.equals(payer)).toBe(true);
    expect(tx.signatures.every((s) => s.signature === null)).toBe(true); // strictly unsigned
    const memoIx = tx.instructions.find((ix) => ix.programId.equals(MEMO_PROGRAM_ID));
    expect(memoIx).toBeDefined();
    expect(memoIx?.data.toString('utf8')).toBe(memo);
    expect(tx.instructions.length).toBe(2); // compute budget + memo

    expect(memoInstruction('x').keys).toHaveLength(0);
  });
});
