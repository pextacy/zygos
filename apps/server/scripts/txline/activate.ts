/**
 * TxLINE free-tier activation (PLAN.md T0.1/T1.1 unblocker):
 *   pnpm -F server txline:activate [--network devnet|mainnet-beta] [--service-level 1|12]
 *
 * Mirrors the official flow (github.com/txodds/tx-on-chain, Apache-2.0; see
 * packages/venue-adapters/src/txline/SCHEMA.md):
 *   wallet → (devnet airdrop) → TxL Token-2022 ATA → on-chain subscribe →
 *   guest JWT → sign `${txSig}::${jwt}` → POST /api/token/activate → API token.
 *
 * The keypair created here is a PROJECT feed-subscription wallet stored under
 * ./data (gitignored) — it is not a user wallet and never holds user funds
 * (CLAUDE.md §2.2 concerns user custody; the feed subscription is ours).
 *
 * NOTE: some ISPs (Turkish "Güvenli İnternet" family profiles) block
 * *.txodds.com — run this from an unfiltered network if guest auth fails.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as anchor from '@coral-xyz/anchor';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import nacl from 'tweetnacl';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, '..', '..', 'data');

const NETWORKS = {
  devnet: {
    rpcUrl: 'https://api.devnet.solana.com',
    apiOrigin: 'https://txline-dev.txodds.com',
    idlPath: join(HERE, '..', '..', 'src', 'chain', 'idl', 'txoracle.devnet.json'),
    txlTokenMint: new PublicKey('4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG'),
    canAirdrop: true,
  },
  'mainnet-beta': {
    rpcUrl: 'https://api.mainnet-beta.solana.com',
    apiOrigin: 'https://txline.txodds.com',
    idlPath: join(HERE, '..', '..', 'src', 'chain', 'idl', 'txoracle.mainnet.json'),
    txlTokenMint: new PublicKey('Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL'),
    canAirdrop: false,
  },
} as const;

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  const value = i !== -1 ? process.argv[i + 1] : undefined;
  return value ?? fallback;
}

const networkName = arg('--network', process.env.CLUSTER ?? 'devnet') as keyof typeof NETWORKS;
const serviceLevel = Number(arg('--service-level', '1'));
const DURATION_WEEKS = 4;
const SELECTED_LEAGUES: number[] = []; // standard free bundle

const net = NETWORKS[networkName];
if (!net) {
  console.error(`unknown network "${networkName}" — use devnet or mainnet-beta`);
  process.exit(2);
}

const rpcUrl = process.env.RPC_URL ?? net.rpcUrl;
const walletPath = join(DATA_DIR, `txline-wallet-${networkName}.json`);
const statePath = join(DATA_DIR, `txline-activation-${networkName}.json`);

mkdirSync(DATA_DIR, { recursive: true });

// ---- wallet ----
let keypair: Keypair;
if (existsSync(walletPath)) {
  keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(walletPath, 'utf8'))));
  console.log(`wallet: ${keypair.publicKey.toBase58()} (existing, ${walletPath})`);
} else {
  keypair = Keypair.generate();
  writeFileSync(walletPath, JSON.stringify([...keypair.secretKey]), { mode: 0o600 });
  console.log(`wallet: ${keypair.publicKey.toBase58()} (NEW — saved to ${walletPath})`);
}

interface ActivationState {
  txSig?: string;
  apiToken?: string;
}
const state: ActivationState = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, 'utf8')) as ActivationState) : {};
const saveState = () => writeFileSync(statePath, JSON.stringify(state, null, 2));

if (state.apiToken) {
  console.log('API token already activated. Add to apps/server/.env:');
  console.log(`  TXLINE_ORIGIN=${net.apiOrigin}`);
  console.log(`  TXLINE_API_TOKEN=${state.apiToken}`);
  process.exit(0);
}

const connection = new Connection(rpcUrl, 'confirmed');

// ---- funding ----
const balance = await connection.getBalance(keypair.publicKey);
console.log(`balance: ${balance / 1e9} SOL on ${networkName}`);
if (balance < 0.01 * 1e9) {
  if (net.canAirdrop) {
    // The public faucet rate-limits aggressively; retry with decreasing amounts.
    let funded = false;
    for (const sol of [0.5, 0.2, 0.1, 0.05]) {
      try {
        console.log(`requesting ${sol} SOL devnet airdrop…`);
        const sig = await connection.requestAirdrop(keypair.publicKey, Math.round(sol * 1e9));
        await connection.confirmTransaction(sig, 'confirmed');
        console.log('airdrop confirmed');
        funded = true;
        break;
      } catch (err) {
        console.warn(`airdrop failed (${err instanceof Error ? err.message.slice(0, 80) : err}); retrying smaller…`);
        await new Promise((r) => setTimeout(r, 3_000));
      }
    }
    if (!funded) {
      console.error(`devnet faucet exhausted. Fund manually at https://faucet.solana.com for:\n  ${keypair.publicKey.toBase58()}\nthen re-run this script.`);
      process.exit(2);
    }
  } else {
    console.error(`insufficient SOL. Fund ${keypair.publicKey.toBase58()} on mainnet (fees + rent only; free tier needs no TxL), then re-run.`);
    process.exit(2);
  }
}

// ---- on-chain subscribe (skipped when a txSig is already recorded) ----
if (!state.txSig) {
  const idl = JSON.parse(readFileSync(net.idlPath, 'utf8')) as anchor.Idl;
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(keypair), { commitment: 'confirmed' });
  const program = new anchor.Program(idl, provider);
  console.log(`program: ${program.programId.toBase58()}`);

  const userTokenAccount = getAssociatedTokenAddressSync(net.txlTokenMint, keypair.publicKey, false, TOKEN_2022_PROGRAM_ID);
  if ((await connection.getAccountInfo(userTokenAccount)) === null) {
    console.log('creating TxL Token-2022 associated token account…');
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        keypair.publicKey,
        userTokenAccount,
        keypair.publicKey,
        net.txlTokenMint,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
    await sendAndConfirmTransaction(connection, tx, [keypair], { commitment: 'confirmed' });
    await new Promise((r) => setTimeout(r, 3_000)); // let RPC index the account (official example does the same)
  }

  const [pricingMatrixPda] = PublicKey.findProgramAddressSync([Buffer.from('pricing_matrix')], program.programId);
  const [tokenTreasuryPda] = PublicKey.findProgramAddressSync([Buffer.from('token_treasury_v2')], program.programId);
  const tokenTreasuryVault = getAssociatedTokenAddressSync(net.txlTokenMint, tokenTreasuryPda, true, TOKEN_2022_PROGRAM_ID);

  console.log(`subscribing on-chain: service level ${serviceLevel}, ${DURATION_WEEKS} weeks (free tier: no TxL cost)…`);
  const subscribeMethod = program.methods['subscribe'];
  if (subscribeMethod === undefined) {
    throw new Error('IDL has no `subscribe` instruction — wrong IDL file?');
  }
  const txSig = await subscribeMethod(serviceLevel, DURATION_WEEKS)
    .accounts({
      user: keypair.publicKey,
      pricingMatrix: pricingMatrixPda,
      tokenMint: net.txlTokenMint,
      userTokenAccount,
      tokenTreasuryVault,
      tokenTreasuryPda,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log(`subscribe tx confirmed: ${txSig}`);
  state.txSig = txSig;
  saveState();
} else {
  console.log(`reusing recorded subscribe tx: ${state.txSig}`);
}

// ---- guest JWT + activation ----
console.log(`fetching guest JWT from ${net.apiOrigin}/auth/guest/start …`);
const authRes = await fetch(`${net.apiOrigin}/auth/guest/start`, { method: 'POST' });
if (!authRes.ok) {
  console.error(`guest auth failed: HTTP ${authRes.status}. If you are behind a filtered ISP profile (Güvenli İnternet), *.txodds.com is TLS-blocked — use another network/VPN.`);
  process.exit(2);
}
const jwt = ((await authRes.json()) as { token: string }).token;

const message = new TextEncoder().encode(`${state.txSig}:${SELECTED_LEAGUES.join(',')}:${jwt}`);
const walletSignature = Buffer.from(nacl.sign.detached(message, keypair.secretKey)).toString('base64');

const activateRes = await fetch(`${net.apiOrigin}/api/token/activate`, {
  method: 'POST',
  headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
  body: JSON.stringify({ txSig: state.txSig, walletSignature, leagues: SELECTED_LEAGUES }),
});
if (!activateRes.ok) {
  console.error(`activation failed: HTTP ${activateRes.status} — ${await activateRes.text()}`);
  console.error('common causes: network mismatch (devnet tx vs mainnet host), different signing wallet, wrong message string.');
  process.exit(2);
}
// The live endpoint answers text/plain with the bare token (observed 2026-07-19);
// parse text-first so a JSON body still works but plain text never throws away
// a SUCCESSFUL activation (the txSig is single-use — a lost token costs a new
// on-chain subscribe).
const rawBody = await activateRes.text();
let apiToken: string | undefined;
try {
  const parsed = JSON.parse(rawBody) as { token?: string } | string;
  apiToken = typeof parsed === 'string' ? parsed : parsed.token;
} catch {
  apiToken = rawBody.trim() || undefined;
}
if (!apiToken) {
  console.error('activation response had no token:', rawBody);
  process.exit(2);
}
state.apiToken = apiToken;
saveState();

console.log('\n✅ TxLINE API token activated. Add to apps/server/.env:');
console.log(`  TXLINE_ORIGIN=${net.apiOrigin}`);
console.log(`  TXLINE_API_TOKEN=${apiToken}`);
console.log(`\nThen: pnpm -F server cli:watch list   # discover fixture ids`);
