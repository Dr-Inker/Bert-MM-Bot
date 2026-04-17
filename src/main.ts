import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { loadConfigFromFile } from './config.js';
import { logger } from './logger.js';
import { StateStore } from './stateStore.js';
import { Notifier } from './notifier.js';
import { TelegramCommander } from './telegramCommander.js';
import { DepositorStore } from './vault/depositorStore.js';
import { decide, StrategyParams } from './strategy.js';
import { computeTrustedMid, fetchAllSources } from './priceOracle.js';
import { createVenueClient } from './venueClient.js';
import { TxSubmitter } from './txSubmitter.js';
import { JitoClient } from './jitoClient.js';
import { makeFetchers } from './priceFetchers.js';
import { reconcile } from './reconciler.js';
import { executeRebalance } from './rebalancer.js';
import { computeNav } from './vault/navSnapshot.js';
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

  const raydium = await createVenueClient(
    cfg.venue,
    cfg.rpcPrimary,
    cfg.rpcFallback,
    cfg.poolAddress,
    cfg.bertMint,
    payer,
  );
  await raydium.init();

  const jito = cfg.mevProtection?.enabled
    ? new JitoClient(raydium.getConnection(), payer, {
        blockEngineUrl: cfg.mevProtection.blockEngineUrl,
        tipLamports: cfg.mevProtection.tipLamports,
        bundleTimeoutMs: cfg.mevProtection.bundleTimeoutMs,
      })
    : undefined;
  if (jito) {
    logger.info(
      {
        endpoint: cfg.mevProtection!.blockEngineUrl,
        tipLamports: cfg.mevProtection!.tipLamports,
      },
      'mev protection enabled — swap-to-ratio will route through jito',
    );
  }
  const submitter = new TxSubmitter(raydium.getConnection(), payer, jito);
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
  // Start Telegram command listener (if configured)
  if (cfg.notifier?.telegram) {
    const depositorStore = new DepositorStore(state);
    const operatorChatId = Number(cfg.notifier.telegram.chatIdInfo);
    if (!Number.isFinite(operatorChatId)) {
      logger.warn({ chatIdInfo: cfg.notifier.telegram.chatIdInfo }, 'telegram operator chat id is not numeric; telegram commander disabled');
    } else {
      const tgCmd = new TelegramCommander({
        botToken: cfg.notifier.telegram.botToken,
        operatorChatId,
        depositorStore,
      });

      const setEnabled = (enabled: boolean): void => {
        try {
          const raw = readFileSync(CONFIG_PATH, 'utf8');
          const doc = parseYaml(raw) as Record<string, unknown>;
          doc['enabled'] = enabled;
          writeFileSync(CONFIG_PATH, stringifyYaml(doc));
          const action = enabled ? 'resume' : 'pause';
          state.recordOperatorAction({ ts: Date.now(), command: `telegram:${action}`, osUser: 'telegram' });
        } catch (e) {
          logger.error({ err: e }, 'telegram commander: failed to update config');
        }
      };

      const isEnabled = (): boolean => {
        try {
          const raw = readFileSync(CONFIG_PATH, 'utf8');
          const doc = parseYaml(raw) as Record<string, unknown>;
          return doc['enabled'] !== false;
        } catch {
          return true;
        }
      };

      tgCmd.registerOperatorCommand('pause', async (msg) => {
        setEnabled(false);
        await tgCmd.reply(msg.chatId, '⏸ Bot PAUSED. Position stays open but no rebalances will occur. Send /resume to re-enable.');
        logger.info('bot paused via telegram command');
      });

      tgCmd.registerOperatorCommand('resume', async (msg) => {
        setEnabled(true);
        state.setDegraded(false, 'cleared via telegram /resume');
        await tgCmd.reply(msg.chatId, '▶️ Bot RESUMED. Degraded flag also cleared.');
        logger.info('bot resumed via telegram command');
      });

      tgCmd.registerOperatorCommand('status', async (msg) => {
        const pos = state.getCurrentPosition();
        const degraded = state.isDegraded();
        const enabled = isEnabled();
        const rebalancesToday = state.getRebalancesToday(Date.now());
        const lines = [
          enabled ? '🟢 Enabled' : '🔴 Paused',
          degraded ? '🟡 DEGRADED' : '✅ Healthy',
          `Position: ${pos ? pos.nftMint.slice(0, 8) + '...' : 'none'}`,
          pos ? `Range: $${pos.lowerUsd.toFixed(6)} – $${pos.upperUsd.toFixed(6)}` : '',
          `Rebalances today: ${rebalancesToday}`,
        ].filter(Boolean);
        await tgCmd.reply(msg.chatId, lines.join('\n'));
      });

      tgCmd.registerOperatorCommand('help', async (msg) => {
        await tgCmd.reply(msg.chatId, [
          'Commands:',
          '/pause — stop rebalancing (position stays open)',
          '/resume — re-enable bot + clear degraded flag',
          '/status — show current state',
          '/help — this message',
        ].join('\n'));
      });

      tgCmd.start();
    }
  }

  let lastHourlyReport = new Date().getUTCHours(); // skip immediate report on startup
  let ticksInRange = 0;
  let ticksTotal = 0;
  let rebalancesThisHour = 0;
  await notifier.send('INFO', `bert-mm-bot started (dryRun=${cfg.dryRun})`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const tickStart = Date.now();
    try {
      // Re-read enabled flag from config each tick (supports live pause/resume)
      let liveEnabled = cfg.enabled;
      try {
        const liveCfg = loadConfigFromFile(CONFIG_PATH);
        liveEnabled = liveCfg.enabled;
      } catch { /* use startup value on read failure */ }
      const killSwitchTripped = existsSync(cfg.killSwitchFilePath) || !liveEnabled;

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

        // Wallet balances + USD values
        let balanceLine = '';
        try {
          const bal = await raydium.getWalletBalances();
          const freeSol = Number(bal.solLamports) / 1e9;
          const freeBert = Number(bal.bertRaw) / 1e6;
          const solPrice = mid?.solUsd ?? 0;
          const bertPrice = mid?.bertUsd ?? 0;
          const freeSolUsd = freeSol * solPrice;
          const freeBertUsd = freeBert * bertPrice;
          const freeTotal = freeSolUsd + freeBertUsd;
          balanceLine = `Wallet: ${freeSol.toFixed(4)} SOL ($${freeSolUsd.toFixed(2)}) + ${freeBert.toFixed(0)} BERT ($${freeBertUsd.toFixed(2)}) = $${freeTotal.toFixed(2)} free`;
        } catch { balanceLine = 'Wallet: unavailable'; }

        // Position value + fees + total holdings
        let posValueLine = '';
        let feeLine = '';
        let totalLine = '';
        if (position) {
          posValueLine = `Position: $${position.totalValueUsd.toFixed(2)} in pool`;
          const feesBert = Number(position.uncollectedFeesBert) / 1e6;
          const feesSol = Number(position.uncollectedFeesSol) / 1e9;
          const feesUsd = feesBert * (mid?.bertUsd ?? 0) + feesSol * (mid?.solUsd ?? 0);
          feeLine = `Fees: ${feesBert.toFixed(4)} BERT + ${feesSol.toFixed(6)} SOL ($${feesUsd.toFixed(4)})`;

          // Total = free wallet + position + uncollected fees (via shared computeNav)
          try {
            const bal = await raydium.getWalletBalances();
            const nav = computeNav({
              freeSolLamports: bal.solLamports,
              freeBertRaw: bal.bertRaw,
              positionTotalValueUsd: position.totalValueUsd,
              uncollectedFeesBert: position.uncollectedFeesBert,
              uncollectedFeesSol: position.uncollectedFeesSol,
              solUsd: mid?.solUsd ?? 0,
              bertUsd: mid?.bertUsd ?? 0,
            });
            totalLine = `Total holdings: $${nav.totalUsd.toFixed(2)}`;
          } catch { /* skip */ }
        }

        // Pool volume from DexScreener
        let volumeLine = '';
        try {
          const dsRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${cfg.bertMint}`);
          if (dsRes.ok) {
            const dsData = await dsRes.json() as { pairs: Array<{ pairAddress: string; volume?: { h24?: string; h1?: string } }> };
            const pool = dsData.pairs?.find((p: { pairAddress: string }) => p.pairAddress === cfg.poolAddress);
            if (pool?.volume) {
              const vol24 = Number(pool.volume.h24 ?? 0);
              const vol1h = Number(pool.volume.h1 ?? 0);
              volumeLine = `Pool volume: $${vol1h.toFixed(0)}/1h, $${vol24.toFixed(0)}/24h`;
            }
          }
        } catch { /* skip */ }

        const lines = [
          `📊 Hourly Status (${new Date(tickStart).toISOString().slice(0, 16)}Z)`,
          `Price: ${priceInfo}`,
          `Range: ${posInfo}`,
          `In-range: ${inRangePct}% (${ticksInRange}/${ticksTotal} ticks, ~${uptimeMin}m)`,
          balanceLine,
          posValueLine,
          feeLine,
          totalLine,
          volumeLine,
          `Rebalances today: ${state.getRebalancesToday(tickStart)}/${cfg.maxRebalancesPerDay}`,
          `Status: ${killSwitchTripped ? '🔴 KILLED' : state.isDegraded() ? '🟡 DEGRADED' : '🟢 OK'}`,
        ].filter(Boolean);
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
