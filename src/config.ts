import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { readFileSync } from 'node:fs';
import type { BotConfig } from './types.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(`ConfigError: ${message}`);
    this.name = 'ConfigError';
  }
}

const NotifierSchema = z
  .object({
    telegram: z
      .object({
        botToken: z.string().min(1),
        chatIdInfo: z.string().min(1),
        chatIdCritical: z.string().min(1),
      })
      .optional(),
    discord: z
      .object({
        webhookInfo: z.string().url(),
        webhookCritical: z.string().url(),
      })
      .optional(),
  })
  .refine((n) => n.telegram || n.discord, {
    message: 'at least one of telegram/discord must be configured',
  })
  .optional();

const BotConfigSchema = z
  .object({
    enabled: z.boolean(),
    poolAddress: z.string().min(32),
    bertMint: z.string().min(32),
    rangeWidthPct: z.number().min(1).max(100),
    sustainedMinutes: z.number().int().min(1).max(120),
    minRebalanceIntervalMin: z.number().int().min(5).max(1440),
    maxRebalancesPerDay: z.number().int().min(1).max(48),
    maxSlippageBps: z.number().int().min(1).max(500),
    maxDrawdownPct: z.number().min(1).max(50),
    drawdownWindowMin: z.number().int().min(5).max(240),
    maxPositionUsd: z.number().positive(),
    oracleDivergenceBps: z.number().int().min(1).max(500),
    oracleStaleMinutes: z.number().int().min(1).max(60),
    rpcOutageMinutes: z.number().int().min(1).max(30),
    minSolBalance: z.number().positive(),
    hardPauseSolBalance: z.number().positive(),
    minSolFloorLamports: z.number().int().positive().default(100_000_000),
    priorityFeeMicroLamports: z.number().int().positive().default(10_000),
    pollIntervalSec: z.number().int().min(10).max(300),
    feeCollectionMode: z.enum(['on_rebalance', 'scheduled']),
    feeHandling: z.enum(['compound', 'sweep']),
    rpcPrimary: z.string().url(),
    rpcFallback: z.string().url(),
    keyfilePath: z.string().min(1),
    statePath: z.string().min(1),
    killSwitchFilePath: z.string().min(1),
    heartbeatPath: z.string().min(1),
    notifier: NotifierSchema,
    dryRun: z.boolean(),
  })
  .refine((c) => c.hardPauseSolBalance < c.minSolBalance, {
    message: 'hardPauseSolBalance must be < minSolBalance',
  });

export function loadConfig(yamlText: string): BotConfig {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (e) {
    throw new ConfigError(`YAML parse failed: ${(e as Error).message}`);
  }
  const parsed = BotConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }
  return parsed.data as BotConfig;
}

export function loadConfigFromFile(path: string): BotConfig {
  return loadConfig(readFileSync(path, 'utf8'));
}
