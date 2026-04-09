import { logger } from './logger.js';
import type { RaydiumClient } from './raydiumClient.js';
import type { TxSubmitter } from './txSubmitter.js';
import type { StateStore } from './stateStore.js';
import type { Notifier } from './notifier.js';
import type { BotConfig, MidPrice, PositionSnapshot } from './types.js';

export interface RebalancerDeps {
  raydium: RaydiumClient;
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
      logger.warn({ err: e }, 'simulateClose failed — skipping drawdown check');
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
    let closeTx: Awaited<ReturnType<RaydiumClient['buildClosePositionTx']>>;
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
  // TODO(stage-d): fetch actual wallet ATA balances via RPC and verify they reflect the close.
  // For now we rely on the SDK building the open tx against on-chain ATAs — if balances are
  // wrong, submission of the open tx will fail on-chain.

  // ─── Step 5: Compute new range ───────────────────────────────────────────────
  const centerBertUsd = mid.bertUsd;
  const halfWidth = centerBertUsd * (cfg.rangeWidthPct / 100) / 2;
  const lowerUsd = centerBertUsd - halfWidth;
  const upperUsd = centerBertUsd + halfWidth;

  // ─── Step 6: Inventory cap + SOL floor ───────────────────────────────────────
  // 50/50 split up to maxPositionUsd
  const targetBertUsd = cfg.maxPositionUsd / 2;
  const targetSolUsd = cfg.maxPositionUsd / 2;

  // TODO(stage-d): fetch wallet SOL balance and enforce minSolFloorLamports.
  // Currently we pass through the targets; the open tx will fail on-chain if SOL is insufficient.

  const bertAmountRaw = BigInt(Math.floor((targetBertUsd / mid.bertUsd) * 1e6));
  const solAmountLamports = BigInt(Math.floor((targetSolUsd / mid.solUsd) * 1e9));

  // ─── Step 7: Swap to target ratio ────────────────────────────────────────────
  // TODO(stage-d): wire wallet balance fetch then call buildSwapToRatioTx.
  // After closing the position we receive BERT+SOL in the pool's current ratio, which
  // may differ from the 50/50 target. Stage D will fetch balances and call buildSwapToRatioTx
  // to rebalance the wallet before opening the new position.
  logger.info('Stage C: skipping swap-to-ratio step (wallet balance fetch not yet wired)');

  // ─── Step 8: Open new position ───────────────────────────────────────────────
  let openSig: string;
  let newNftMint: string;

  try {
    const { tx: openTx, nftMint } = await raydium.buildOpenPositionTx({
      lowerUsd,
      upperUsd,
      bertAmountRaw,
      solAmountLamports,
      solUsd: mid.solUsd,
    });

    openSig = await submitter.submit(openTx, {
      priorityFeeMicroLamports: cfg.priorityFeeMicroLamports,
      dryRun: cfg.dryRun,
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
  } else {
    logger.info(
      { newNftMint, lowerUsd, upperUsd },
      'DRY RUN: skipping state.setCurrentPosition and state.recordRebalance',
    );
  }

  const summary = `REBALANCE ${cfg.dryRun ? '(DRY RUN) ' : ''}OK — closed ${oldNftMint ?? 'none'} opened ${newNftMint}, range $${lowerUsd.toFixed(6)}-$${upperUsd.toFixed(6)}, value $${(targetBertUsd + targetSolUsd).toFixed(2)}. NOTE: swap-to-ratio step skipped (Stage D).`;
  await notifier.send('INFO', summary);

  const detail = `closed=${closeSig ?? 'none'} opened=${openSig} nft=${newNftMint}`;
  return { kind: 'OK', detail, newNftMint };
}
