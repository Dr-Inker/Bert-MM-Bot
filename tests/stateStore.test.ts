import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateStore } from '../src/stateStore.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let store: StateStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bertmm-'));
  store = new StateStore(join(dir, 'state.db'));
  store.init();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('StateStore', () => {
  it('initializes empty', () => {
    expect(store.getCurrentPosition()).toBeNull();
    expect(store.getRebalancesToday(Date.UTC(2026, 3, 9))).toBe(0);
    expect(store.isDegraded()).toBe(false);
  });

  it('persists current position', () => {
    store.setCurrentPosition({
      nftMint: 'ABC123',
      lowerUsd: 0.008,
      upperUsd: 0.012,
      centerUsd: 0.01,
      openedAt: 1_700_000_000_000,
    });
    const pos = store.getCurrentPosition();
    expect(pos?.nftMint).toBe('ABC123');
    expect(pos?.centerUsd).toBe(0.01);
  });

  it('counts rebalances per UTC day', () => {
    const day = Date.UTC(2026, 3, 9);
    const nextDay = Date.UTC(2026, 3, 10);
    store.recordRebalance({ ts: day + 1000, oldCenterUsd: 0.01, newCenterUsd: 0.011, feesCollectedUsd: 1.2 });
    store.recordRebalance({ ts: day + 2000, oldCenterUsd: 0.011, newCenterUsd: 0.012, feesCollectedUsd: 0.8 });
    store.recordRebalance({ ts: nextDay + 1000, oldCenterUsd: 0.012, newCenterUsd: 0.013, feesCollectedUsd: 0.5 });
    expect(store.getRebalancesToday(day)).toBe(2);
    expect(store.getRebalancesToday(nextDay)).toBe(1);
  });

  it('tracks degraded flag', () => {
    expect(store.isDegraded()).toBe(false);
    store.setDegraded(true, 'drawdown breaker');
    expect(store.isDegraded()).toBe(true);
    store.setDegraded(false, 'operator cleared');
    expect(store.isDegraded()).toBe(false);
  });

  it('records operator actions with user', () => {
    store.recordOperatorAction({ ts: 1_700_000_000_000, command: 'emergency-exit', osUser: 'alice' });
    const actions = store.listOperatorActions(10);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.osUser).toBe('alice');
  });

  it('survives reopen', () => {
    store.setCurrentPosition({
      nftMint: 'XYZ789',
      lowerUsd: 0.007,
      upperUsd: 0.013,
      centerUsd: 0.01,
      openedAt: 1_700_000_000_000,
    });
    const path = store.path;
    store.close();
    const reopened = new StateStore(path);
    reopened.init();
    expect(reopened.getCurrentPosition()?.nftMint).toBe('XYZ789');
    reopened.close();
  });
});
