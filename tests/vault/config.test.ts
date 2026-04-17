import { describe, it, expect } from 'vitest';
import { BotConfigSchema } from '../../src/config.js';

// `base` mirrors the actual BotConfigSchema (see src/config.ts) — the plan's
// example shape was a best-effort and omitted/added fields. Keep this in sync
// with the schema; only the vault-related assertions are load-bearing here.
describe('vault config', () => {
  const base = {
    venue: 'meteora' as const,
    enabled: true,
    poolAddress: '9LkdXDXQkWC8RgqMTn2eAnzgFTNjKjJiSq4smpdKLuaH',
    bertMint: 'HgBRWfYxEfvPhtqkaeymCQtHCrKE46qQ43pKe8HCpump',
    rangeWidthPct: 6,
    sustainedMinutes: 10,
    minRebalanceIntervalMin: 60,
    maxRebalancesPerDay: 6,
    maxSlippageBps: 300,
    maxDrawdownPct: 30,
    drawdownWindowMin: 30,
    maxPositionUsd: 200,
    oracleDivergenceBps: 150,
    oracleStaleMinutes: 15,
    rpcOutageMinutes: 5,
    minSolBalance: 0.1,
    hardPauseSolBalance: 0.03,
    minSolFloorLamports: 100_000_000,
    priorityFeeMicroLamports: 10_000,
    pollIntervalSec: 30,
    feeCollectionMode: 'on_rebalance' as const,
    feeHandling: 'compound' as const,
    rpcPrimary: 'https://mainnet.helius-rpc.com/?api-key=x',
    rpcFallback: 'https://mainnet.helius-rpc.com/?api-key=y',
    keyfilePath: '/etc/bert-mm-bot/hot-wallet.json',
    statePath: '/var/lib/bert-mm-bot/state.db',
    killSwitchFilePath: '/etc/bert-mm-bot/KILLSWITCH',
    heartbeatPath: '/var/lib/bert-mm-bot/heartbeat.txt',
    notifier: {
      discord: {
        webhookInfo: 'https://discord.com/api/webhooks/info',
        webhookCritical: 'https://discord.com/api/webhooks/critical',
      },
    },
    dryRun: false,
    mevProtection: { enabled: false },
  };

  it('accepts config without vault block (vault disabled)', () => {
    const r = BotConfigSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.vault?.enabled ?? false).toBe(false);
  });

  it('accepts config with vault block enabled', () => {
    const r = BotConfigSchema.safeParse({
      ...base,
      vault: {
        enabled: true,
        withdrawalFeeBps: 30,
        minDepositUsd: 10,
        minWithdrawalUsd: 5,
        maxDailyWithdrawalsPerUser: 3,
        maxDailyWithdrawalUsdPerUser: 5000,
        maxPendingWithdrawals: 50,
        depositMinConfirms: 1,
        whitelistCooldownHours: 24,
        operatorTelegramId: 12345,
      },
    });
    expect(r.success).toBe(true);
  });

  it('rejects vault config with negative fee', () => {
    const r = BotConfigSchema.safeParse({
      ...base,
      vault: {
        enabled: true,
        withdrawalFeeBps: -5,
        minDepositUsd: 10,
        minWithdrawalUsd: 5,
        maxDailyWithdrawalsPerUser: 3,
        maxDailyWithdrawalUsdPerUser: 5000,
        maxPendingWithdrawals: 50,
        depositMinConfirms: 1,
        whitelistCooldownHours: 24,
        operatorTelegramId: 12345,
      },
    });
    expect(r.success).toBe(false);
  });

  it('rejects vault config missing operatorTelegramId when enabled', () => {
    const r = BotConfigSchema.safeParse({
      ...base,
      vault: {
        enabled: true,
        withdrawalFeeBps: 30,
        minDepositUsd: 10,
        minWithdrawalUsd: 5,
        maxDailyWithdrawalsPerUser: 3,
        maxDailyWithdrawalUsdPerUser: 5000,
        maxPendingWithdrawals: 50,
        depositMinConfirms: 1,
        whitelistCooldownHours: 24,
      },
    });
    expect(r.success).toBe(false);
  });
});
