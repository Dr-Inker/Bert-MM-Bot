import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { StateStore } from '../../src/stateStore.js';
import { DepositorStore } from '../../src/vault/depositorStore.js';
import { CreditEngine } from '../../src/vault/creditEngine.js';
import { Cooldowns } from '../../src/vault/cooldowns.js';
import { DepositPipeline } from '../../src/vault/depositPipeline.js';
import type { InflowEvent } from '../../src/vault/depositWatcher.js';
import { encrypt } from '../../src/vault/encryption.js';
import { VAULT_PAUSED_FLAG, isVaultPaused } from '../../src/vault/flags.js';
import { runVaultTick, type VaultTickDeps } from '../../src/vault/tick.js';

const TEST_MINT = new PublicKey('HgBRWfYxEfvPhtqkaeymCQtHCrKE46qQ43pKe8HCpump');
// 32-byte master key for AES-GCM
const MASTER_KEY = Buffer.alloc(32, 7);

function silentLog(): any {
  return {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {},
    fatal: () => {}, child: () => silentLog(),
  };
}

describe('DepositPipeline.onInflow', () => {
  let dir: string;
  let state: StateStore;
  let store: DepositorStore;
  let creditEngine: CreditEngine;
  let payer: Keypair;
  let depositKp: Keypair;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bertmm-tick-'));
    state = new StateStore(join(dir, 'state.db'));
    state.init();
    store = new DepositorStore(state);
    creditEngine = new CreditEngine({ store });
    payer = Keypair.generate();
    depositKp = Keypair.generate();
    // Seed a user with the deposit keypair encrypted under MASTER_KEY.
    const enc = encrypt(Buffer.from(depositKp.secretKey), MASTER_KEY);
    store.createUser({
      telegramId: 42,
      role: 'depositor',
      depositAddress: depositKp.publicKey.toBase58(),
      depositSecretEnc: enc.ciphertext,
      depositSecretIv: enc.iv,
      disclaimerAt: 100,
      createdAt: 100,
    });
  });

  afterEach(() => { state.close(); rmSync(dir, { recursive: true, force: true }); });

  function makePipeline(opts: {
    submitTx?: (tx: Transaction, signers: Keypair[]) => Promise<string>;
    getMid?: () => Promise<{ solUsd: number; bertUsd: number } | null>;
  } = {}): DepositPipeline {
    const connection = {
      getLatestBlockhash: async () => ({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1 }),
    } as any;
    return new DepositPipeline({
      store,
      connection,
      payerKeypair: payer,
      bertMint: TEST_MINT,
      masterKey: MASTER_KEY,
      creditEngine,
      getMid: opts.getMid ?? (async () => ({ solUsd: 100, bertUsd: 0.01 })),
      getNavPerShare: async () => 1,
      rentReserveLamports: 2_000_000n,
      now: () => 200,
      log: silentLog(),
      submitTx: opts.submitTx ?? (async () => 'SWEEP_SIG_1'),
    });
  }

  it('credits shares on successful sweep + oracle available', async () => {
    const sweepCalls: Array<{ signers: number }> = [];
    const pipe = makePipeline({
      submitTx: async (_tx, signers) => { sweepCalls.push({ signers: signers.length }); return 'SWEEP_OK'; },
    });

    const event: InflowEvent = {
      depositAddress: depositKp.publicKey.toBase58(),
      inboundTxSig: 'INBOUND_1',
      solLamports: 1_000_000_000n,
      bertRaw: 0n,
      confirmedAt: 150,
    };
    await pipe.onInflow(event);

    expect(sweepCalls).toHaveLength(1);
    expect(sweepCalls[0].signers).toBe(1); // deposit keypair co-signs
    // $100 deposit / NAV=1 -> 100 shares
    expect(store.getShares(42)).toBeCloseTo(100);
    const deposits = store.listDepositsForUser(42);
    expect(deposits).toHaveLength(1);
    expect(deposits[0].inboundTxSig).toBe('INBOUND_1');
    expect(deposits[0].sweepTxSig).toBe('SWEEP_OK');
    // Audit: deposit_detected + deposit_swept + deposit_credited
    const audit = store.listRecentAuditEvents(10).map(e => e.event);
    expect(audit).toContain('deposit_detected');
    expect(audit).toContain('deposit_swept');
    expect(audit).toContain('deposit_credited');
  });

  it('writes deposit_sweep_failed audit on submit failure and does NOT credit', async () => {
    const pipe = makePipeline({
      submitTx: async () => { throw new Error('simulated-rpc-fail'); },
    });
    const event: InflowEvent = {
      depositAddress: depositKp.publicKey.toBase58(),
      inboundTxSig: 'INBOUND_2',
      solLamports: 1_000_000_000n, bertRaw: 0n,
      confirmedAt: 150,
    };
    await pipe.onInflow(event);
    expect(store.getShares(42)).toBe(0);
    expect(store.listDepositsForUser(42)).toHaveLength(0);
    const audit = store.listRecentAuditEvents(10).map(e => e.event);
    expect(audit).toContain('deposit_detected');
    expect(audit).toContain('deposit_sweep_failed');
    expect(audit).not.toContain('deposit_credited');
  });

  it('N2: oracle preflight — defers sweep when oracle is null, does not sweep', async () => {
    let sweepCalled = false;
    const pipe = makePipeline({
      getMid: async () => null,
      submitTx: async () => { sweepCalled = true; return 'WOULD_NOT_HAPPEN'; },
    });
    const event: InflowEvent = {
      depositAddress: depositKp.publicKey.toBase58(),
      inboundTxSig: 'INBOUND_3',
      solLamports: 1_000_000_000n, bertRaw: 0n,
      confirmedAt: 150,
    };
    await pipe.onInflow(event);
    expect(sweepCalled).toBe(false);
    expect(store.getShares(42)).toBe(0);

    const audit = store.listRecentAuditEvents(10);
    // deposit_detected is still written (durable record)
    expect(audit.some((e) => e.event === 'deposit_detected')).toBe(true);
    // new defer event fires
    expect(audit.some((e) => e.event === 'deposit_deferred_oracle_unavailable')).toBe(true);
    // sweep did NOT happen → no deposit_swept
    expect(audit.some((e) => e.event === 'deposit_swept')).toBe(false);
    // and no legacy oracle_unavailable_after_sweep reason
    expect(audit.some((e) => e.event === 'deposit_sweep_failed')).toBe(false);
  });

  it('unknown deposit address: logs warning, no-op, no audit rows touched', async () => {
    const pipe = makePipeline();
    const stray = Keypair.generate();
    const event: InflowEvent = {
      depositAddress: stray.publicKey.toBase58(),
      inboundTxSig: 'INBOUND_X',
      solLamports: 500n, bertRaw: 0n,
      confirmedAt: 1,
    };
    await pipe.onInflow(event);
    // No audit activity written for unknown addr
    const audit = store.listRecentAuditEvents(10);
    expect(audit).toHaveLength(0);
  });
});

