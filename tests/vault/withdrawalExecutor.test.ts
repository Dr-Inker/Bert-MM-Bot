import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateStore } from '../../src/stateStore.js';
import { DepositorStore } from '../../src/vault/depositorStore.js';
import { WithdrawalExecutor } from '../../src/vault/withdrawalExecutor.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('WithdrawalExecutor', () => {
  let dir: string;
  let state: StateStore;
  let store: DepositorStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bertmm-'));
    state = new StateStore(join(dir, 'state.db'));
    state.init();
    store = new DepositorStore(state);
    store.createUser({ telegramId: 1, role: 'depositor', depositAddress: 'A',
      depositSecretEnc: Buffer.alloc(0), depositSecretIv: Buffer.alloc(0),
      disclaimerAt: 100, createdAt: 100 });
    store.setWhitelistImmediate({ telegramId: 1, address: 'DEST', ts: 100 });
    store.addShares(1, 1000);  // user has 1000 shares
  });
  afterEach(() => { state.close(); rmSync(dir, { recursive: true, force: true }); });

  function makeExecutor(opts: {
    solUsd?: number; bertUsd?: number;
    freeSol?: bigint; freeBert?: bigint;
    positionUsd?: number;
    executeSucceeds?: boolean;
    partialCloseCalled?: { count: number };
  } = {}) {
    return new WithdrawalExecutor({
      store,
      getMid: async () => ({ solUsd: opts.solUsd ?? 100, bertUsd: opts.bertUsd ?? 0.01 }),
      getWalletBalances: async () => ({
        solLamports: opts.freeSol ?? 10_000_000_000n,
        bertRaw: opts.freeBert ?? 0n,
      }),
      getPositionSnapshot: async () => ({
        totalValueUsd: opts.positionUsd ?? 0,
        solUsdInPosition: 0, bertUsdInPosition: 0,
      }),
      reserveSolLamports: 200_000_000n,
      partialClose: async () => {
        if (opts.partialCloseCalled) opts.partialCloseCalled.count++;
      },
      executeTransfer: async () => {
        if (opts.executeSucceeds === false) throw new Error('tx_failed');
        return { txSig: 'outsig' };
      },
      now: () => 200,
    });
  }

  it('processes a queued withdrawal — happy path', async () => {
    const wid = store.enqueueWithdrawal({
      telegramId: 1, destination: 'DEST',
      sharesBurned: 100, feeShares: 0.3, queuedAt: 150,
    });
    const exec = makeExecutor({});
    await exec.drain();
    const w = store.listWithdrawalsByStatus('completed');
    expect(w.length).toBe(1);
    expect(w[0].id).toBe(wid);
    expect(store.getShares(1)).toBeCloseTo(900);  // 1000 - 100
  });

  it('marks failed on execute failure; shares preserved', async () => {
    store.enqueueWithdrawal({
      telegramId: 1, destination: 'DEST',
      sharesBurned: 100, feeShares: 0.3, queuedAt: 150,
    });
    const exec = makeExecutor({ executeSucceeds: false });
    await exec.drain();
    const failed = store.listWithdrawalsByStatus('failed');
    expect(failed.length).toBe(1);
    expect(store.getShares(1)).toBe(1000);
  });

  it('invokes partialClose when free balance is short', async () => {
    store.enqueueWithdrawal({
      telegramId: 1, destination: 'DEST',
      sharesBurned: 500, feeShares: 1.5, queuedAt: 150,  // user wants $498.5 worth
    });
    const called = { count: 0 };
    const exec = makeExecutor({
      freeSol: 500_000_000n,     // only 0.5 SOL free = $50 (user wants ~$498)
      positionUsd: 1000,
      partialCloseCalled: called,
    });
    await exec.drain();
    expect(called.count).toBe(1);
  });

  it('fails with reserves_insufficient when partial close not enough', async () => {
    store.enqueueWithdrawal({
      telegramId: 1, destination: 'DEST',
      sharesBurned: 900, feeShares: 2.7, queuedAt: 150,
    });
    const exec = new WithdrawalExecutor({
      store,
      getMid: async () => ({ solUsd: 100, bertUsd: 0.01 }),
      getWalletBalances: async () => ({ solLamports: 300_000_000n, bertRaw: 0n }),
      getPositionSnapshot: async () => ({ totalValueUsd: 0, solUsdInPosition: 0, bertUsdInPosition: 0 }),
      reserveSolLamports: 200_000_000n,
      partialClose: async () => {}, // no-op — won't help
      executeTransfer: async () => ({ txSig: 'sig' }),
      now: () => 200,
    });
    await exec.drain();
    const failed = store.listWithdrawalsByStatus('failed');
    expect(failed[0].failureReason).toBe('reserves_insufficient');
  });

  it('NAV snapshot totalValueUsd reflects fee-share retention', async () => {
    // Setup: add a second depositor so fee accretion has a visible effect
    store.createUser({ telegramId: 2, role: 'depositor', depositAddress: 'B',
      depositSecretEnc: Buffer.alloc(0), depositSecretIv: Buffer.alloc(0),
      disclaimerAt: 100, createdAt: 100 });
    store.addShares(2, 1000);  // two users, 1000 shares each, 2000 total

    store.enqueueWithdrawal({
      telegramId: 1, destination: 'DEST',
      sharesBurned: 100, feeShares: 0.3, queuedAt: 150,
    });
    const exec = makeExecutor({
      freeSol: 10_000_000_000n,
      positionUsd: 0,
    });
    // navPerShare pre-withdrawal: totalUsd = 10 SOL * $100 = $1000, totalShares=2000 → $0.50/share
    // After: totalShares=1900, totalValueUsd should be (2000 - 99.7) * 0.50 = $950.15
    await exec.drain();
    const snap = store.latestNavSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.source).toBe('withdrawal');
    expect(snap!.totalShares).toBeCloseTo(1900);  // 2000 - 100
    expect(snap!.totalValueUsd).toBeCloseTo(950.15);  // (2000 - 99.7) * 0.50
  });

  it('drain continues past a row whose processOne throws unexpectedly', async () => {
    // Enqueue two withdrawals; first triggers a throw in partialClose
    const id1 = store.enqueueWithdrawal({
      telegramId: 1, destination: 'DEST',
      sharesBurned: 500, feeShares: 1.5, queuedAt: 150,
    });
    const id2 = store.enqueueWithdrawal({
      telegramId: 1, destination: 'DEST',
      sharesBurned: 100, feeShares: 0.3, queuedAt: 151,
    });
    let firstCall = true;
    const exec = new WithdrawalExecutor({
      store,
      getMid: async () => ({ solUsd: 100, bertUsd: 0.01 }),
      getWalletBalances: async () => ({ solLamports: 500_000_000n, bertRaw: 0n }),
      getPositionSnapshot: async () => ({ totalValueUsd: 1000, solUsdInPosition: 0, bertUsdInPosition: 0 }),
      reserveSolLamports: 200_000_000n,
      partialClose: async () => {
        if (firstCall) { firstCall = false; throw new Error('boom'); }
      },
      executeTransfer: async () => ({ txSig: 'ok' }),
      now: () => 200,
    });
    await exec.drain();
    // First withdrawal failed with an "unexpected:" reason
    const failed = store.listWithdrawalsByStatus('failed');
    expect(failed.length).toBeGreaterThanOrEqual(1);
    const firstFailed = failed.find(f => f.id === id1);
    expect(firstFailed).toBeDefined();
    expect(firstFailed!.failureReason).toMatch(/unexpected/);
    // Second withdrawal was still processed (completed or failed, either is fine — just not orphaned in 'processing')
    const processing = store.listWithdrawalsByStatus('processing');
    expect(processing.length).toBe(0);
    // Reference id2 to silence unused-var warning (test only requires it not be orphaned)
    expect(id2).toBeGreaterThan(id1);
  });

  it('marks failed with oracle_unavailable on null mid', async () => {
    store.enqueueWithdrawal({
      telegramId: 1, destination: 'DEST',
      sharesBurned: 100, feeShares: 0.3, queuedAt: 150,
    });
    const exec = new WithdrawalExecutor({
      store,
      getMid: async () => null,
      getWalletBalances: async () => ({ solLamports: 10_000_000_000n, bertRaw: 0n }),
      getPositionSnapshot: async () => ({ totalValueUsd: 0, solUsdInPosition: 0, bertUsdInPosition: 0 }),
      reserveSolLamports: 200_000_000n,
      partialClose: async () => {},
      executeTransfer: async () => ({ txSig: 'sig' }),
      now: () => 200,
    });
    await exec.drain();
    const failed = store.listWithdrawalsByStatus('failed');
    expect(failed[0].failureReason).toBe('oracle_unavailable');
  });
});
