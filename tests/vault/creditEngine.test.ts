import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateStore } from '../../src/stateStore.js';
import { DepositorStore } from '../../src/vault/depositorStore.js';
import { CreditEngine } from '../../src/vault/creditEngine.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('CreditEngine', () => {
  let dir: string;
  let state: StateStore;
  let store: DepositorStore;
  let ce: CreditEngine;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bertmm-'));
    state = new StateStore(join(dir, 'state.db'));
    state.init();
    store = new DepositorStore(state);
    ce = new CreditEngine({ store });
    store.createUser({ telegramId: 1, role: 'depositor', depositAddress: 'A',
      depositSecretEnc: Buffer.alloc(0), depositSecretIv: Buffer.alloc(0),
      disclaimerAt: 100, createdAt: 100 });
  });
  afterEach(() => { state.close(); rmSync(dir, { recursive: true, force: true }); });

  it('bootstrap-sized deposit gets shares equal to USD at NAV=$1', () => {
    ce.credit({
      telegramId: 1, inboundTxSig: 's1', sweepTxSig: 'w1',
      solLamports: 1_000_000_000n, bertRaw: 0n,
      solUsd: 100, bertUsd: 0.01,
      navPerShareAtDeposit: 1,
      confirmedAt: 100, sweptAt: 101, now: 101,
    });
    expect(store.getShares(1)).toBeCloseTo(100);
  });

  it('uses provided NAV to scale shares', () => {
    ce.credit({
      telegramId: 1, inboundTxSig: 's2', sweepTxSig: 'w',
      solLamports: 2_000_000_000n, bertRaw: 0n,
      solUsd: 100, bertUsd: 0.01,
      navPerShareAtDeposit: 2,
      confirmedAt: 100, sweptAt: 101, now: 101,
    });
    expect(store.getShares(1)).toBeCloseTo(100);  // $200 / $2
  });

  it('writes a NAV snapshot with source=deposit', () => {
    ce.credit({
      telegramId: 1, inboundTxSig: 's3', sweepTxSig: 'w',
      solLamports: 1_000_000_000n, bertRaw: 0n,
      solUsd: 100, bertUsd: 0.01,
      navPerShareAtDeposit: 1,
      confirmedAt: 100, sweptAt: 101, now: 101,
    });
    const snap = store.latestNavSnapshot();
    expect(snap!.source).toBe('deposit');
  });

  it('refuses to credit already-credited sig (no-op return)', () => {
    ce.credit({
      telegramId: 1, inboundTxSig: 'dup', sweepTxSig: 'w',
      solLamports: 1_000_000_000n, bertRaw: 0n,
      solUsd: 100, bertUsd: 0.01,
      navPerShareAtDeposit: 1,
      confirmedAt: 100, sweptAt: 101, now: 101,
    });
    expect(() => ce.credit({
      telegramId: 1, inboundTxSig: 'dup', sweepTxSig: 'w',
      solLamports: 1_000_000_000n, bertRaw: 0n,
      solUsd: 100, bertUsd: 0.01,
      navPerShareAtDeposit: 1,
      confirmedAt: 100, sweptAt: 101, now: 101,
    })).toThrow(/UNIQUE/);
  });
});
