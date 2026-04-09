// scripts/rehearsal.ts
//
// Pre-canary dry-run rehearsal. Exercises the write-side tx builders against
// real mainnet pool data and real wallet balances, without submitting any tx.
//
// Bypasses the oracle (which requires ≥2 sources) by fetching a single-source
// mid price from DexScreener directly. NOT a substitute for the production
// oracle — rehearsal use only.
//
// Usage: BERT_MM_CONFIG=/tmp/bert-rehearsal-config.yaml tsx scripts/rehearsal.ts

import { Keypair } from '@solana/web3.js';
import { readFileSync } from 'node:fs';
import { loadConfigFromFile } from '../src/config.js';
import { RaydiumClientImpl } from '../src/raydiumClient.js';
import { logger } from '../src/logger.js';

async function main() {
  const cfgPath = process.env.BERT_MM_CONFIG;
  if (!cfgPath) throw new Error('BERT_MM_CONFIG not set');
  const cfg = loadConfigFromFile(cfgPath);
  logger.info({ pool: cfg.poolAddress }, 'rehearsal start');

  // Step 1: fetch a real mid price from DexScreener (single source — rehearsal only)
  const dsRes = await fetch(
    `https://api.dexscreener.com/latest/dex/pairs/solana/${cfg.poolAddress}`,
  );
  const ds = (await dsRes.json()) as {
    pairs: { priceUsd: string; priceNative: string }[];
  };
  const pair = ds.pairs[0];
  const bertUsd = parseFloat(pair.priceUsd);
  const bertPerSol = parseFloat(pair.priceNative); // BERT priced in SOL
  const solUsd = bertUsd / bertPerSol;
  logger.info({ bertUsd, solUsd, bertPerSol }, 'mid from DexScreener');

  // Step 2: load throwaway keypair, init Raydium client
  const keyJson = JSON.parse(readFileSync(cfg.keyfilePath, 'utf8')) as number[];
  const payer = Keypair.fromSecretKey(Uint8Array.from(keyJson));
  logger.info({ wallet: payer.publicKey.toBase58() }, 'loaded payer');

  const raydium = new RaydiumClientImpl(
    cfg.rpcPrimary,
    cfg.rpcFallback,
    cfg.poolAddress,
    cfg.bertMint,
    payer,
  );
  await raydium.init();

  // Step 3: getPoolState (proven in Stage A but worth re-running)
  const poolState = await raydium.getPoolState();
  logger.info(
    {
      address: poolState.address,
      feeTier: poolState.feeTier,
      currentTickIndex: poolState.currentTickIndex,
      sqrtPriceX64: poolState.sqrtPriceX64.toString(),
    },
    'STEP 3 ✓ getPoolState',
  );

  // Step 4: getWalletBalances (NEW: against funded wallet)
  const balances = await raydium.getWalletBalances();
  logger.info(
    {
      solLamports: balances.solLamports.toString(),
      solDecimal: Number(balances.solLamports) / 1e9,
      bertRaw: balances.bertRaw.toString(),
      bertDecimal: Number(balances.bertRaw) / 1e6,
    },
    'STEP 4 ✓ getWalletBalances',
  );

  // Step 5: buildOpenPositionTx (NEW: real pool data, real range math)
  const halfWidth = bertUsd * (cfg.rangeWidthPct / 100) / 2;
  const lowerUsd = bertUsd - halfWidth;
  const upperUsd = bertUsd + halfWidth;

  // Use ~half of available SOL (above floor) and matching BERT
  const usableSol =
    balances.solLamports > BigInt(cfg.minSolFloorLamports)
      ? balances.solLamports - BigInt(cfg.minSolFloorLamports)
      : 0n;
  const halfSol = usableSol / 2n;
  const halfBert = balances.bertRaw / 2n;

  logger.info(
    {
      lowerUsd,
      upperUsd,
      bertAmountRaw: halfBert.toString(),
      solAmountLamports: halfSol.toString(),
      solUsd,
    },
    'STEP 5: buildOpenPositionTx params',
  );

  try {
    const openResult = await raydium.buildOpenPositionTx({
      lowerUsd,
      upperUsd,
      bertAmountRaw: halfBert,
      solAmountLamports: halfSol,
      solUsd,
    });
    logger.info(
      {
        nftMint: openResult.nftMint,
        instructionCount: openResult.tx.instructions.length,
        signerCount: openResult.tx.signatures.length,
      },
      'STEP 5 ✓ buildOpenPositionTx',
    );
  } catch (e) {
    logger.error({ err: (e as Error).message, stack: (e as Error).stack }, 'STEP 5 ✗ buildOpenPositionTx FAILED');
  }

  // Step 6: buildSwapToRatioTx (NEW: real tickData remaining accounts resolution)
  try {
    const swapTx = await raydium.buildSwapToRatioTx({
      haveBertRaw: balances.bertRaw,
      haveSolLamports: usableSol,
      targetBertRatio: 0.5,
    });
    logger.info(
      {
        instructionCount: swapTx.instructions.length,
      },
      'STEP 6 ✓ buildSwapToRatioTx',
    );
  } catch (e) {
    logger.error({ err: (e as Error).message, stack: (e as Error).stack }, 'STEP 6 ✗ buildSwapToRatioTx FAILED');
  }

  logger.info('rehearsal complete');
}

main().catch((e) => {
  logger.fatal({ err: e }, 'rehearsal crashed');
  process.exit(1);
});
