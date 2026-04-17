import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StateStore } from '../../src/stateStore.js';
import { DepositorStore } from '../../src/vault/depositorStore.js';
import { AuditLog } from '../../src/vault/audit.js';
import { OperatorCommandHandlers } from '../../src/vault/operatorCommands.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Harness {
  dir: string;
  state: StateStore;
  store: DepositorStore;
  audit: AuditLog;
  reply: ReturnType<typeof vi.fn>;
  handlers: OperatorCommandHandlers;
  nowRef: { current: number };
}

function buildHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'bertmm-opcmd-'));
  const state = new StateStore(join(dir, 'state.db'));
  state.init();
  const store = new DepositorStore(state);
  const audit = new AuditLog(store);
  const reply = vi.fn(async () => {});
  const nowRef = { current: 1_700_000_000_000 };
  const handlers = new OperatorCommandHandlers({
    store,
    state,
    audit,
    reply,
    nowMs: () => nowRef.current,
  });
  return { dir, state, store, audit, reply, handlers, nowRef };
}

function seedUser(store: DepositorStore, telegramId: number, addr = `Addr${telegramId}`): void {
  store.createUser({
    telegramId,
    role: 'depositor',
    depositAddress: addr,
    depositSecretEnc: Buffer.alloc(0),
    depositSecretIv: Buffer.alloc(0),
    disclaimerAt: 100,
    createdAt: 100,
  });
}

describe('OperatorCommandHandlers — /pausevault', () => {
  let h: Harness;
  beforeEach(() => { h = buildHarness(); });
  afterEach(() => { h.state.close(); rmSync(h.dir, { recursive: true, force: true }); });

  it('sets vault_paused=1 flag and replies with confirmation', async () => {
    await h.handlers.handlePause({ chatId: 99, userId: 99 });
    expect(h.state.getFlag('vault_paused')).toBe('1');
    expect(h.reply).toHaveBeenCalledTimes(1);
    const [chatId, text] = h.reply.mock.calls[0];
    expect(chatId).toBe(99);
    expect(text).toMatch(/paused/i);
    expect(text).toMatch(/resumevault/i);
  });

  it('writes a vault_paused audit event', async () => {
    await h.handlers.handlePause({ chatId: 99, userId: 99 });
    const events = h.store.listRecentAuditEvents(5);
    expect(events.some((e) => e.event === 'vault_paused')).toBe(true);
    const row = events.find((e) => e.event === 'vault_paused')!;
    expect(row.telegramId).toBe(99);
  });

  it('is idempotent — calling /pausevault twice keeps the flag set', async () => {
    await h.handlers.handlePause({ chatId: 99, userId: 99 });
    await h.handlers.handlePause({ chatId: 99, userId: 99 });
    expect(h.state.getFlag('vault_paused')).toBe('1');
  });
});

describe('OperatorCommandHandlers — /resumevault', () => {
  let h: Harness;
  beforeEach(() => { h = buildHarness(); });
  afterEach(() => { h.state.close(); rmSync(h.dir, { recursive: true, force: true }); });

  it('clears vault_paused flag and replies', async () => {
    h.state.setFlag('vault_paused', '1');
    await h.handlers.handleResume({ chatId: 99, userId: 99 });
    // Either cleared to empty string or undefined — operational semantics identical.
    const v = h.state.getFlag('vault_paused');
    expect(v === undefined || v === '').toBe(true);
    expect(h.reply).toHaveBeenCalledTimes(1);
    const [, text] = h.reply.mock.calls[0];
    expect(text).toMatch(/resumed/i);
  });

  it('writes a vault_resumed audit event', async () => {
    await h.handlers.handleResume({ chatId: 99, userId: 99 });
    const events = h.store.listRecentAuditEvents(5);
    expect(events.some((e) => e.event === 'vault_resumed')).toBe(true);
  });
});

