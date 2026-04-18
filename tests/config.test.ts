import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError } from '../src/config.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const VALID_PATH = join(__dirname, 'fixtures', 'valid-config.yaml');
const validYaml = readFileSync(VALID_PATH, 'utf8');

interface BaseYamlOpts {
  uiButtons?: boolean;
  uiButtonsOmit?: boolean;
}

/** Append a `vault:` block to the base valid YAML, optionally toggling uiButtons. */
function baseYamlWithVault(opts: BaseYamlOpts = {}): string {
  const { uiButtons, uiButtonsOmit } = opts;
  const vaultLines = [
    'vault:',
    '  enabled: true',
    '  withdrawalFeeBps: 30',
    '  minDepositUsd: 10',
    '  minWithdrawalUsd: 5',
    '  maxDailyWithdrawalsPerUser: 3',
    '  maxDailyWithdrawalUsdPerUser: 5000',
    '  maxPendingWithdrawals: 50',
    '  depositMinConfirms: 1',
    '  whitelistCooldownHours: 24',
    '  operatorTelegramId: 12345',
  ];
  if (!uiButtonsOmit) {
    const value = uiButtons === undefined ? true : uiButtons;
    vaultLines.push(`  uiButtons: ${value}`);
  }
  return `${validYaml}\n${vaultLines.join('\n')}\n`;
}

describe('config loader', () => {
  it('parses a valid config', () => {
    const cfg = loadConfig(validYaml);
    expect(cfg.rangeWidthPct).toBe(20);
    expect(cfg.enabled).toBe(true);
    expect(cfg.feeHandling).toBe('compound');
  });

  it('rejects rangeWidthPct out of bounds (too small)', () => {
    const bad = validYaml.replace('rangeWidthPct: 20', 'rangeWidthPct: 0.2');
    expect(() => loadConfig(bad)).toThrow(ConfigError);
  });

  it('rejects rangeWidthPct above 100', () => {
    const bad = validYaml.replace('rangeWidthPct: 20', 'rangeWidthPct: 150');
    expect(() => loadConfig(bad)).toThrow(ConfigError);
  });

  it('rejects maxSlippageBps above 500', () => {
    const bad = validYaml.replace('maxSlippageBps: 100', 'maxSlippageBps: 1000');
    expect(() => loadConfig(bad)).toThrow(ConfigError);
  });

  it('rejects unknown feeHandling', () => {
    const bad = validYaml.replace('feeHandling: "compound"', 'feeHandling: "burn"');
    expect(() => loadConfig(bad)).toThrow(ConfigError);
  });

  it('requires at least one notifier channel', () => {
    const bad = validYaml.replace(/notifier:[\s\S]*?dryRun/, 'notifier: {}\ndryRun');
    expect(() => loadConfig(bad)).toThrow(ConfigError);
  });

  it('requires hardPauseSolBalance < minSolBalance', () => {
    const bad = validYaml.replace('hardPauseSolBalance: 0.03', 'hardPauseSolBalance: 0.5');
    expect(() => loadConfig(bad)).toThrow(ConfigError);
  });
});

describe('vault.uiButtons flag', () => {
  it('defaults to true when vault present but flag omitted', () => {
    const yaml = baseYamlWithVault({ uiButtonsOmit: true });
    const cfg = loadConfig(yaml);
    expect(cfg.vault?.uiButtons).toBe(true);
  });
  it('honors explicit false', () => {
    const yaml = baseYamlWithVault({ uiButtons: false });
    const cfg = loadConfig(yaml);
    expect(cfg.vault?.uiButtons).toBe(false);
  });
});
