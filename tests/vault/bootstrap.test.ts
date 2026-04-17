import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateStore } from '../../src/stateStore.js';
import { DepositorStore } from '../../src/vault/depositorStore.js';
import { runBootstrap } from '../../src/cli/vault-bootstrap.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('vault-bootstrap', () => {
  let dir: string; let state: StateStore; let store: DepositorStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bertmm-'));
    state = new StateStore(join(dir, 'state.db'));
    state.init();
    store = new DepositorStore(state);
  });
  afterEach(() => { state.close(); rmSync(dir, { recursive: true, force: true }); });

  it('inserts operator user + shares + snapshot', async () => {
    await runBootstrap({
      store,
      masterKey: Buffer.alloc(32, 9),
      operatorTelegramId: 42,
      initialNavUsd: 220,
      ensureAta: async () => {},
      now: 1000,
    });
    expect(store.getUser(42)!.role).toBe('operator');
    expect(store.getShares(42)).toBe(220);
    expect(store.latestNavSnapshot()!.source).toBe('bootstrap');
    expect(store.latestNavSnapshot()!.navPerShare).toBe(1);
  });

  it('refuses to run twice (guard on existing users)', async () => {
    await runBootstrap({
      store, masterKey: Buffer.alloc(32, 9),
      operatorTelegramId: 42, initialNavUsd: 220,
      ensureAta: async () => {}, now: 1000,
    });
    await expect(runBootstrap({
      store, masterKey: Buffer.alloc(32, 9),
      operatorTelegramId: 42, initialNavUsd: 220,
      ensureAta: async () => {}, now: 1000,
    })).rejects.toThrow(/already/);
  });
});
