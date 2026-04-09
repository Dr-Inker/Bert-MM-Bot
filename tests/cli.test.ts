import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/stateStore.js';
import { runStatus } from '../src/cli/status.js';
import { runReport } from '../src/cli/report.js';
import type { BotConfig } from '../src/types.js';

const mockCfg: BotConfig = {
  enabled: true,
  poolAddress: 'pool123',
  bertMint: 'bert123',
  rangeWidthPct: 20,
  sustainedMinutes: 10,
  minRebalanceIntervalMin: 60,
  maxRebalancesPerDay: 6,
  maxSlippageBps: 100,
  maxDrawdownPct: 15,
  drawdownWindowMin: 30,
  maxPositionUsd: 2200,
  oracleDivergenceBps: 150,
  oracleStaleMinutes: 15,
  rpcOutageMinutes: 5,
  minSolBalance: 0.1,
  hardPauseSolBalance: 0.03,
  minSolFloorLamports: 100_000_000,
  priorityFeeMicroLamports: 10_000,
  pollIntervalSec: 10,
  feeCollectionMode: 'on_rebalance',
  feeHandling: 'compound',
  rpcPrimary: 'https://rpc.example.com',
  rpcFallback: 'https://rpc2.example.com',
  keyfilePath: '/tmp/key.json',
  statePath: '/tmp/state.db',
  killSwitchFilePath: '/tmp/ks',
  heartbeatPath: '/tmp/hb',
  notifier: { discord: { webhookInfo: 'https://discord.com/api/webhooks/0/info', webhookCritical: 'https://discord.com/api/webhooks/0/critical' } },
  dryRun: true,
};

let dir: string;
let store: StateStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bertmm-cli-'));
  store = new StateStore(join(dir, 'state.db'));
  store.init();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('runStatus', () => {
  it('outputs valid JSON with expected fields', () => {
    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });

    runStatus(mockCfg, store);

    const output = JSON.parse(chunks.join('')) as Record<string, unknown>;
    expect(output).toHaveProperty('timestamp');
    expect(output['enabled']).toBe(true);
    expect(output['degraded']).toBe(false);
    expect(output['currentPosition']).toBeNull();
    expect(output['lastRebalanceAt']).toBeNull();
    expect(output['rebalancesToday']).toBe(0);
    expect(Array.isArray(output['recentOperatorActions'])).toBe(true);
  });

  it('reflects degraded state and operator actions', () => {
    store.setDegraded(true, 'test reason');
    store.recordOperatorAction({ ts: Date.now(), command: 'test-cmd', osUser: 'alice' });

    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });

    runStatus(mockCfg, store);

    const output = JSON.parse(chunks.join('')) as Record<string, unknown>;
    expect(output['degraded']).toBe(true);
    const actions = output['recentOperatorActions'] as Array<{ command: string }>;
    expect(actions[0]?.command).toBe('test-cmd');
  });
});

describe('runReport', () => {
  it('outputs report with zero rebalances when log is empty', () => {
    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });

    runReport(mockCfg, store, 7);

    const output = JSON.parse(chunks.join('')) as Record<string, unknown>;
    expect(output).toHaveProperty('period', 'last 7 day(s)');
    const rebalances = output['rebalances'] as { count: number };
    expect(rebalances.count).toBe(0);
  });

  it('includes rebalances within the window', () => {
    const now = Date.now();
    store.recordRebalance({ ts: now - 1000, oldCenterUsd: 0.01, newCenterUsd: 0.012, feesCollectedUsd: 0.001 });
    store.recordRebalance({ ts: now - 10 * 86_400_000, oldCenterUsd: 0.009, newCenterUsd: 0.01, feesCollectedUsd: 0 });

    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });

    runReport(mockCfg, store, 7);

    const output = JSON.parse(chunks.join('')) as Record<string, unknown>;
    const rebalances = output['rebalances'] as { count: number; totalFeesCollectedUsd: number };
    expect(rebalances.count).toBe(1);
    expect(rebalances.totalFeesCollectedUsd).toBeCloseTo(0.001);
  });
});
