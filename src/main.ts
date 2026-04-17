import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { loadConfigFromFile } from './config.js';
import { logger } from './logger.js';
import { StateStore } from './stateStore.js';
import { Notifier } from './notifier.js';
import { TelegramCommander } from './telegramCommander.js';
import { DepositorStore } from './vault/depositorStore.js';
import { Enrollment } from './vault/enrollment.js';
import { Cooldowns } from './vault/cooldowns.js';
import { CommandHandlers } from './vault/commands.js';
import { OperatorCommandHandlers } from './vault/operatorCommands.js';
import { AuditLog } from './vault/audit.js';
import { loadMasterKey } from './vault/encryption.js';
import { DepositWatcher } from './vault/depositWatcher.js';
import { CreditEngine } from './vault/creditEngine.js';
import { DepositPipeline } from './vault/depositPipeline.js';
import { WithdrawalExecutor } from './vault/withdrawalExecutor.js';
import { buildWithdrawalInstructions } from './vault/withdrawalBuilder.js';
import { computeNavPerShare } from './vault/shareMath.js';
import { runVaultPreRebalance, runVaultPostRebalance } from './vault/tick.js';
import { decide, StrategyParams } from './strategy.js';
import { computeTrustedMid, fetchAllSources } from './priceOracle.js';
import { createVenueClient } from './venueClient.js';
import { TxSubmitter } from './txSubmitter.js';
import { JitoClient } from './jitoClient.js';
import { makeFetchers } from './priceFetchers.js';
import { reconcile } from './reconciler.js';
import { executeRebalance } from './rebalancer.js';
import { computeNav, computeVaultStats, formatVaultStatsLine } from './vault/navSnapshot.js';
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

  // ─── Vault runtime (constructed outside the telegram block so the tick ───
  // loop can reach it even when telegram is not configured). Only populated
  // when cfg.vault.enabled is true. All fields are the live objects used by
  // the pre/post-rebalance tick helpers.
  interface VaultRuntime {
    depositorStore: DepositorStore;
    cooldowns: Cooldowns;
    watcher: DepositWatcher;
    executor: WithdrawalExecutor;
  }
  let vaultRuntime: VaultRuntime | null = null;

  // N3: If the vault is enabled, require an explicit operator user id so
  // operator-auth cannot silently fall back to the notifier chat id.
  if (cfg.vault?.enabled && !cfg.vault.operatorTelegramId) {
    throw new Error(
      'vault.enabled=true but vault.operatorTelegramId is missing — refusing to start',
    );
  }

  // Start Telegram command listener (if configured)
  if (cfg.notifier?.telegram) {
    const depositorStore = new DepositorStore(state);
    // N3: operator auth is by user id. Prefer vault.operatorTelegramId when
    // the vault is enabled (that's the canonical operator identity). When
    // the vault is off, fall back to notifier.telegram.chatIdInfo so existing
    // MM bot /pause /resume /status commands keep working in private DMs
    // (where userId === chatId).
    const operatorUserId = cfg.vault?.enabled
      ? cfg.vault.operatorTelegramId
      : Number(cfg.notifier.telegram.chatIdInfo);
    if (!Number.isFinite(operatorUserId)) {
      logger.warn(
        { source: cfg.vault?.enabled ? 'vault.operatorTelegramId' : 'notifier.telegram.chatIdInfo' },
        'telegram operator user id is not numeric; telegram commander disabled',
      );
    } else {
      const tgCmd = new TelegramCommander({
        botToken: cfg.notifier.telegram.botToken,
        operatorUserId,
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

      // ─── Vault user-facing commands ─────────────────────────────────────
      if (cfg.vault?.enabled) {
        try {
          const masterKey = loadMasterKey();
          // Real ATA creation (Task 20): when a user enrolls, create the BERT
          // ATA for their fresh deposit address so inbound SPL transfers can
          // land. Uses the payer keypair to cover the account-create rent; the
          // ATA is idempotent so this is safe to call unconditionally.
          const bertMintPk = new PublicKey(cfg.bertMint);
          const ensureAta = async (addr: string): Promise<void> => {
            try {
              const owner = new PublicKey(addr);
              const ata = getAssociatedTokenAddressSync(bertMintPk, owner, false);
              // Short-circuit if the ATA already exists (cheap RPC call vs.
              // paying fees for a redundant tx).
              const existing = await raydium.getConnection().getAccountInfo(ata);
              if (existing !== null) {
                logger.info({ depositAddress: addr, ata: ata.toBase58() }, 'vault: BERT ATA already exists');
                return;
              }
              const tx = new Transaction().add(
                createAssociatedTokenAccountIdempotentInstruction(
                  payer.publicKey, ata, owner, bertMintPk,
                ),
              );
              const sig = await sendAndConfirmTransaction(
                raydium.getConnection(), tx, [payer], { commitment: 'confirmed' },
              );
              logger.info(
                { depositAddress: addr, ata: ata.toBase58(), sig },
                'vault: BERT ATA created for new deposit address',
              );
            } catch (e) {
              // Non-fatal: the sweeper can create the ATA later if needed, and
              // enrollment doesn't rely on the ATA existing to record the user.
              logger.warn({ err: e, depositAddress: addr }, 'vault: ATA creation failed (non-fatal)');
            }
          };
          const depositorStoreLocal = depositorStore; // re-alias for clarity
          const enrollment = new Enrollment({
            store: depositorStoreLocal,
            masterKey,
            ensureAta,
          });
          const cooldowns = new Cooldowns({
            store: depositorStoreLocal,
            cooldownMs: cfg.vault.whitelistCooldownHours * 3600_000,
          });

          // ─── Deposit pipeline ────────────────────────────────────────────
          // Wires deposit-watcher → sweeper → creditEngine. The watcher
          // polls each enrolled user's deposit address; any new inbound
          // tx triggers `pipeline.onInflow`, which sweeps + credits shares.
          const creditEngine = new CreditEngine({ store: depositorStoreLocal });
          const depositPipeline = new DepositPipeline({
            store: depositorStoreLocal,
            connection: raydium.getConnection(),
            payerKeypair: payer,
            bertMint: bertMintPk,
            masterKey,
            creditEngine,
            getMid: async () => {
              // Use the most recent price sample in history (mirrors how the
              // rebalancer sees prices). If priceHistory is empty at tick 0,
              // return null — pipeline will defer credit and retry on the
              // next watcher poll.
              const last = priceHistory[priceHistory.length - 1];
              return last ? { solUsd: last.solUsd, bertUsd: last.bertUsd } : null;
            },
            getNavPerShare: async () => {
              const snap = depositorStoreLocal.latestNavSnapshot();
              const totalShares = depositorStoreLocal.totalShares();
              return computeNavPerShare({
                totalUsd: snap?.totalValueUsd ?? 0,
                totalShares,
              });
            },
            // Leave 2M lamports in each deposit address for the BERT ATA's
            // rent-exempt reserve (ATAs need ~2_039_280 lamports per mint).
            rentReserveLamports: 2_039_280n,
            now: () => Date.now(),
            log: logger,
            submitTx: async (tx, extraSigners) => {
              const sig = await sendAndConfirmTransaction(
                raydium.getConnection(), tx, [payer, ...extraSigners],
                { commitment: 'confirmed' },
              );
              return sig;
            },
          });
          const depositWatcher = new DepositWatcher({
            connection: raydium.getConnection(),
            bertMint: cfg.bertMint,
            isAlreadyCredited: (sig) => depositorStoreLocal.hasDeposit(sig),
            onInflow: (event) => depositPipeline.onInflow(event),
          });

          // ─── Withdrawal executor ────────────────────────────────────────
          const withdrawalExecutor = new WithdrawalExecutor({
            store: depositorStoreLocal,
            getMid: async () => {
              const last = priceHistory[priceHistory.length - 1];
              return last ? { solUsd: last.solUsd, bertUsd: last.bertUsd } : null;
            },
            getWalletBalances: () => raydium.getWalletBalances(),
            getPositionSnapshot: async () => {
              const stored = state.getCurrentPosition();
              if (!stored) return { totalValueUsd: 0, solUsdInPosition: 0, bertUsdInPosition: 0 };
              const last = priceHistory[priceHistory.length - 1];
              const solUsd = last?.solUsd ?? 0;
              const pos = await raydium.getPosition(stored.nftMint, solUsd);
              return {
                totalValueUsd: pos?.totalValueUsd ?? 0,
                solUsdInPosition: 0,
                bertUsdInPosition: 0,
              };
            },
            reserveSolLamports: BigInt(cfg.minSolFloorLamports),
            partialClose: async ({ needSolLamports, needBertRaw }) => {
              const stored = state.getCurrentPosition();
              if (!stored) {
                throw new Error('partialClose: no stored position');
              }
              const tx = await raydium.buildPartialCloseTx({
                positionId: stored.nftMint,
                needSolLamports,
                needBertRaw,
              });
              await submitter.submit(tx, { priorityFeeMicroLamports: cfg.priorityFeeMicroLamports });
            },
            executeTransfer: async ({ destination, solLamports, bertRaw }) => {
              const ixs = buildWithdrawalInstructions({
                payer: payer.publicKey,
                destinationWallet: new PublicKey(destination),
                solLamports,
                bertRaw,
                bertMint: bertMintPk,
                createDestAtaIfMissing: true,
              });
              const tx = new Transaction();
              for (const ix of ixs) tx.add(ix);
              const sig = await submitter.submit(tx, {
                priorityFeeMicroLamports: cfg.priorityFeeMicroLamports,
              });
              return { txSig: sig };
            },
            now: () => Date.now(),
          });

          vaultRuntime = {
            depositorStore: depositorStoreLocal,
            cooldowns,
            watcher: depositWatcher,
            executor: withdrawalExecutor,
          };

          const getNav = (): { totalUsd: number; totalShares: number } => {
            const snap = depositorStoreLocal.latestNavSnapshot();
            const totalShares = depositorStoreLocal.totalShares();
            if (snap) {
              return { totalUsd: snap.totalValueUsd, totalShares };
            }
            return { totalUsd: 0, totalShares };
          };
          const handlers = new CommandHandlers({
            store: depositorStoreLocal,
            enrollment,
            cooldowns,
            masterKey,
            reply: (chatId, text) => tgCmd.reply(chatId, text),
            config: {
              withdrawalFeeBps: cfg.vault.withdrawalFeeBps,
              minWithdrawalUsd: cfg.vault.minWithdrawalUsd,
              maxDailyWithdrawalsPerUser: cfg.vault.maxDailyWithdrawalsPerUser,
              maxDailyWithdrawalUsdPerUser: cfg.vault.maxDailyWithdrawalUsdPerUser,
              maxPendingWithdrawals: cfg.vault.maxPendingWithdrawals,
            },
            getNav,
            nowMs: () => Date.now(),
          });

          tgCmd.registerEnrollmentCommand('account', (msg) => handlers.handleAccount(msg));
          tgCmd.registerEnrollmentCommand('accept', (msg) => handlers.handleAccept(msg));
          tgCmd.registerEnrollmentCommand('decline', (msg) => handlers.handleDecline(msg));
          tgCmd.registerVaultCommand('deposit', (msg) => handlers.handleDeposit(msg));
          tgCmd.registerVaultCommand('balance', (msg) => handlers.handleBalance(msg));
          tgCmd.registerVaultCommand('withdraw', (msg) => handlers.handleWithdraw(msg));
          tgCmd.registerVaultCommand('setwhitelist', (msg) => handlers.handleSetWhitelist(msg));
          tgCmd.registerVaultCommand('cancelwhitelist', (msg) => handlers.handleCancelWhitelist(msg));
          tgCmd.registerPublicCommand('stats', (msg) => handlers.handleStats(msg));
          // Non-command text messages (TOTP replies) route through fallback
          tgCmd.registerFallback((msg) => handlers.handleMessage(msg));

          // Operator-only vault commands (gated by operatorUserId in TelegramCommander)
          const operatorHandlers = new OperatorCommandHandlers({
            store: depositorStoreLocal,
            state,
            audit: new AuditLog(depositorStoreLocal),
            reply: (chatId, text) => tgCmd.reply(chatId, text),
            nowMs: () => Date.now(),
            creditEngine,
            getMid: async () => {
              const last = priceHistory[priceHistory.length - 1];
              return last ? { solUsd: last.solUsd, bertUsd: last.bertUsd } : null;
            },
          });
          tgCmd.registerOperatorCommand('pausevault', (msg) => operatorHandlers.handlePause(msg));
          tgCmd.registerOperatorCommand('resumevault', (msg) => operatorHandlers.handleResume(msg));
          tgCmd.registerOperatorCommand('vaultstatus', (msg) => operatorHandlers.handleStatus(msg));
          tgCmd.registerOperatorCommand('forceprocess', (msg) => operatorHandlers.handleForceProcess(msg));
          tgCmd.registerOperatorCommand('recreditdeposit', (msg) => operatorHandlers.handleRecreditDeposit(msg));
          logger.info('vault commands wired into telegram commander');
        } catch (e) {
          logger.error({ err: e }, 'vault wiring failed — vault commands disabled');
        }
      }

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

      // ─── Vault: poll deposit addresses (runs BEFORE rebalance so any
      // inflows are swept + credited against a fresh NAV). Errors are
      // swallowed per-address inside the helper.
      if (vaultRuntime) {
        await runVaultPreRebalance({
          store: vaultRuntime.depositorStore,
          pollAddress: (addr) => vaultRuntime!.watcher.pollAddress(addr),
          log: logger,
        });
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

      // ─── Vault: drain withdrawals + activate due whitelist changes.
      // Runs AFTER rebalance so free-balance / position state reflects the
      // latest swap. Gated on degraded / kill-switch / vault-paused — the
      // helper enforces these internally.
      if (vaultRuntime) {
        await runVaultPostRebalance({
          store: vaultRuntime.depositorStore,
          state,
          isDegraded: () => state.isDegraded(),
          isKilled: () => killSwitchTripped,
          drain: () => vaultRuntime!.executor.drain(),
          activateDue: (args) => vaultRuntime!.cooldowns.activateDue(args),
          now: () => Date.now(),
          log: logger,
        });
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

        // Vault stats (only when vault is enabled + wired). Uses live NAV
        // (fresh balances + position value) rather than the latest snapshot,
        // so TVL reflects the current state. 24h delta falls back to 0 when
        // no snapshot exists yet (vault < 24h old).
        let vaultLine = '';
        if (cfg.vault?.enabled && vaultRuntime) {
          try {
            const store = vaultRuntime.depositorStore;
            const users = store.listUsers();
            const totalShares = store.totalShares();
            const queued = store.countPendingWithdrawals();

            // Prefer live NAV; fall back to latest snapshot if balance/position
            // fetch fails.
            // N5: reserved SOL (minSolFloor) is un-spendable by users —
            // exclude it from the vault's NAV / TVL figure so depositor
            // balances and /stats reflect withdrawable value only.
            let tvlUsd = 0;
            try {
              const bal = await raydium.getWalletBalances();
              const reserve = BigInt(cfg.minSolFloorLamports);
              const spendableSol = bal.solLamports > reserve
                ? bal.solLamports - reserve
                : 0n;
              const liveNav = computeNav({
                freeSolLamports: spendableSol,
                freeBertRaw: bal.bertRaw,
                positionTotalValueUsd: position?.totalValueUsd ?? 0,
                uncollectedFeesBert: position?.uncollectedFeesBert ?? 0n,
                uncollectedFeesSol: position?.uncollectedFeesSol ?? 0n,
                solUsd: mid?.solUsd ?? 0,
                bertUsd: mid?.bertUsd ?? 0,
              });
              tvlUsd = liveNav.totalUsd;
            } catch {
              tvlUsd = store.latestNavSnapshot()?.totalValueUsd ?? 0;
            }

            const snapshot24hAgo = store.navSnapshotAtOrBefore(tickStart - 24 * 3600 * 1000);
            const stats = computeVaultStats({
              depositorCount: users.length,
              totalShares,
              tvlUsd,
              queuedWithdrawals: queued,
              snapshot24hAgo,
            });
            vaultLine = formatVaultStatsLine(stats);
          } catch (e) {
            logger.warn({ err: e }, 'hourly report: vault stats computation failed');
          }
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
          vaultLine,
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
