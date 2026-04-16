// scripts/create-meteora-pool.ts
//
// One-time script to create a Meteora DLMM pool for BERT/SOL.
//
// Usage:
//   npx tsx scripts/create-meteora-pool.ts
//   npx tsx scripts/create-meteora-pool.ts --dry-run
//
// Requires:
//   - Hot wallet keyfile at /etc/bert-mm-bot/hot-wallet.json
//   - RPC URL in /etc/bert-mm-bot/config.yaml (field: rpcPrimary)

import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parse } from 'yaml';
import BN from 'bn.js';

// ---------------------------------------------------------------------------
// DLMM import workaround
//
// tsx v4 resolves the "source" field in @meteora-ag/dlmm's package.json and
// tries to compile the raw TypeScript, which fails because @coral-xyz/anchor
// does not expose named ESM exports for BN.  Loading via createRequire forces
// CJS resolution (dist/index.js) and sidesteps the issue entirely.
//
// In CJS mode the DLMM class's static methods (createLbPair, etc.) are
// exported as top-level functions rather than on a class object.
// ---------------------------------------------------------------------------
const require = createRequire(import.meta.url);
const DLMM = require('@meteora-ag/dlmm') as {
  getPairPubkeyIfExists(
    connection: Connection, tokenX: PublicKey, tokenY: PublicKey,
    binStep: BN, baseFactor: BN, baseFeePowerFactor?: BN,
    opt?: { cluster?: string },
  ): Promise<PublicKey | null>;
  getAllPresetParameters(
    connection: Connection, opt?: { cluster?: string },
  ): Promise<Array<{ publicKey: PublicKey; account: { binStep: number; baseFactor: number } }>>;
  createLbPair(
    connection: Connection, funder: PublicKey, tokenX: PublicKey, tokenY: PublicKey,
    binStep: BN, baseFactor: BN, presetParameter: PublicKey, activeId: BN,
    opt?: { cluster?: string },
  ): Promise<import('@solana/web3.js').Transaction>;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BERT_MINT = new PublicKey('HgBRWfYxEfvPhtqkaeymCQtHCrKE46qQ43pKe8HCpump');
const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

const BIN_STEP = 20;
const BASE_FACTOR = 5000;

const CONFIG_PATH = '/etc/bert-mm-bot/config.yaml';
const WALLET_PATH = '/etc/bert-mm-bot/hot-wallet.json';

// BERT/SOL approximate market price (SOL per BERT).
// Used as fallback if live price fetch fails.
const FALLBACK_PRICE = 0.000125;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadRpcUrl(): string {
  const raw = readFileSync(CONFIG_PATH, 'utf8');
  const cfg = parse(raw) as Record<string, unknown>;
  const rpc = cfg['rpcPrimary'];
  if (typeof rpc !== 'string' || !rpc) {
    throw new Error(`rpcPrimary not found or empty in ${CONFIG_PATH}`);
  }
  return rpc;
}

function loadWallet(): Keypair {
  const raw = readFileSync(WALLET_PATH, 'utf8');
  const secret = JSON.parse(raw) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

/**
 * Compute the DLMM bin ID for a given price.
 *
 *   activeId = floor( log(price) / log(1 + binStep / 10_000) )
 *
 * Price here is token_Y per token_X (SOL per BERT), adjusted for decimals.
 * DLMM convention: price = (amountY / 10^decY) / (amountX / 10^decX)
 * which simplifies to the human-readable price when X=BERT(6) and Y=SOL(9).
 */
function priceToActiveBinId(price: number, binStep: number): number {
  const step = 1 + binStep / 10_000;
  const id = Math.floor(Math.log(price) / Math.log(step));
  return id;
}

/**
 * Fetch BERT/SOL price from DexScreener.
 * Falls back to Jupiter price API if DexScreener fails.
 * Returns SOL per BERT.
 */
async function fetchBertSolPrice(): Promise<number> {
  // Try DexScreener first (search by token address)
  try {
    console.log('  Fetching price from DexScreener...');
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${BERT_MINT.toBase58()}`,
    );
    if (res.ok) {
      const data = (await res.json()) as {
        pairs?: { priceNative?: string; dexId?: string }[];
      };
      if (data.pairs && data.pairs.length > 0) {
        // Find a Solana pair with priceNative (SOL-denominated)
        for (const pair of data.pairs) {
          if (pair.priceNative) {
            const price = parseFloat(pair.priceNative);
            if (price > 0) {
              console.log(`  DexScreener price: ${price} SOL/BERT`);
              return price;
            }
          }
        }
      }
    }
  } catch {
    console.log('  DexScreener fetch failed, trying Jupiter...');
  }

  // Fallback: Jupiter price API v2
  try {
    console.log('  Fetching price from Jupiter...');
    const res = await fetch(
      `https://api.jup.ag/price/v2?ids=${BERT_MINT.toBase58()}&vsToken=${SOL_MINT.toBase58()}`,
    );
    if (res.ok) {
      const data = (await res.json()) as {
        data?: Record<string, { price?: string }>;
      };
      const entry = data.data?.[BERT_MINT.toBase58()];
      if (entry?.price) {
        const price = parseFloat(entry.price);
        if (price > 0) {
          console.log(`  Jupiter price: ${price} SOL/BERT`);
          return price;
        }
      }
    }
  } catch {
    console.log('  Jupiter fetch failed.');
  }

  console.log(`  Using fallback price: ${FALLBACK_PRICE} SOL/BERT`);
  return FALLBACK_PRICE;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  console.log('=== Meteora DLMM Pool Creator: BERT/SOL ===');
  console.log(`Mode: ${dryRun ? 'DRY RUN (no transactions will be sent)' : 'LIVE'}`);
  console.log();

  // Step 1: Load config and wallet
  console.log('[1/6] Loading config and wallet...');
  const rpcUrl = loadRpcUrl();
  console.log(`  RPC: ${rpcUrl.slice(0, 40)}...`);

  const wallet = loadWallet();
  console.log(`  Wallet: ${wallet.publicKey.toBase58()}`);

  const connection = new Connection(rpcUrl, 'confirmed');
  console.log();

  // Step 2: Check wallet SOL balance
  console.log('[2/6] Checking wallet balance...');
  const balanceLamports = await connection.getBalance(wallet.publicKey);
  const balanceSol = balanceLamports / 1e9;
  console.log(`  SOL balance: ${balanceSol.toFixed(4)} SOL`);
  if (balanceSol < 0.05) {
    throw new Error('Insufficient SOL balance. Need at least 0.05 SOL for rent + tx fees.');
  }
  console.log();

  // Step 3: Check if pool already exists
  console.log('[3/6] Checking if BERT/SOL DLMM pool already exists...');
  console.log(`  Token X (BERT): ${BERT_MINT.toBase58()}`);
  console.log(`  Token Y (SOL):  ${SOL_MINT.toBase58()}`);
  console.log(`  Bin step: ${BIN_STEP}, Base factor: ${BASE_FACTOR}`);

  // DLMM SDK may order tokens internally; try both orderings
  let existingPool: PublicKey | null = null;
  try {
    existingPool = await DLMM.getPairPubkeyIfExists(
      connection,
      BERT_MINT,
      SOL_MINT,
      new BN(BIN_STEP),
      new BN(BASE_FACTOR),
    );
  } catch {
    // Might throw if no pool found; that's fine
  }

  if (!existingPool) {
    try {
      existingPool = await DLMM.getPairPubkeyIfExists(
        connection,
        SOL_MINT,
        BERT_MINT,
        new BN(BIN_STEP),
        new BN(BASE_FACTOR),
      );
    } catch {
      // No pool found in reverse order either
    }
  }

  if (existingPool) {
    console.log(`  Pool already exists: ${existingPool.toBase58()}`);
    console.log('  Nothing to do. Exiting.');
    return;
  }
  console.log('  No existing pool found. Proceeding with creation.');
  console.log();

  // Step 4: Find matching preset parameter
  console.log('[4/6] Finding preset parameter for bin_step=%d, base_factor=%d...', BIN_STEP, BASE_FACTOR);
  const allPresets = await DLMM.getAllPresetParameters(connection);
  console.log(`  Found ${allPresets.length} preset(s) on-chain.`);

  const matchingPreset = allPresets.find((p: { account: { binStep: number; baseFactor: number }; publicKey: PublicKey }) => {
    const account = p.account;
    return (
      account.binStep === BIN_STEP &&
      account.baseFactor === BASE_FACTOR
    );
  });

  if (!matchingPreset) {
    console.error('\n  ERROR: No preset matches bin_step=%d, base_factor=%d.', BIN_STEP, BASE_FACTOR);
    console.error('  Available presets:');
    for (const p of allPresets) {
      const a = (p as { account: { binStep: number; baseFactor: number }; publicKey: PublicKey });
      console.error(
        '    bin_step=%d  base_factor=%d  pubkey=%s',
        a.account.binStep,
        a.account.baseFactor,
        a.publicKey.toBase58(),
      );
    }
    throw new Error('No matching preset parameter found. Choose a valid (binStep, baseFactor) combo from the list above.');
  }

  console.log(`  Preset found: ${matchingPreset.publicKey.toBase58()}`);
  console.log(`    bin_step=${matchingPreset.account.binStep}, base_factor=${matchingPreset.account.baseFactor}`);
  console.log();

  // Step 5: Compute active bin ID from current market price
  console.log('[5/6] Computing active bin ID from market price...');
  const priceSolPerBert = await fetchBertSolPrice();

  const activeId = priceToActiveBinId(priceSolPerBert, BIN_STEP);
  console.log(`  Price: ${priceSolPerBert} SOL/BERT`);
  console.log(`  Active bin ID: ${activeId}`);

  // Sanity check: reconstruct price from bin ID
  const reconstructedPrice = Math.pow(1 + BIN_STEP / 10_000, activeId);
  console.log(`  Reconstructed price from bin: ${reconstructedPrice.toExponential(4)} SOL/BERT`);
  console.log();

  // Step 6: Create the pool
  console.log('[6/6] Creating DLMM pool...');
  console.log('  Parameters:');
  console.log(`    Token X (BERT): ${BERT_MINT.toBase58()}`);
  console.log(`    Token Y (SOL):  ${SOL_MINT.toBase58()}`);
  console.log(`    Bin step:       ${BIN_STEP}`);
  console.log(`    Base factor:    ${BASE_FACTOR}`);
  console.log(`    Base fee:       ${(BIN_STEP * BASE_FACTOR) / 1_000_000 * 100}%`);
  console.log(`    Active bin ID:  ${activeId}`);
  console.log(`    Preset:         ${matchingPreset.publicKey.toBase58()}`);
  console.log(`    Funder:         ${wallet.publicKey.toBase58()}`);

  if (dryRun) {
    console.log();
    console.log('  DRY RUN: Skipping transaction submission.');
    console.log('  Run without --dry-run to create the pool.');
    return;
  }

  const createTx = await DLMM.createLbPair(
    connection,
    wallet.publicKey,
    BERT_MINT,
    SOL_MINT,
    new BN(BIN_STEP),
    new BN(BASE_FACTOR),
    matchingPreset.publicKey,
    new BN(activeId),
  );

  console.log('  Sending transaction...');
  const sig = await sendAndConfirmTransaction(connection, createTx, [wallet], {
    commitment: 'confirmed',
    maxRetries: 3,
  });
  console.log(`  Transaction confirmed: ${sig}`);
  console.log();

  // Fetch the pool address post-creation
  let poolAddress: PublicKey | null = null;
  try {
    poolAddress = await DLMM.getPairPubkeyIfExists(
      connection,
      BERT_MINT,
      SOL_MINT,
      new BN(BIN_STEP),
      new BN(BASE_FACTOR),
    );
  } catch {
    // Try reverse order
    try {
      poolAddress = await DLMM.getPairPubkeyIfExists(
        connection,
        SOL_MINT,
        BERT_MINT,
        new BN(BIN_STEP),
        new BN(BASE_FACTOR),
      );
    } catch {
      // Could not fetch -- user can find it from the tx
    }
  }

  console.log('=== Pool Created ===');
  if (poolAddress) {
    console.log(`Pool address: ${poolAddress.toBase58()}`);
  } else {
    console.log('Pool address could not be fetched automatically.');
    console.log(`Check transaction ${sig} on Solscan for the pool address.`);
  }
  console.log(`Transaction: https://solscan.io/tx/${sig}`);
}

main().catch((err: unknown) => {
  console.error('\nFATAL:', err instanceof Error ? err.message : err);
  process.exit(1);
});
