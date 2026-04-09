import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError } from '../src/config.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const VALID_PATH = join(__dirname, 'fixtures', 'valid-config.yaml');
const validYaml = readFileSync(VALID_PATH, 'utf8');

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
