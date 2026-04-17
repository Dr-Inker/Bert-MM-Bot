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

describe('CommandHandlers — /setwhitelist + /cancelwhitelist', () => {
  let h: Harness;
  const ADDR1 = '7BZ16d4tgebvQ7j59tY1QkwCQ4xd6tqN9GzdAH9v1arF';
  const ADDR2 = 'G2Hw7syz4YjwYdBBW13MzaZUJazoryoKoSfXbPSjvVyn';

  beforeEach(() => { h = buildHarness(); });
  afterEach(() => { h.state.close(); rmSync(h.dir, { recursive: true, force: true }); });

  it('first-set: after TOTP, whitelist is applied immediately', async () => {
    const secret = await enrollFully(h, 7);
    await h.handlers.handleSetWhitelist({ chatId: 5, userId: 7, text: `/setwhitelist ${ADDR1}` });
    expect(h.handlers.pendingFor(7)?.kind).toBe('setwhitelist_first');
    h.reply.mockClear();

    const restore = advancePastNextTotpStep();
    try {
      const code = await totpCodeFor(secret);
      await h.handlers.handleMessage({ chatId: 5, userId: 7, text: code });
    } finally { restore(); }
    expect(h.store.getUser(7)!.whitelistAddress).toBe(ADDR1);
    const [, text] = h.reply.mock.calls[0];
    expect(text).toMatch(/active|effect|set/i);
  });

  it('subsequent change: after TOTP, enqueued with 24h cooldown', async () => {
    const secret = await enrollFully(h, 7);
    // first-set synchronously
    h.store.setWhitelistImmediate({ telegramId: 7, address: ADDR1, ts: 100 });

    await h.handlers.handleSetWhitelist({ chatId: 5, userId: 7, text: `/setwhitelist ${ADDR2}` });
    expect(h.handlers.pendingFor(7)?.kind).toBe('setwhitelist_change');
    const [, promptText] = h.reply.mock.calls[0];
    expect(promptText).toMatch(/24/);
    h.reply.mockClear();

    const restore = advancePastNextTotpStep();
    try {
      const code = await totpCodeFor(secret);
      await h.handlers.handleMessage({ chatId: 5, userId: 7, text: code });
    } finally { restore(); }
    // Not yet changed
    expect(h.store.getUser(7)!.whitelistAddress).toBe(ADDR1);
    expect(h.store.mostRecentPendingChange(7)?.newAddress).toBe(ADDR2);
  });

  it('cancelwhitelist: success when pending exists', async () => {
    const secret = await enrollFully(h, 7);
    h.store.setWhitelistImmediate({ telegramId: 7, address: ADDR1, ts: 100 });
    h.cooldowns.requestChange({ telegramId: 7, newAddress: ADDR2, now: h.nowRef.current });

    await h.handlers.handleCancelWhitelist({ chatId: 5, userId: 7 });
    expect(h.handlers.pendingFor(7)?.kind).toBe('cancelwhitelist');
    h.reply.mockClear();

    const restore = advancePastNextTotpStep();
    try {
      const code = await totpCodeFor(secret);
      await h.handlers.handleMessage({ chatId: 5, userId: 7, text: code });
    } finally { restore(); }
    const [, text] = h.reply.mock.calls[0];
    expect(text).toMatch(/cancel/i);
    expect(h.store.mostRecentPendingChange(7)).toBeNull();
  });

  it('cancelwhitelist: replies "nothing to cancel" when nothing pending', async () => {
    const secret = await enrollFully(h, 7);
    h.store.setWhitelistImmediate({ telegramId: 7, address: ADDR1, ts: 100 });

    await h.handlers.handleCancelWhitelist({ chatId: 5, userId: 7 });
    h.reply.mockClear();

    const restore = advancePastNextTotpStep();
    try {
      const code = await totpCodeFor(secret);
      await h.handlers.handleMessage({ chatId: 5, userId: 7, text: code });
    } finally { restore(); }
    const [, text] = h.reply.mock.calls[0];
    expect(text).toMatch(/nothing|no pending/i);
  });
});