describe('OperatorCommandHandlers — /vaultstatus', () => {
  let h: Harness;
  beforeEach(() => { h = buildHarness(); });
  afterEach(() => { h.state.close(); rmSync(h.dir, { recursive: true, force: true }); });

  it('reports TVL, shares, queued count, pending whitelist count, and last NAV', async () => {
    seedUser(h.store, 1);
    h.store.addShares(1, 50);
    h.store.insertNavSnapshot({
      ts: h.nowRef.current - 1000,
      totalValueUsd: 12_345.67,
      totalShares: 50,
      navPerShare: 246.9134,
      source: 'hourly',
    });
    // Queue a withdrawal
    h.store.enqueueWithdrawal({
      telegramId: 1,
      destination: 'Dest1',
      sharesBurned: 5,
      feeShares: 0.015,
      queuedAt: h.nowRef.current - 500,
    });
    // Pending whitelist change
    h.store.enqueueWhitelistChange({
      telegramId: 1,
      oldAddress: null,
      newAddress: 'NewAddr',
      requestedAt: h.nowRef.current - 2000,
      activatesAt: h.nowRef.current + 86_400_000,
      initialStatus: 'pending',
    });
    // A couple of audit events to show in "last 5"
    h.audit.write({ ts: h.nowRef.current - 10, telegramId: 1, event: 'deposit_reveal' });
    h.audit.write({ ts: h.nowRef.current - 5, telegramId: 1, event: 'balance_reveal' });

    await h.handlers.handleStatus({ chatId: 99, userId: 99 });

    expect(h.reply).toHaveBeenCalledTimes(1);
    const [, text] = h.reply.mock.calls[0];
    // TVL
    expect(text).toMatch(/12[,.]?345/);
    // total shares
    expect(text).toMatch(/50/);
    // queued count = 1
    expect(text).toMatch(/[Qq]ueued.*1|1.*queued/);
    // pending whitelist count = 1
    expect(text).toMatch(/[Ww]hitelist.*1|1.*whitelist/);
    // NAV/share line
    expect(text).toMatch(/246/);
    // audit event names appear in "last N"
    expect(text).toMatch(/deposit_reveal|balance_reveal/);
  });

  it('handles empty vault gracefully (no NAV snapshot, no rows)', async () => {
    await h.handlers.handleStatus({ chatId: 99, userId: 99 });
    expect(h.reply).toHaveBeenCalledTimes(1);
    const [, text] = h.reply.mock.calls[0];
    // Shouldn't throw; should indicate no NAV yet
    expect(text).toMatch(/TVL|NAV|vault/i);
  });
});

describe('OperatorCommandHandlers — /forceprocess', () => {
  let h: Harness;
  beforeEach(() => { h = buildHarness(); });
  afterEach(() => { h.state.close(); rmSync(h.dir, { recursive: true, force: true }); });

  it('requeues a failed withdrawal and replies', async () => {
    seedUser(h.store, 1);
    const id = h.store.enqueueWithdrawal({
      telegramId: 1,
      destination: 'Dest1',
      sharesBurned: 5,
      feeShares: 0.015,
      queuedAt: h.nowRef.current - 1000,
    });
    h.store.failWithdrawal({ id, reason: 'rpc failed', processedAt: h.nowRef.current - 500 });

    await h.handlers.handleForceProcess({ chatId: 99, userId: 99, text: `/forceprocess ${id}` });

    const w = h.store.getWithdrawalById(id)!;
    expect(w.status).toBe('queued');
    expect(w.failureReason).toBeNull();
    expect(w.processedAt).toBeNull();
    expect(h.reply).toHaveBeenCalledTimes(1);
    const [, text] = h.reply.mock.calls[0];
    expect(text).toMatch(new RegExp(`${id}`));
    expect(text).toMatch(/queued|retr/i);
  });

  it('writes a withdrawal_requeued audit event', async () => {
    seedUser(h.store, 1);
    const id = h.store.enqueueWithdrawal({
      telegramId: 1, destination: 'Dest1',
      sharesBurned: 5, feeShares: 0.015, queuedAt: h.nowRef.current - 1000,
    });
    h.store.failWithdrawal({ id, reason: 'rpc failed', processedAt: h.nowRef.current - 500 });

    await h.handlers.handleForceProcess({ chatId: 99, userId: 99, text: `/forceprocess ${id}` });

    const events = h.store.listRecentAuditEvents(5);
    const evt = events.find((e) => e.event === 'withdrawal_requeued');
    expect(evt).toBeTruthy();
    expect(JSON.parse(evt!.detailsJson)).toMatchObject({ id });
  });

  it('errors when id is missing from text', async () => {
    await h.handlers.handleForceProcess({ chatId: 99, userId: 99, text: '/forceprocess' });
    expect(h.reply).toHaveBeenCalledTimes(1);
    const [, text] = h.reply.mock.calls[0];
    expect(text).toMatch(/usage|id/i);
  });

  it('errors when withdrawal does not exist', async () => {
    await h.handlers.handleForceProcess({ chatId: 99, userId: 99, text: '/forceprocess 999' });
    expect(h.reply).toHaveBeenCalledTimes(1);
    const [, text] = h.reply.mock.calls[0];
    expect(text).toMatch(/not found|no such/i);
  });

  it('errors when withdrawal is not in failed status', async () => {
    seedUser(h.store, 1);
    const id = h.store.enqueueWithdrawal({
      telegramId: 1, destination: 'Dest1',
      sharesBurned: 5, feeShares: 0.015, queuedAt: h.nowRef.current - 1000,
    });
    // Still 'queued' — can't forceprocess
    await h.handlers.handleForceProcess({ chatId: 99, userId: 99, text: `/forceprocess ${id}` });
    expect(h.reply).toHaveBeenCalledTimes(1);
    const [, text] = h.reply.mock.calls[0];
    expect(text).toMatch(/not.*failed|status/i);
    // Still queued, unchanged
    expect(h.store.getWithdrawalById(id)!.status).toBe('queued');
  });
});
