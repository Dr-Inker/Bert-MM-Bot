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