describe('isVaultPaused helper', () => {
  let dir: string; let state: StateStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bertmm-flags-'));
    state = new StateStore(join(dir, 'state.db'));
    state.init();
  });
  afterEach(() => { state.close(); rmSync(dir, { recursive: true, force: true }); });

  it('returns false when flag missing', () => {
    expect(isVaultPaused(k => state.getFlag(k))).toBe(false);
  });
  it('returns true when flag=1', () => {
    state.setFlag(VAULT_PAUSED_FLAG, '1');
    expect(isVaultPaused(k => state.getFlag(k))).toBe(true);
  });
  it('returns false when flag cleared to empty string', () => {
    state.setFlag(VAULT_PAUSED_FLAG, '1');
    state.setFlag(VAULT_PAUSED_FLAG, '');
    expect(isVaultPaused(k => state.getFlag(k))).toBe(false);
  });
});

describe('runVaultTick — ordering + skip conditions', () => {
  let dir: string; let state: StateStore; let store: DepositorStore;
  let depositKp: Keypair;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bertmm-runtick-'));
    state = new StateStore(join(dir, 'state.db'));
    state.init();
    store = new DepositorStore(state);
    depositKp = Keypair.generate();
    const enc = encrypt(Buffer.from(depositKp.secretKey), MASTER_KEY);
    store.createUser({
      telegramId: 9,
      role: 'depositor',
      depositAddress: depositKp.publicKey.toBase58(),
      depositSecretEnc: enc.ciphertext, depositSecretIv: enc.iv,
      disclaimerAt: 1, createdAt: 1,
    });
  });
  afterEach(() => { state.close(); rmSync(dir, { recursive: true, force: true }); });

  function makeDeps(overrides: Partial<VaultTickDeps> = {}): {
    deps: VaultTickDeps; calls: string[];
  } {
    const calls: string[] = [];
    const deps: VaultTickDeps = {
      store,
      state,
      isDegraded: () => false,
      isKilled: () => false,
      pollAddress: async (addr) => { calls.push(`poll:${addr.slice(0,6)}`); },
      drain: async () => { calls.push('drain'); },
      activateDue: (args) => { calls.push(`activate:${args.now}`); return []; },
      now: () => 1000,
      log: silentLog(),
      ...overrides,
    };
    return { deps, calls };
  }

  it('ordering: deposit-poll runs before drain, drain runs before activateDue', async () => {
    const { deps, calls } = makeDeps();
    await runVaultTick(deps);
    const pollIdx = calls.findIndex(s => s.startsWith('poll:'));
    const drainIdx = calls.indexOf('drain');
    const actIdx = calls.findIndex(s => s.startsWith('activate:'));
    expect(pollIdx).toBeGreaterThanOrEqual(0);
    expect(drainIdx).toBeGreaterThan(pollIdx);
    expect(actIdx).toBeGreaterThan(drainIdx);
  });

  it('skips drain when kill switch tripped, still polls + activates', async () => {
    const { deps, calls } = makeDeps({ isKilled: () => true });
    await runVaultTick(deps);
    expect(calls.some(c => c.startsWith('poll:'))).toBe(true);
    expect(calls).not.toContain('drain');
    expect(calls.some(c => c.startsWith('activate:'))).toBe(true);
  });

  it('skips drain when degraded, still polls + activates', async () => {
    const { deps, calls } = makeDeps({ isDegraded: () => true });
    await runVaultTick(deps);
    expect(calls).not.toContain('drain');
    expect(calls.some(c => c.startsWith('poll:'))).toBe(true);
    expect(calls.some(c => c.startsWith('activate:'))).toBe(true);
  });

  it('skips drain when vault paused, still polls + activates', async () => {
    state.setFlag(VAULT_PAUSED_FLAG, '1');
    const { deps, calls } = makeDeps();
    await runVaultTick(deps);
    expect(calls).not.toContain('drain');
    expect(calls.some(c => c.startsWith('poll:'))).toBe(true);
    expect(calls.some(c => c.startsWith('activate:'))).toBe(true);
  });

  it('catches pollAddress errors, continues to drain + activate', async () => {
    const { deps, calls } = makeDeps({
      pollAddress: async () => { throw new Error('rpc-down'); },
    });
    await runVaultTick(deps);
    expect(calls).toContain('drain');
    expect(calls.some(c => c.startsWith('activate:'))).toBe(true);
  });

  it('catches drain errors, continues to activate', async () => {
    const { deps, calls } = makeDeps({
      drain: async () => { throw new Error('boom'); },
    });
    await runVaultTick(deps);
    expect(calls.some(c => c.startsWith('activate:'))).toBe(true);
  });

  it('catches activateDue errors — does not throw out of the tick', async () => {
    const { deps } = makeDeps({
      activateDue: () => { throw new Error('bad'); },
    });
    await expect(runVaultTick(deps)).resolves.toBeUndefined();
  });

  it('writes whitelist_activated audit when cooldowns.activateDue returns rows', async () => {
    // Seed a due whitelist change so the real Cooldowns would flip it
    store.enqueueWhitelistChange({
      telegramId: 9,
      oldAddress: null,
      newAddress: 'newAddr',
      requestedAt: 100, activatesAt: 100, initialStatus: 'pending',
    });
    const cooldowns = new Cooldowns({ store, cooldownMs: 0 });
    const { deps } = makeDeps({
      activateDue: (args) => cooldowns.activateDue(args),
      now: () => 200,
    });
    await runVaultTick(deps);
    const audit = store.listRecentAuditEvents(10).map(e => e.event);
    expect(audit).toContain('whitelist_activated');
  });
});
