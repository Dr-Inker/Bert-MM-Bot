import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';
import { loadConfigFromFile } from './config.js';
import { logger } from './logger.js';
import { StateStore } from './stateStore.js';
import { Notifier } from './notifier.js';
import { decide, StrategyParams } from './strategy.js';
import { computeTrustedMid, fetchAllSources, PriceFetchers } from './priceOracle.js';
import { RaydiumClientImpl } from './raydiumClient.js';
import { reconcile } from './reconciler.js';
import type { BotState, MidPrice } from './types.js';

const CONFIG_PATH = process.env.BERT_MM_CONFIG ?? '/etc/bert-mm-bot/config.yaml';
const MAX_HISTORY_SAMPLES = 120;

async function main(): Promise<void> {
  const cfg = loadConfigFromFile(CONFIG_PATH);
  logger.info({ dryRun: cfg.dryRun }, 'bert-mm-bot starting');

  const state = new StateStore(cfg.statePath);
  state.init();

  const notifier = new Notifier(cfg.notifier);

  const keyJson = JSON.parse(readFileSync(cfg.keyfilePath, 'utf8')) as number[];
  const payer = Keypair.fromSecretKey(Uint8Array.from(keyJson));

  const raydium = new RaydiumClientImpl(cfg.rpcPrimary, cfg.rpcFallback, cfg.poolAddress, payer);
  await raydium.init();

  const stored = state.getCurrentPosition();
  const onchain = stored ? await raydium.getPosition(stored.nftMint) : null;
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

  // Task 13 wires real fetchers.
  const fetchers: PriceFetchers = {
    fetchRaydium: async () => null,
    fetchJupiter: async () => null,
    fetchDexScreener: async () => null,
  };

  const priceHistory: MidPrice[] = [];
  await notifier.send('INFO', `bert-mm-bot started (dryRun=${cfg.dryRun})`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const tickStart = Date.now();
    try {
      const killSwitchTripped = existsSync(cfg.killSwitchFilePath) || !cfg.enabled;

      const samples = await fetchAllSources(fetchers);
      const solUsd = samples[0]?.solUsd ?? 150;
      const mid = computeTrustedMid(samples, solUsd, tickStart, cfg.oracleDivergenceBps);
      if (mid) {
        priceHistory.push(mid);
        if (priceHistory.length > MAX_HISTORY_SAMPLES) priceHistory.shift();
      }

      const storedPos = state.getCurrentPosition();
      const position = storedPos
        ? await raydium.getPosition(storedPos.nftMint).catch(() => null)
        : null;

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

      const decision = decide(botState, params);
      logger.info({ decision: decision.kind, reason: decision.reason }, 'tick decision');

      if (decision.kind === 'REBALANCE') {
        // Task 13 wires the full rebalance sequence.
        await notifier.send('INFO', `REBALANCE would fire: ${decision.reason}`);
      } else if (decision.kind === 'PAUSE') {
        await notifier.send('CRITICAL', `PAUSE: ${decision.reason}`);
      } else if (decision.kind === 'ALERT_ONLY') {
        await notifier.send('WARN', `ALERT_ONLY: ${decision.reason}`);
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