describe('CommandHandlers — /withdraw', () => {
  let h: Harness;
  const DEST = '7BZ16d4tgebvQ7j59tY1QkwCQ4xd6tqN9GzdAH9v1arF';

  beforeEach(() => {
    h = buildHarness();
    // NAV = $2000 / 1000 shares = $2/share (user value @ 100 shares = $200)
    h.navProvider.totalUsd = 2000;
    h.navProvider.totalShares = 1000;
  });
  afterEach(() => { h.state.close(); rmSync(h.dir, { recursive: true, force: true }); });

  it('not enrolled: refuses', async () => {
    await h.handlers.handleWithdraw({ chatId: 5, userId: 7, text: '/withdraw 100' });
    const [, text] = h.reply.mock.calls[0];
    expect(text).toMatch(/\/account/i);
  });

  it('no whitelist: refuses', async () => {
    await enrollFully(h, 7);
    h.store.addShares(7, 100);
    await h.handlers.handleWithdraw({ chatId: 5, userId: 7, text: '/withdraw 100' });
    const [, text] = h.reply.mock.calls[0];
    expect(text).toMatch(/whitelist/i);
  });

  it('below min: refuses', async () => {
    await enrollFully(h, 7);
    h.store.setWhitelistImmediate({ telegramId: 7, address: DEST, ts: 100 });
    h.store.addShares(7, 100);
    await h.handlers.handleWithdraw({ chatId: 5, userId: 7, text: '/withdraw 5' });
    const [, text] = h.reply.mock.calls[0];
    expect(text).toMatch(/minimum|min/i);
  });

  it('exceeds daily count cap: refuses', async () => {
    await enrollFully(h, 7);
    h.store.setWhitelistImmediate({ telegramId: 7, address: DEST, ts: 100 });
    h.store.addShares(7, 100);
    // Pre-seed 3 queued withdrawals (config cap = 3)
    for (let i = 0; i < 3; i++) {
      h.store.enqueueWithdrawal({
        telegramId: 7, destination: DEST, sharesBurned: 1, feeShares: 0, queuedAt: h.nowRef.current,
      });
    }
    await h.handlers.handleWithdraw({ chatId: 5, userId: 7, text: '/withdraw 50' });
    const [, text] = h.reply.mock.calls[0];
    expect(text).toMatch(/daily|limit|cap/i);
  });

  it('exceeds global queue cap: refuses', async () => {
    await enrollFully(h, 7);
    h.store.setWhitelistImmediate({ telegramId: 7, address: DEST, ts: 100 });
    h.store.addShares(7, 100);
    // Fill global queue to cap (maxPendingWithdrawals=20)
    h.store.createUser({
      telegramId: 99, role: 'depositor', depositAddress: 'OTHER',
      depositSecretEnc: Buffer.alloc(0), depositSecretIv: Buffer.alloc(0),
      disclaimerAt: 100, createdAt: 100,
    });
    for (let i = 0; i < 20; i++) {
      h.store.enqueueWithdrawal({
        telegramId: 99, destination: DEST, sharesBurned: 1, feeShares: 0, queuedAt: h.nowRef.current,
      });
    }
    await h.handlers.handleWithdraw({ chatId: 5, userId: 7, text: '/withdraw 50' });
    const [, text] = h.reply.mock.calls[0];
    expect(text).toMatch(/queue|busy|full/i);
  });

  it('success: enqueues withdrawal after TOTP', async () => {
    const secret = await enrollFully(h, 7);
    h.store.setWhitelistImmediate({ telegramId: 7, address: DEST, ts: 100 });
    h.store.addShares(7, 100);

    await h.handlers.handleWithdraw({ chatId: 5, userId: 7, text: '/withdraw 100' });
    expect(h.handlers.pendingFor(7)?.kind).toBe('withdraw');
    h.reply.mockClear();

    const restore = advancePastNextTotpStep();
    try {
      const code = await totpCodeFor(secret);
      await h.handlers.handleMessage({ chatId: 5, userId: 7, text: code });
    } finally { restore(); }
    expect(h.reply).toHaveBeenCalledTimes(1);
    const [, text] = h.reply.mock.calls[0];
    expect(text).toMatch(/queued|will be processed/i);
    const queued = h.store.listWithdrawalsByStatus('queued');
    expect(queued.length).toBe(1);
    expect(queued[0]!.telegramId).toBe(7);
    // sharesBurned ≈ 100 USD / 2 USD-per-share = 50 shares
    expect(queued[0]!.sharesBurned).toBeCloseTo(50, 2);
    // feeShares at 30 bps = 0.3% of 50 = 0.15
    expect(queued[0]!.feeShares).toBeCloseTo(0.15, 3);
  });

  it('percent syntax: 50% of user balance', async () => {
    const secret = await enrollFully(h, 7);
    h.store.setWhitelistImmediate({ telegramId: 7, address: DEST, ts: 100 });
    h.store.addShares(7, 100);
    // navPerShare=2, user has 100 shares worth $200, 50% = $100 → 50 shares

    await h.handlers.handleWithdraw({ chatId: 5, userId: 7, text: '/withdraw 50%' });
    h.reply.mockClear();

    const restore = advancePastNextTotpStep();
    try {
      const code = await totpCodeFor(secret);
      await h.handlers.handleMessage({ chatId: 5, userId: 7, text: code });
    } finally { restore(); }
    const queued = h.store.listWithdrawalsByStatus('queued');
    expect(queued.length).toBe(1);
    expect(queued[0]!.sharesBurned).toBeCloseTo(50, 2);
  });
});
