import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StateStore } from '../../src/stateStore.js';
import { DepositorStore } from '../../src/vault/depositorStore.js';
import { Enrollment } from '../../src/vault/enrollment.js';
import { Cooldowns } from '../../src/vault/cooldowns.js';
import { CommandHandlers } from '../../src/vault/commands.js';
import { DISCLAIMER_TEXT } from '../../src/vault/disclaimer.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MASTER_KEY = Buffer.alloc(32, 42);

function makeConfig() {
  return {
    withdrawalFeeBps: 30,
    minWithdrawalUsd: 10,
    maxDailyWithdrawalsPerUser: 3,
    maxDailyWithdrawalUsdPerUser: 1000,
    maxPendingWithdrawals: 20,
  };
}

interface Harness {
  dir: string;
  state: StateStore;
  store: DepositorStore;
  enrollment: Enrollment;
  cooldowns: Cooldowns;
  reply: ReturnType<typeof vi.fn>;
  handlers: CommandHandlers;
  navProvider: { totalUsd: number; totalShares: number };
  nowRef: { current: number };
}

function buildHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'bertmm-cmd-'));
  const state = new StateStore(join(dir, 'state.db'));
  state.init();
  const store = new DepositorStore(state);
  const enrollment = new Enrollment({ store, masterKey: MASTER_KEY, ensureAta: async () => {} });
  const cooldowns = new Cooldowns({ store, cooldownMs: 24 * 3600 * 1000 });
  const reply = vi.fn(async () => {});
  const navProvider = { totalUsd: 0, totalShares: 0 };
  const nowRef = { current: 1_000_000 };
  const handlers = new CommandHandlers({
    store, enrollment, cooldowns, masterKey: MASTER_KEY, reply,
    config: makeConfig(),
    getNav: () => navProvider,
    nowMs: () => nowRef.current,
  });
  return { dir, state, store, enrollment, cooldowns, reply, handlers, navProvider, nowRef };
}

async function enrollFully(h: Harness, telegramId: number, now = 100): Promise<string> {
  await h.enrollment.accept({ telegramId, now });
  const { secretBase32 } = await h.enrollment.beginTotpEnrollment({ telegramId });
  const { TOTP } = await import('otpauth');
  const code = new TOTP({ secret: secretBase32 }).generate();
  const ok = await h.enrollment.confirmTotp({ telegramId, code, now: now + 1 });
  if (!ok) throw new Error('enrollFully: confirmTotp failed');
  return secretBase32;
}

async function totpCodeFor(secret: string): Promise<string> {
  const { TOTP } = await import('otpauth');
  return new TOTP({ secret }).generate();
}

/**
 * Monkey-patch `Date.now` to advance to the next 30-second TOTP step boundary
 * so a freshly generated code maps to a counter > lastUsedCounter (otpauth's
 * `generate` + verify-side `currentCounter` both read `Date.now()`).
 * Returns a restore function.
 */
function advancePastNextTotpStep(): () => void {
  const realNow = Date.now.bind(Date);
  const start = realNow();
  const stepMs = 30_000;
  const msIntoStep = start % stepMs;
  const offset = stepMs - msIntoStep + 1_000;
  Date.now = () => realNow() + offset;
  return () => { Date.now = realNow; };
}

describe('CommandHandlers — /account', () => {
  let h: Harness;
  beforeEach(() => { h = buildHarness(); });
  afterEach(() => { h.state.close(); rmSync(h.dir, { recursive: true, force: true }); });

  it('fresh user: replies with the disclaimer and sets pending=disclaimer', async () => {
    await h.handlers.handleAccount({ chatId: 5, userId: 7 });
    expect(h.reply).toHaveBeenCalledTimes(1);
    const [chatId, text] = h.reply.mock.calls[0];
    expect(chatId).toBe(5);
    expect(text).toBe(DISCLAIMER_TEXT);
    expect(h.handlers.pendingFor(7)?.kind).toBe('disclaimer');
  });

  it('user exists but TOTP not enrolled: restarts TOTP setup and prompts for code', async () => {
    await h.enrollment.accept({ telegramId: 7, now: 100 });
    await h.handlers.handleAccount({ chatId: 5, userId: 7 });
    expect(h.reply).toHaveBeenCalledTimes(1);
    const [, text] = h.reply.mock.calls[0];
    expect(text).toMatch(/[A-Z2-7]{8,}/);
    expect(text).toMatch(/6-digit code/i);
    expect(h.handlers.pendingFor(7)?.kind).toBe('totp_setup_confirm');
  });

  it('fully enrolled user: replies with help message', async () => {
    await enrollFully(h, 7);
    await h.handlers.handleAccount({ chatId: 5, userId: 7 });
    expect(h.reply).toHaveBeenCalledTimes(1);
    const [, text] = h.reply.mock.calls[0];
    expect(text).toMatch(/\/deposit/);
    expect(text).toMatch(/\/balance/);
    expect(text).toMatch(/\/withdraw/);
    expect(h.handlers.pendingFor(7)).toBeUndefined();
  });
});

