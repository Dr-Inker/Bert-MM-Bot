import { logger } from './logger.js';
import type { VenueClient } from './venueClient.js';
import type { TxSubmitter } from './txSubmitter.js';
import type { StateStore } from './stateStore.js';
import type { Notifier } from './notifier.js';
import type { BotConfig, MidPrice, PositionSnapshot } from './types.js';

export interface RebalancerDeps {
  raydium: VenueClient;
  submitter: TxSubmitter;
  state: StateStore;
  notifier: Notifier;
  config: BotConfig;
}

export interface RebalanceResult {
  kind: 'OK' | 'SKIPPED' | 'FAILED';
  detail: string;
  newNftMint?: string;
}

export async function executeRebalance(
  deps: RebalancerDeps,
  mid: MidPrice,
  currentPosition: PositionSnapshot | null,
  reason: string,
): Promise<RebalanceResult> {
  const { raydium, submitter, state, notifier, config: cfg } = deps;
  const now = Date.now();

  // ─── Step 1: Pre-flight drawdown breaker ────────────────────────────────────
  if (currentPosition) {
    try {
      const { effectivePriceUsd, bertOut, solOut } = await raydium.simulateClose(
        currentPosition.nftMint,
        mid.solUsd,
      );
      const effectiveValueUsd =
        (Number(bertOut) / 1e6) * effectivePriceUsd + (Number(solOut) / 1e9) * mid.solUsd;

      const entryValueUsd = currentPosition.totalValueUsd;
      if (entryValueUsd > 0) {
        const drawdownRatio = effectiveValueUsd / entryValueUsd;
        const threshold = 1 - cfg.maxDrawdownPct / 100;
        if (drawdownRatio < threshold) {
          const detail = `drawdown breaker tripped: effective=${effectiveValueUsd.toFixed(2)} entry=${entryValueUsd.toFixed(2)} ratio=${(drawdownRatio * 100).toFixed(1)}% < ${(threshold * 100).toFixed(1)}%`;
          logger.warn({ detail }, 'rebalance skipped');
          state.setDegraded(true, 'drawdown breaker tripped');
          await notifier.send('CRITICAL', `DRAWDOWN BREAKER: ${detail}`);
          return { kind: 'SKIPPED', detail };
        }
      } else {
        logger.warn(
          { nftMint: currentPosition.nftMint },
          'drawdown check: entryValueUsd=0, skipping check',
        );
      }
    } catch (e) {
      // C3 fix: fail CLOSED — if we can't verify drawdown is safe, don't rebalance
      const detail = `simulateClose failed — refusing to rebalance without drawdown check: ${String(e)}`;
      logger.error({ err: e }, detail);
      await notifier.send('CRITICAL', `DRAWDOWN CHECK FAILED: ${detail}`);
      return { kind: 'SKIPPED', detail };
    }
  }

  // ─── Step 2: Daily cap check ─────────────────────────────────────────────────
  if (state.getRebalancesToday(now) >= cfg.maxRebalancesPerDay) {
    const detail = 'daily cap reached';
    logger.info({ detail }, 'rebalance skipped');
    return { kind: 'SKIPPED', detail };
  }

  // ─── Step 3: Close current position (if any) ────────────────────────────────
  let closeSig: string | undefined;
  const oldNftMint = currentPosition?.nftMint;

  if (currentPosition) {
    let closeTx: Awaited<ReturnType<VenueClient['buildClosePositionTx']>>;
    try {
      closeTx = await raydium.buildClosePositionTx(currentPosition.nftMint);
    } catch (e) {
      const detail = `buildClosePositionTx failed: ${String(e)}`;
      logger.error({ err: e }, detail);
      await notifier.send('CRITICAL', `Rebalance FAILED (close tx build): ${detail}`);
      return { kind: 'FAILED', detail };
    }

    try {
      closeSig = await submitter.submit(closeTx.tx, {
        priorityFeeMicroLamports: cfg.priorityFeeMicroLamports,
        dryRun: cfg.dryRun,
      });
    } catch (e) {
      const detail = `close submit failed: ${String(e)}`;
      logger.error({ err: e }, detail);
      await notifier.send('CRITICAL', `Rebalance FAILED (close submit): ${detail}`);
      return { kind: 'FAILED', detail };
    }

    logger.info(
      {
        closeSig,
        expectedBertOut: closeTx.expectedBertOut.toString(),
        expectedSolOut: closeTx.expectedSolOut.toString(),
      },
      'position closed',
    );
    await notifier.send(
      'INFO',
      `Position closed — sig=${closeSig} expectedBert=${closeTx.expectedBertOut} expectedSol=${closeTx.expectedSolOut}`,
    );
  }

  // ─── Step 4: Verify post-close balances ──────────────────────────────────────
  // Force a pool state re-fetch/re-cache.
  try {
    await raydium.getPoolState();
  } catch (e) {
    logger.warn({ err: e }, 'getPoolState after close failed — proceeding anyway');
  }

  // ─── Step 5: Compute new range ───────────────────────────────────────────────
  const centerBertUsd = mid.bertUsd;
  const halfWidth = centerBertUsd * (cfg.rangeWidthPct / 100) / 2;
  const lowerUsd = centerBertUsd - halfWidth;
  const upperUsd = centerBertUsd + halfWidth;

  // ─── Step 6 + 7: Fetch wallet balances, enforce SOL floor, swap to 50/50 ─────
  let targetBertUsd: number;
  let targetSolUsd: number;
  let bertAmountRaw: bigint;
  let solAmountLamports: bigint;

  try {
    // After close confirmed, fetch real balances
    const balances = await raydium.getWalletBalances();
    logger.info(
      { balances: { sol: balances.solLamports.toString(), bert: balances.bertRaw.toString() } },
      'post-close balances',
    );

    // Reserve SOL floor for fees + future txs
    const usableSol =
      balances.solLamports > BigInt(cfg.minSolFloorLamports)
        ? balances.solLamports - BigInt(cfg.minSolFloorLamports)
        : 0n;

    // Compute total USD value of usable inventory
    const usableSolUsd = (Number(usableSol) / 1e9) * mid.solUsd;
    const usableBertUsd = (Number(balances.bertRaw) / 1e6) * mid.bertUsd;
    const totalUsableUsd = usableSolUsd + usableBertUsd;

    // Cap at maxPositionUsd
    const targetTotalUsd = Math.min(totalUsableUsd, cfg.maxPositionUsd);

    // 50/50 target ratio
    targetBertUsd = targetTotalUsd / 2;
    targetSolUsd = targetTotalUsd / 2;
    const targetBertRatio = 0.5;

    // Swap if current ratio differs from target by more than 1%
    const currentBertRatio =
      totalUsableUsd > 0 ? usableBertUsd / totalUsableUsd : 0.5;
    if (Math.abs(currentBertRatio - targetBertRatio) > 0.01) {
      try {
        const swapTx = await raydium.buildSwapToRatioTx({
          haveBertRaw: balances.bertRaw,
          haveSolLamports: usableSol,
          targetBertRatio,
        });
        // buildSwapToRatioTx may return an empty Transaction if no swap needed
        if (swapTx.instructions.length > 0) {
          // Swap-to-ratio is the prime sandwich target — route through Jito
          // when configured. Falls back to public RPC if Jito doesn't land.
          const swapSig = await submitter.submitProtected(swapTx, {
            priorityFeeMicroLamports: cfg.priorityFeeMicroLamports,
            dryRun: cfg.dryRun,
          });
          logger.info({ swapSig, mevProtected: true }, 'swap to ratio submitted');
          // Re-fetch balances after swap
          if (!cfg.dryRun) {
            const postSwapBalances = await raydium.getWalletBalances();
            logger.info(
              {
                postSwap: {
                  sol: postSwapBalances.solLamports.toString(),
                  bert: postSwapBalances.bertRaw.toString(),
                },
              },
              'post-swap balances',
            );
          }
        }
      } catch (swapErr) {
        // Swap fails when we are the sole LP — after closing our position, there is
        // no remaining liquidity to swap against. Proceed with available balances;
        // DLMM supports deposits at any ratio.
        logger.warn({ err: swapErr }, 'swap-to-ratio failed — depositing available balances');
      }
    }

    // Re-fetch balances in case swap changed them, then use actual holdings
    // (handles both post-swap and failed-swap-on-empty-pool cases)
    if (!cfg.dryRun) {
      const finalBal = await raydium.getWalletBalances();
      const finalUsableSol = finalBal.solLamports > BigInt(cfg.minSolFloorLamports)
        ? finalBal.solLamports - BigInt(cfg.minSolFloorLamports)
        : 0n;
      const finalBertUsd = (Number(finalBal.bertRaw) / 1e6) * mid.bertUsd;
      const finalSolUsd = (Number(finalUsableSol) / 1e9) * mid.solUsd;
      const finalTotalUsd = finalBertUsd + finalSolUsd;
      const capUsd = Math.min(finalTotalUsd, cfg.maxPositionUsd);
      const scale = finalTotalUsd > 0 ? capUsd / finalTotalUsd : 0;
      bertAmountRaw = BigInt(Math.floor(Number(finalBal.bertRaw) * scale));
      solAmountLamports = BigInt(Math.floor(Number(finalUsableSol) * scale));
    } else {
      bertAmountRaw = BigInt(Math.floor((targetBertUsd / mid.bertUsd) * 1e6));
      solAmountLamports = BigInt(Math.floor((targetSolUsd / mid.solUsd) * 1e9));
    }
  } catch (e) {
    // Swap failure after close: we have unbalanced inventory in the wallet — treat as FAILED
    const detail = `swap-to-ratio failed after close: ${String(e)}`;
    logger.error({ err: e, closeSig }, detail);
    state.setDegraded(true, detail);
    await notifier.send(
      'CRITICAL',
      `Rebalance FAILED (swap-to-ratio) — close sig=${closeSig ?? 'N/A'}, swap error: ${String(e)}. Bot is DEGRADED.`,
    );
    return { kind: 'FAILED', detail };
  }

  // ─── Step 8: Open new position ───────────────────────────────────────────────
  let openSig: string;
  let newNftMint: string;

  try {
    const { tx: openTx, nftMint, signers: openSigners } = await raydium.buildOpenPositionTx({
      lowerUsd,
      upperUsd,
      bertAmountRaw,
      solAmountLamports,
      solUsd: mid.solUsd,
    });

    openSig = await submitter.submit(openTx, {
      priorityFeeMicroLamports: cfg.priorityFeeMicroLamports,
      dryRun: cfg.dryRun,
      extraSigners: openSigners,
    });
    newNftMint = nftMint;
  } catch (e) {
    const detail = `close ok, open failed: ${String(e)}`;
    logger.error({ err: e, closeSig }, detail);
    state.setDegraded(true, detail);
    await notifier.send(
      'CRITICAL',
      `Rebalance PARTIALLY FAILED — close sig=${closeSig ?? 'N/A'}, open error: ${String(e)}. Bot is DEGRADED.`,
    );
    return { kind: 'FAILED', detail };
  }

  logger.info({ openSig, newNftMint, lowerUsd, upperUsd }, 'new position opened');

  // ─── Step 9: Persist + notify ────────────────────────────────────────────────
  if (!cfg.dryRun) {
    try {
      state.setCurrentPosition({
        nftMint: newNftMint,
        lowerUsd,
        upperUsd,
        centerUsd: centerBertUsd,
        openedAt: now,
      });

      state.recordRebalance({
        ts: now,
        oldCenterUsd: currentPosition?.range?.centerBertUsd ?? 0,
        newCenterUsd: centerBertUsd,
        feesCollectedUsd: 0, // fees swept separately
      });
    } catch (e) {
      // State write failed — close the just-opened position to avoid orphaning it
      logger.error({ err: e, newNftMint }, 'state persistence failed after open — closing position to prevent orphan');
      try {
        const rollbackTx = await raydium.buildClosePositionTx(newNftMint);
        await submitter.submit(rollbackTx.tx, {
          priorityFeeMicroLamports: cfg.priorityFeeMicroLamports,
          dryRun: false,
        });
        logger.info({ newNftMint }, 'orphan-prevention: position closed after state write failure');
      } catch (rollbackErr) {
        logger.fatal({ err: rollbackErr, newNftMint }, 'CRITICAL: state write AND rollback close both failed — ORPHANED POSITION');
        await notifier.send('CRITICAL', `ORPHANED POSITION ${newNftMint}: state write failed AND rollback close failed. Manual recovery required via: node dist/cli/index.js close-orphan --nft ${newNftMint}`);
      }
      const detail = `state persistence failed after open: ${String(e)}`;
      state.setDegraded(true, detail);
      await notifier.send('CRITICAL', `Rebalance FAILED (state write): ${detail}. Position rolled back.`);
      return { kind: 'FAILED', detail };
    }
  } else {
    logger.info(
      { newNftMint, lowerUsd, upperUsd },
      'DRY RUN: skipping state.setCurrentPosition and state.recordRebalance',
    );
  }

  const summary = `REBALANCE ${cfg.dryRun ? '(DRY RUN) ' : ''}OK — closed ${oldNftMint ?? 'none'} opened ${newNftMint}, range $${lowerUsd.toFixed(6)}-$${upperUsd.toFixed(6)}, value $${(targetBertUsd + targetSolUsd).toFixed(2)}.`;
  await notifier.send('INFO', summary);

  const detail = `closed=${closeSig ?? 'none'} opened=${openSig} nft=${newNftMint}`;
  return { kind: 'OK', detail, newNftMint };
}
