import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateStore } from '../../src/stateStore.js';
import { DepositorStore } from '../../src/vault/depositorStore.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('DepositorStore', () => {
  let dir: string;
  let state: StateStore;
  let store: DepositorStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bertmm-'));
    state = new StateStore(join(dir, 'state.db'));
    state.init();
    store = new DepositorStore(state);
  });
  afterEach(() => { state.close(); rmSync(dir, { recursive: true, force: true }); });

  it('creates and retrieves a user', () => {
    store.createUser({
      telegramId: 1, role: 'depositor', depositAddress: 'AddrA',
      depositSecretEnc: Buffer.from([1,2]), depositSecretIv: Buffer.from([3,4]),
      disclaimerAt: 100, createdAt: 100,
    });
    const u = store.getUser(1);
    expect(u).toBeTruthy();
    expect(u!.depositAddress).toBe('AddrA');
    expect(u!.role).toBe('depositor');
  });

  it('enforces UNIQUE on deposit_address', () => {
    store.createUser({ telegramId: 1, role: 'depositor', depositAddress: 'A',
      depositSecretEnc: Buffer.alloc(0), depositSecretIv: Buffer.alloc(0),
      disclaimerAt: 100, createdAt: 100 });
    expect(() => store.createUser({ telegramId: 2, role: 'depositor', depositAddress: 'A',
      depositSecretEnc: Buffer.alloc(0), depositSecretIv: Buffer.alloc(0),
      disclaimerAt: 100, createdAt: 100 })).toThrow(/UNIQUE/);
  });

  it('credits deposit and mints shares atomically', () => {
    store.createUser({ telegramId: 1, role: 'depositor', depositAddress: 'A',
      depositSecretEnc: Buffer.alloc(0), depositSecretIv: Buffer.alloc(0),
      disclaimerAt: 100, createdAt: 100 });
    store.creditDeposit({
      telegramId: 1, inboundTxSig: 'sig1', sweepTxSig: 'swp1',
      solLamports: 1_000_000_000n, bertRaw: 0n,
      solUsd: 100, bertUsd: 0.01, navPerShareAt: 1, sharesMinted: 100,
      confirmedAt: 100, sweptAt: 101,
    });
    expect(store.getShares(1)).toBe(100);
    expect(store.listDepositsForUser(1).length).toBe(1);
  });

  it('rejects duplicate inbound_tx_sig', () => {
    store.createUser({ telegramId: 1, role: 'depositor', depositAddress: 'A',
      depositSecretEnc: Buffer.alloc(0), depositSecretIv: Buffer.alloc(0),
      disclaimerAt: 100, createdAt: 100 });
    const p = {
      telegramId: 1, inboundTxSig: 'sig1', sweepTxSig: 's',
      solLamports: 0n, bertRaw: 0n, solUsd: 0, bertUsd: 0,
      navPerShareAt: 1, sharesMinted: 1, confirmedAt: 100, sweptAt: 101,
    };
    store.creditDeposit(p);
    expect(() => store.creditDeposit(p)).toThrow(/UNIQUE/);
  });

  it('burns shares on completed withdrawal', () => {
    store.createUser({ telegramId: 1, role: 'depositor', depositAddress: 'A',
      depositSecretEnc: Buffer.alloc(0), depositSecretIv: Buffer.alloc(0),
      disclaimerAt: 100, createdAt: 100 });
    store.creditDeposit({ telegramId: 1, inboundTxSig: 's1', sweepTxSig: 'w',
      solLamports: 0n, bertRaw: 0n, solUsd: 0, bertUsd: 0,
      navPerShareAt: 1, sharesMinted: 100, confirmedAt: 100, sweptAt: 101 });

    const wid = store.enqueueWithdrawal({
      telegramId: 1, destination: 'destAddr',
      sharesBurned: 10, feeShares: 0.03, queuedAt: 200,
    });
    store.completeWithdrawal({
      id: wid, txSig: 'outsig', solLamportsOut: 500_000_000n, bertRawOut: 0n,
      navPerShareAt: 1, processedAt: 210,
    });
    expect(store.getShares(1)).toBe(90);
    const w = store.listWithdrawalsByStatus('completed');
    expect(w.length).toBe(1);
    expect(w[0].txSig).toBe('outsig');
  });

  it('does not burn shares on failed withdrawal', () => {
    store.createUser({ telegramId: 1, role: 'depositor', depositAddress: 'A',
      depositSecretEnc: Buffer.alloc(0), depositSecretIv: Buffer.alloc(0),
      disclaimerAt: 100, createdAt: 100 });
    store.creditDeposit({ telegramId: 1, inboundTxSig: 's1', sweepTxSig: 'w',
      solLamports: 0n, bertRaw: 0n, solUsd: 0, bertUsd: 0,
      navPerShareAt: 1, sharesMinted: 100, confirmedAt: 100, sweptAt: 101 });
    const wid = store.enqueueWithdrawal({
      telegramId: 1, destination: 'destAddr',
      sharesBurned: 10, feeShares: 0.03, queuedAt: 200,
    });
    store.failWithdrawal({ id: wid, reason: 'oracle_unavailable', processedAt: 210 });
    expect(store.getShares(1)).toBe(100);
  });

  it('sums daily withdrawal USD per user (24h window)', () => {
    store.createUser({ telegramId: 1, role: 'depositor', depositAddress: 'A',
      depositSecretEnc: Buffer.alloc(0), depositSecretIv: Buffer.alloc(0),
      disclaimerAt: 100, createdAt: 100 });
    store.creditDeposit({ telegramId: 1, inboundTxSig: 's1', sweepTxSig: 'w',
      solLamports: 0n, bertRaw: 0n, solUsd: 0, bertUsd: 0,
      navPerShareAt: 1, sharesMinted: 1000, confirmedAt: 100, sweptAt: 101 });

    const now = 1_700_000_000_000;
    const w1 = store.enqueueWithdrawal({ telegramId: 1, destination: 'd',
      sharesBurned: 100, feeShares: 0.3, queuedAt: now - 3_600_000 });
    store.completeWithdrawal({ id: w1, txSig: 't', solLamportsOut: 0n, bertRawOut: 0n,
      navPerShareAt: 1, processedAt: now - 3_500_000 });
    const sum = store.sumCompletedWithdrawalUsdLast24h(1, now);
    expect(sum).toBeCloseTo(99.7);  // 100 - 0.3 fee
  });

  it('audit log: writes + reads', () => {
    store.writeAudit({ ts: 100, telegramId: 1, event: 'totp_enrolled', detailsJson: '{}' });
    const rows = store.listAudit({ sinceTs: 0, limit: 10 });
    expect(rows.length).toBe(1);
    expect(rows[0].event).toBe('totp_enrolled');
  });
});
