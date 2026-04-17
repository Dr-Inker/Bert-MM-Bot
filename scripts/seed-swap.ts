// scripts/seed-swap.ts
//
// One-time script: execute a tiny swap through our Meteora DLMM pool
// to generate on-chain activity and trigger Jupiter/DexScreener indexing.
//
// Usage:
//   npx tsx scripts/seed-swap.ts            # Execute swap
//   npx tsx scripts/seed-swap.ts --dry-run  # Simulate only

import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parse } from 'yaml';
import BN from 'bn.js';

const require2 = createRequire(import.meta.url);
const dlmmModule = require2('@meteora-ag/dlmm') as {
  default?: any;
  DLMM?: any;
};
const DLMM = dlmmModule.default ?? dlmmModule.DLMM ?? dlmmModule;

// Amount: 100 BERT (~$1) — small enough to be negligible, large enough to register
const SWAP_AMOUNT_BERT_RAW = 100_000_000; // 100 BERT (6 decimals)
const SLIPPAGE_BPS = 500; // 5% — generous for tiny amount on our own pool

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  // Load config
  const cfgRaw = readFileSync('/etc/bert-mm-bot/config.yaml', 'utf8');
  const cfg = parse(cfgRaw) as {
    rpcPrimary: string;
    poolAddress: string;
    bertMint: string;
  };

  // Load wallet
  const walletJson = readFileSync('/etc/bert-mm-bot/hot-wallet.json', 'utf8');
  const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(walletJson)));
  console.log(`Wallet: ${wallet.publicKey.toBase58()}`);

  // Connect
  const connection = new Connection(cfg.rpcPrimary, 'confirmed');
  const poolPubkey = new PublicKey(cfg.poolAddress);
  console.log(`Pool: ${cfg.poolAddress}`);

  // Initialize DLMM pool
  console.log('Initializing DLMM pool...');
  const dlmmPool = await DLMM.create(connection, poolPubkey);
  await dlmmPool.refetchStates();

  const tokenXMint = dlmmPool.tokenX.publicKey.toBase58();
  const bertIsX = tokenXMint === cfg.bertMint;
  console.log(`BERT is token${bertIsX ? 'X' : 'Y'}`);

  // Get active bin price
  const activeBin = await dlmmPool.getActiveBin();
  console.log(`Active bin: ${activeBin.binId}, price: ${activeBin.price}`);

  // Swap BERT -> SOL (sell a tiny amount of BERT)
  const inAmount = new BN(SWAP_AMOUNT_BERT_RAW);
  const swapForY = bertIsX; // if BERT=X, selling X for Y = true
  const inToken = bertIsX ? dlmmPool.tokenX.publicKey : dlmmPool.tokenY.publicKey;
  const outToken = bertIsX ? dlmmPool.tokenY.publicKey : dlmmPool.tokenX.publicKey;

  console.log(`\nSwap: 100 BERT -> SOL (swapForY=${swapForY})`);

  // Get quote
  const binArrays = await dlmmPool.getBinArrayForSwap(swapForY);
  const slippageBN = new BN(SLIPPAGE_BPS);
  const quote = await dlmmPool.swapQuote(inAmount, swapForY, slippageBN, binArrays);

  const minOut = BigInt(quote.minOutAmount.toString());
  const expectedOut = BigInt(quote.consumedInAmount ? quote.outAmount.toString() : '0');
  console.log(`Quote: in=${SWAP_AMOUNT_BERT_RAW} BERT, minOut=${minOut} lamports (~${Number(minOut) / 1e9} SOL)`);

  if (dryRun) {
    console.log('\n--dry-run: would execute swap. Exiting.');
    return;
  }

  // Build and send
  const tx = await dlmmPool.swap({
    inToken,
    outToken,
    inAmount,
    minOutAmount: quote.minOutAmount,
    lbPair: dlmmPool.pubkey,
    user: wallet.publicKey,
    binArraysPubkey: quote.binArraysPubkey,
  });

  console.log('\nSending swap transaction...');
  const sig = await sendAndConfirmTransaction(connection, tx, [wallet], {
    commitment: 'confirmed',
    maxRetries: 3,
  });

  console.log(`\nSwap confirmed!`);
  console.log(`Signature: ${sig}`);
  console.log(`Explorer: https://solscan.io/tx/${sig}`);
  console.log('\nPool should now be discoverable by Jupiter and DexScreener.');
}

main().catch((err) => {
  console.error('Seed swap failed:', err.message || err);
  process.exit(1);
});
