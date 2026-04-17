import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateStore } from '../../src/stateStore.js';
import { DepositorStore } from '../../src/vault/depositorStore.js';
import { Enrollment } from '../../src/vault/enrollment.js';
import { Cooldowns } from '../../src/vault/cooldowns.js';
import { CreditEngine } from '../../src/vault/creditEngine.js';
import { WithdrawalExecutor } from '../../src/vault/withdrawalExecutor.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('vault integration — deposit -> shares -> withdraw -> share burn', () => {
  let dir: string;
  let state: StateStore;
  let store: DepositorStore;
  const masterKey = Buffer.alloc(32, 7);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bertmm-'));
    state = new StateStore(join(dir, 'state.db'));
    state.init();
    store = new DepositorStore(state);
  });
  afterEach(() => {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('full happy path preserves share invariants', async () => {
    // 1. Bootstrap operator (telegramId=1) with 220 synthetic bootstrap shares.
    const enrollment = new Enrollment({ store, masterKey, ensureAta: async () => {} });
    await enrollment.accept({ telegramId: 1, now: 100 });
    store.addShares(1, 220);

    // 2. Depositor (telegramId=2) enrolls + whitelists destination address.
    await enrollment.accept({ telegramId: 2, now: 200 });
    store.setWhitelistImmediate({ telegramId: 2, address: 'DESTINATION', ts: 200 });

    // 3. Depositor deposits $100 at NAV=$1 -> 100 shares minted.
    const ce = new CreditEngine({ store });
    ce.credit({
      telegramId: 2,
      inboundTxSig: 'in1',
      sweepTxSig: 'sw1',
      solLamports: 1_000_000_000n, // 1 SOL at $100 = $100
      bertRaw: 0n,
      solUsd: 100,
      bertUsd: 0.01,
      navPerShareAtDeposit: 1,
      confirmedAt: 300,
      sweptAt: 301,
      now: 302,
    });
    expect(store.getShares(2)).toBeCloseTo(100);

    // 4. Depositor queues a withdrawal of 50 shares (fee=0.15 shares).
    const wid = store.enqueueWithdrawal({
      telegramId: 2,
      destination: 'DESTINATION',
      sharesBurned: 50,
      feeShares: 0.15,
      queuedAt: 400,
    });

    // Drain the queue with a stubbed venue/transfer layer.
    // Wallet has 3.2 SOL = $320; totalShares=320 -> navPerShare=$1.00 exactly,
    // which matches the NAV at deposit so invariants stay clean.
    const executor = new WithdrawalExecutor({
      store,
      getMid: async () => ({ solUsd: 100, bertUsd: 0.01 }),
      getWalletBalances: async () => ({ solLamports: 3_200_000_000n, bertRaw: 0n }),
      getPositionSnapshot: async () => ({
        totalValueUsd: 0,
        solUsdInPosition: 0,
        bertUsdInPosition: 0,
      }),
      reserveSolLamports: 200_000_000n,
      partialClose: async () => {},
      executeTransfer: async () => ({ txSig: 'out1' }),
      now: () => 500,
    });
    await executor.drain();

    // Sanity: the specific withdrawal we queued is now completed.
    const completed = store.listWithdrawalsByStatus('completed');
    expect(completed.length).toBe(1);
    expect(completed[0].id).toBe(wid);
    expect(completed[0].txSig).toBe('out1');

    // 5. Invariants.
    expect(store.getShares(2)).toBeCloseTo(50); // 100 - 50

    const totalMinted =
      store.listDepositsForUser(2).reduce((s, d) => s + d.sharesMinted, 0) + 220; // + bootstrap
    const totalBurned = store
      .listWithdrawalsByStatus('completed')
      .reduce((s, w) => s + w.sharesBurned, 0);
    expect(totalMinted - totalBurned).toBeCloseTo(store.totalShares());

    // Extra: NAV snapshot sequence ends with a 'withdrawal' source row.
    const navSnap = store.latestNavSnapshot();
    expect(navSnap).not.toBeNull();
    expect(navSnap!.source).toBe('withdrawal');
  });

  it('whitelist cooldown: change -> wait -> activate flows end-to-end', async () => {
    const enrollment = new Enrollment({ store, masterKey, ensureAta: async () => {} });
    await enrollment.accept({ telegramId: 7, now: 1000 });

    const cooldowns = new Cooldowns({ store, cooldownMs: 24 * 3600 * 1000 });

    // First set is immediate (no prior whitelist).
    const first = cooldowns.requestChange({
      telegramId: 7,
      newAddress: 'ADDR_ONE',
      now: 2000,
    });
    expect(first.immediate).toBe(true);
    expect(store.getUser(7)!.whitelistAddress).toBe('ADDR_ONE');

    // Second change must wait the cooldown.
    const second = cooldowns.requestChange({
      telegramId: 7,
      newAddress: 'ADDR_TWO',
      now: 3000,
    });
    expect(second.immediate).toBe(false);
    expect(second.activatesAt).toBe(3000 + 24 * 3600 * 1000);

    // Before the cooldown elapses, activateDue is a no-op.
    let activated = cooldowns.activateDue({ now: 3000 + 1000 });
    expect(activated.length).toBe(0);
    expect(store.getUser(7)!.whitelistAddress).toBe('ADDR_ONE');

    // Once the cooldown passes, the pending change activates and the user's
    // whitelist flips to the new address.
    activated = cooldowns.activateDue({ now: 3000 + 24 * 3600 * 1000 + 1 });
    expect(activated.length).toBe(1);
    expect(activated[0].newAddress).toBe('ADDR_TWO');
    expect(store.getUser(7)!.whitelistAddress).toBe('ADDR_TWO');

    // Pending count is now zero (activated row is no longer 'pending').
    expect(store.countPendingWhitelistChanges()).toBe(0);
  });
});
