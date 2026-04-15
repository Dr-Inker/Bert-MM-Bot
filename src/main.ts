import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';
import { loadConfigFromFile } from './config.js';
import { logger } from './logger.js';
import { StateStore } from './stateStore.js';
import { Notifier } from './notifier.js';
import { decide, StrategyParams } from './strategy.js';
import { computeTrustedMid, fetchAllSources } from './priceOracle.js';
import { RaydiumClientImpl } from './raydiumClient.js';
import { TxSubmitter } from './txSubmitter.js';
import { makeFetchers } from './priceFetchers.js';
import { reconcile } from './reconciler.js';
import { executeRebalance } from './rebalancer.js';
import type { BotState, MidPrice } from './types.js';

const CONFIG_PATH = process.env.BERT_MM_CONFIG ?? '/etc/bert-mm-bot/config.yaml';
const MAX_HISTORY_SAMPLES = 120;

async function main(): Promise<void> {
  const cfg = loadConfigFromFile(CONFIG_PATH);
  logger.info({ dryRun: cfg.dryRun }, 'bert-mm-bot starting');

  const state = new StateStore(cfg.statePath);
  state.init();

  const notifier = new Notifier(cfg.notifier ?? {});

  const keyJson = JSON.parse(readFileSync(cfg.keyfilePath, 'utf8')) as number[];
  const payer = Keypair.fromSecretKey(Uint8Array.from(keyJson));

  const raydium = new RaydiumClientImpl(
    cfg.rpcPrimary,
    cfg.rpcFallback,
    cfg.poolAddress,
    cfg.bertMint,
    payer,
  );
  await raydium.init();

  const submitter = new TxSubmitter(raydium.getConnection(), payer);
  const fetchers = makeFetchers(raydium, cfg.poolAddress);

  // Fetch oracle price before reconciliation so USD bounds can be computed
  const initSamples = await fetchAllSources(fetchers);
  const initSolUsd = initSamples.find((s) => s.solUsd > 0)?.solUsd ?? 150;

  const stored = state.getCurrentPosition();
  const onchain = stored ? await raydium.getPosition(stored.nftMint, initSolUsd) : null;
  const rec = reconcile(stored, onchain);
  if (rec.kind === 'MISMATCH') {
    await notifier.send(
      'CRITICAL',
      `Startup reconciliation FAILED: ${rec.reason}. Refusing to start.`,
    );
    logger.fatal({ rec }, 'reconciliation failed');
    process.exit(2);
  }
  logger.info({ rec: rec.kind }, 'reconciliation ok');

  const params: StrategyParams = {
    rangeWidthPct: cfg.rangeWidthPct,
    sustainedMinutes: cfg.sustainedMinutes,
    minRebalanceIntervalMin: cfg.minRebalanceIntervalMin,
    maxRebalancesPerDay: cfg.maxRebalancesPerDay,
    oracleStaleMinutes: cfg.oracleStaleMinutes,
    pollIntervalSec: cfg.pollIntervalSec,
  };

  const priceHistory: MidPrice[] = [];
  let lastHourlyReport = -1; // hour of last report (-1 = none sent yet)
  let ticksInRange = 0;
  let ticksTotal = 0;
  let rebalancesThisHour = 0;
  await notifier.send('INFO', `bert-mm-bot started (dryRun=${cfg.dryRun})`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const tickStart = Date.now();
    try {
      const killSwitchTripped = existsSync(cfg.killSwitchFilePath) || !cfg.enabled;

      const samples = await fetchAllSources(fetchers);
      const solUsd = samples.find((s) => s.solUsd > 0)?.solUsd ?? 150;
      const mid = computeTrustedMid(samples, solUsd, tickStart, cfg.oracleDivergenceBps);
      if (mid) {
        priceHistory.push(mid);
        if (priceHistory.length > MAX_HISTORY_SAMPLES) priceHistory.shift();
      }

      const storedPos = state.getCurrentPosition();
      let position = storedPos
        ? await raydium.getPosition(storedPos.nftMint, mid?.solUsd ?? 0).catch((e) => {
            logger.warn({ err: e, nftMint: storedPos.nftMint }, 'getPosition failed — treating as existing position to avoid duplicate open');
            return 'RPC_FAILED' as const;
          })
        : null;

      // C1 fix: if RPC failed but we have a stored position, do NOT open a new one.
      // Treat as degraded — skip this tick entirely.
      if (position === 'RPC_FAILED') {
        logger.warn('skipping tick: stored position exists but getPosition RPC failed');
        writeFileSync(cfg.heartbeatPath, String(tickStart));
        const elapsed = Date.now() - tickStart;
        await new Promise((r) => setTimeout(r, Math.max(0, cfg.pollIntervalSec * 1000 - elapsed)));
        continue;
      }

      const botState: BotState = {
        price: mid,
        priceHistory: [...priceHistory],
        position,
        lastRebalanceAt: state.lastRebalanceAt(),
        rebalancesToday: state.getRebalancesToday(tickStart),
        killSwitchTripped,
        degraded: state.isDegraded(),
        now: tickStart,
      };

      // ─── Initial position open: oracle healthy, no stored position ────────────
      // C2 fix: respect kill switch and degraded state before opening
      if (!storedPos && !position && mid && !killSwitchTripped && !state.isDegraded()) {
        logger.info('no position — opening initial position');
        const result = await executeRebalance(
          { raydium, submitter, state, notifier, config: cfg },
          mid,
          null,
          'initial position open',
        );
        logger.info({ result }, 'initial open complete');
        if (result.kind === 'OK') {
          await notifier.send('INFO', `Initial position opened: ${result.detail}`);
        }
        writeFileSync(cfg.heartbeatPath, String(tickStart));
        const initElapsed = Date.now() - tickStart;
        await new Promise((r) => setTimeout(r, Math.max(0, cfg.pollIntervalSec * 1000 - initElapsed)));
        continue;
      }

      // ─── Track in-range ticks for hourly report ─────────────────────────────
      ticksTotal++;
      if (position && mid) {
        const inRange = mid.bertUsd >= position.range.lowerBertUsd &&
                        mid.bertUsd <= position.range.upperBertUsd;
        if (inRange) ticksInRange++;
      }

      const decision = decide(botState, params);
      logger.info({ decision: decision.kind, reason: decision.reason }, 'tick decision');

      if (decision.kind === 'REBALANCE') {
        if (!mid) {
          // Shouldn't happen — strategy.decide guards this — but be safe
          logger.warn('REBALANCE decision with no mid price, skipping');
        } else {
          const result = await executeRebalance(
            { raydium, submitter, state, notifier, config: cfg },
            mid,
            position,
            decision.reason,
          );
          logger.info({ result }, 'rebalance complete');
        }
      } else if (decision.kind === 'PAUSE') {
        await notifier.send('CRITICAL', `PAUSE: ${decision.reason}`);
      } else if (decision.kind === 'ALERT_ONLY') {
        await notifier.send('WARN', `ALERT_ONLY: ${decision.reason}`);
      }

      // ─── Hourly status report ───────────────────────────────────────────────
      const currentHour = new Date(tickStart).getUTCHours();
      if (currentHour !== lastHourlyReport) {
        const inRangePct = ticksTotal > 0 ? ((ticksInRange / ticksTotal) * 100).toFixed(1) : 'N/A';
        const posInfo = position
          ? `$${position.range.lowerBertUsd.toFixed(6)}-$${position.range.upperBertUsd.toFixed(6)}`
          : 'none';
        const priceInfo = mid ? `$${mid.bertUsd.toFixed(6)}` : 'no oracle';
        const uptimeMin = Math.floor(ticksTotal * cfg.pollIntervalSec / 60);
        const lines = [
          `📊 Hourly Status (${new Date(tickStart).toISOString().slice(0, 16)}Z)`,
          `Price: ${priceInfo}`,
          `Range: ${posInfo}`,
          `In-range: ${inRangePct}% (${ticksInRange}/${ticksTotal} ticks, ~${uptimeMin}m)`,
          `Rebalances today: ${state.getRebalancesToday(tickStart)}/${cfg.maxRebalancesPerDay}`,
          `Status: ${killSwitchTripped ? '🔴 KILLED' : state.isDegraded() ? '🟡 DEGRADED' : '🟢 OK'}`,
        ];
        await notifier.send('INFO', lines.join('\n'));
        lastHourlyReport = currentHour;
        ticksInRange = 0;
        ticksTotal = 0;
        rebalancesThisHour = 0;
      }

      writeFileSync(cfg.heartbeatPath, String(tickStart));
    } catch (e) {
      logger.error({ err: e }, 'tick failed');
      await notifier.send('WARN', `Tick failed: ${(e as Error).message}`);
    }

    const elapsed = Date.now() - tickStart;
    const sleep = Math.max(0, cfg.pollIntervalSec * 1000 - elapsed);
    await new Promise((r) => setTimeout(r, sleep));
  }
}

main().catch((e) => {
  logger.fatal({ err: e }, 'main crashed');
  process.exit(1);
});
