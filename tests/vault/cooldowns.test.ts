import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateStore } from '../../src/stateStore.js';
import { DepositorStore } from '../../src/vault/depositorStore.js';
import { Cooldowns } from '../../src/vault/cooldowns.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Cooldowns', () => {
  let dir: string;
  let state: StateStore;
  let store: DepositorStore;
  let cool: Cooldowns;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bertmm-'));
    state = new StateStore(join(dir, 'state.db'));
    state.init();
    store = new DepositorStore(state);
    cool = new Cooldowns({ store, cooldownMs: 24 * 3600 * 1000 });
    store.createUser({ telegramId: 1, role: 'depositor', depositAddress: 'A',
      depositSecretEnc: Buffer.alloc(0), depositSecretIv: Buffer.alloc(0),
      disclaimerAt: 100, createdAt: 100 });
  });
  afterEach(() => { state.close(); rmSync(dir, { recursive: true, force: true }); });

  it('first-set applies immediately', () => {
    const r = cool.requestChange({ telegramId: 1, newAddress: 'DEST1', now: 1000 });
    expect(r.immediate).toBe(true);
    const u = store.getUser(1)!;
    expect(u.whitelistAddress).toBe('DEST1');
  });

  it('subsequent change schedules 24h cooldown', () => {
    cool.requestChange({ telegramId: 1, newAddress: 'DEST1', now: 1000 });
    const r = cool.requestChange({ telegramId: 1, newAddress: 'DEST2', now: 2000 });
    expect(r.immediate).toBe(false);
    expect(r.activatesAt).toBe(2000 + 24 * 3600 * 1000);
    expect(store.getUser(1)!.whitelistAddress).toBe('DEST1'); // not yet changed
  });

  it('activateDue applies pending changes whose time has come', () => {
    cool.requestChange({ telegramId: 1, newAddress: 'DEST1', now: 1000 });
    cool.requestChange({ telegramId: 1, newAddress: 'DEST2', now: 2000 });
    const activated = cool.activateDue({ now: 2000 + 24 * 3600 * 1000 + 1 });
    expect(activated.length).toBe(1);
    expect(store.getUser(1)!.whitelistAddress).toBe('DEST2');
  });

  it('cancel rejects most recent pending change', () => {
    cool.requestChange({ telegramId: 1, newAddress: 'DEST1', now: 1000 });
    cool.requestChange({ telegramId: 1, newAddress: 'DEST2', now: 2000 });
    const ok = cool.cancelPending({ telegramId: 1, reason: 'user', now: 3000 });
    expect(ok).toBe(true);
    cool.activateDue({ now: 2000 + 24 * 3600 * 1000 + 1 });
    expect(store.getUser(1)!.whitelistAddress).toBe('DEST1'); // change was cancelled
  });

  it('cancel returns false when nothing pending', () => {
    cool.requestChange({ telegramId: 1, newAddress: 'DEST1', now: 1000 });
    const ok = cool.cancelPending({ telegramId: 1, reason: 'user', now: 3000 });
    expect(ok).toBe(false);  // first-set was immediate; no pending rows
  });
});