describe('CommandHandlers — /deposit', () => {
  let h: Harness;
  beforeEach(() => { h = buildHarness(); });
  afterEach(() => { h.state.close(); rmSync(h.dir, { recursive: true, force: true }); });

  it('not enrolled: instructs user to enroll via /account', async () => {
    await h.handlers.handleDeposit({ chatId: 5, userId: 7 });
    expect(h.reply).toHaveBeenCalledTimes(1);
    const [, text] = h.reply.mock.calls[0];
    expect(text).toMatch(/\/account/i);
    expect(h.handlers.pendingFor(7)).toBeUndefined();
  });

  it('enrolled + bad code: rejects with generic error', async () => {
    await enrollFully(h, 7);
    await h.handlers.handleDeposit({ chatId: 5, userId: 7 });
    expect(h.reply).toHaveBeenCalledTimes(1); // prompt
    expect(h.handlers.pendingFor(7)?.kind).toBe('deposit_reveal');
    h.reply.mockClear();

    await h.handlers.handleMessage({ chatId: 5, userId: 7, text: '000000' });
    expect(h.reply).toHaveBeenCalledTimes(1);
    const [, text] = h.reply.mock.calls[0];
    expect(text).toMatch(/invalid|failed|incorrect/i);
    // pending cleared on verification attempt
    expect(h.handlers.pendingFor(7)).toBeUndefined();
  });

  it('enrolled + valid code: replies with the deposit address', async () => {
    const secret = await enrollFully(h, 7);
    await h.handlers.handleDeposit({ chatId: 5, userId: 7 });
    h.reply.mockClear();

    const restore = advancePastNextTotpStep();
    try {
      const code = await totpCodeFor(secret);
      await h.handlers.handleMessage({ chatId: 5, userId: 7, text: code });
    } finally { restore(); }
    expect(h.reply).toHaveBeenCalledTimes(1);
    const [, text] = h.reply.mock.calls[0];
    const depositAddr = h.store.getUser(7)!.depositAddress;
    expect(text).toContain(depositAddr);
    expect(h.handlers.pendingFor(7)).toBeUndefined();
  });
});

describe('CommandHandlers — /balance', () => {
  let h: Harness;
  beforeEach(() => { h = buildHarness(); });
  afterEach(() => { h.state.close(); rmSync(h.dir, { recursive: true, force: true }); });

  it('not enrolled: instructs user to enroll', async () => {
    await h.handlers.handleBalance({ chatId: 5, userId: 7 });
    expect(h.reply).toHaveBeenCalledTimes(1);
    const [, text] = h.reply.mock.calls[0];
    expect(text).toMatch(/\/account/i);
  });

  it('enrolled + valid code: shows shares + USD value', async () => {
    const secret = await enrollFully(h, 7);
    // Seed 100 shares, NAV total $200 → navPerShare = 2 → user value $200
    h.store.addShares(7, 100);
    h.navProvider.totalUsd = 200;
    h.navProvider.totalShares = 100;

    await h.handlers.handleBalance({ chatId: 5, userId: 7 });
    expect(h.handlers.pendingFor(7)?.kind).toBe('balance_reveal');
    h.reply.mockClear();

    const restore = advancePastNextTotpStep();
    try {
      const code = await totpCodeFor(secret);
      await h.handlers.handleMessage({ chatId: 5, userId: 7, text: code });
    } finally { restore(); }
    expect(h.reply).toHaveBeenCalledTimes(1);
    const [, text] = h.reply.mock.calls[0];
    expect(text).toMatch(/100(\.00)?\s*shares/i);
    expect(text).toMatch(/\$200(\.00)?/);
    expect(h.handlers.pendingFor(7)).toBeUndefined();
  });

  it('enrolled + bad code: rejects', async () => {
    await enrollFully(h, 7);
    h.store.addShares(7, 50);
    h.navProvider.totalUsd = 100;
    h.navProvider.totalShares = 50;

    await h.handlers.handleBalance({ chatId: 5, userId: 7 });
    h.reply.mockClear();
    await h.handlers.handleMessage({ chatId: 5, userId: 7, text: '000000' });
    expect(h.reply).toHaveBeenCalledTimes(1);
    const [, text] = h.reply.mock.calls[0];
    expect(text).toMatch(/invalid|failed/i);
  });
});
