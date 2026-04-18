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
    getNav: async () => navProvider,
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

  it('fully enrolled user: replies with main menu keyboard', async () => {
    await enrollFully(h, 7);
    await h.handlers.handleAccount({ chatId: 5, userId: 7 });
    expect(h.reply).toHaveBeenCalledTimes(1);
    const [, text, extras] = h.reply.mock.calls[0];
    expect(text).toMatch(/account ready/i);
    const flat = extras?.keyboard?.inline_keyboard?.flat().map((b: any) => b.callback_data) ?? [];
    expect(flat).toContain('act:deposit');
    expect(flat).toContain('act:balance');
    expect(h.handlers.pendingFor(7)).toBeUndefined();
  });
});

describe('CommandHandlers — /accept + /decline enrollment', () => {
  let h: Harness;
  beforeEach(() => { h = buildHarness(); });
  afterEach(() => { h.state.close(); rmSync(h.dir, { recursive: true, force: true }); });

  it('/accept without pending disclaimer replies "no pending action"', async () => {
    await h.handlers.handleAccept({ chatId: 5, userId: 7 });
    expect(h.reply).toHaveBeenCalledTimes(1);
    const [, text] = h.reply.mock.calls[0];
    expect(text).toMatch(/no pending/i);
    expect(h.handlers.pendingFor(7)).toBeUndefined();
    expect(h.store.getUser(7)).toBeNull();
  });

  it('/accept with pending disclaimer creates user + begins TOTP setup + sets pending=totp_setup_confirm', async () => {
    // Seed pending=disclaimer via /account
    await h.handlers.handleAccount({ chatId: 5, userId: 7 });
    expect(h.handlers.pendingFor(7)?.kind).toBe('disclaimer');
    h.reply.mockClear();

    await h.handlers.handleAccept({ chatId: 5, userId: 7 });
    expect(h.reply).toHaveBeenCalledTimes(1);
    const [, text] = h.reply.mock.calls[0];
    // Base32 secret in the reply + mention of 6-digit code or secret
    expect(text).toMatch(/[A-Z2-7]{8,}/);
    expect(text).toMatch(/secret|code/i);
    expect(h.handlers.pendingFor(7)?.kind).toBe('totp_setup_confirm');
    expect(h.store.getUser(7)).not.toBeNull();
    // Audit event disclaimer_accepted is recorded
    const auditRows = h.store.listAudit({ sinceTs: 0, limit: 50 });
    expect(auditRows.some((r) => r.event === 'disclaimer_accepted')).toBe(true);
  });

  it('after /accept, a valid TOTP code confirms enrollment + emits totp_enrolled audit event', async () => {
    await h.handlers.handleAccount({ chatId: 5, userId: 7 });
    await h.handlers.handleAccept({ chatId: 5, userId: 7 });
    expect(h.handlers.pendingFor(7)?.kind).toBe('totp_setup_confirm');
    // Recover the secret we just set up (it's stored encrypted by beginTotpEnrollment)
    const secrets = h.store.getUserSecrets(7)!;
    const { decrypt } = await import('../../src/vault/encryption.js');
    const secretBase32 = decrypt(secrets.totpSecretEnc!, secrets.totpSecretIv!, MASTER_KEY).toString('utf8');
    h.reply.mockClear();

    const restore = advancePastNextTotpStep();
    try {
      const code = await totpCodeFor(secretBase32);
      await h.handlers.handleMessage({ chatId: 5, userId: 7, text: code });
    } finally { restore(); }

    expect(h.handlers.pendingFor(7)).toBeUndefined();
    expect(h.reply).toHaveBeenCalledTimes(1);
    const [, text] = h.reply.mock.calls[0];
    expect(text).toMatch(/account ready/i);
    // totp_enrolled audit event recorded
    const auditRows = h.store.listAudit({ sinceTs: 0, limit: 50 });
    expect(auditRows.some((r) => r.event === 'totp_enrolled')).toBe(true);
    // totpEnrolledAt is now set
    const user = h.store.getUser(7)!;
    expect(user.totpEnrolledAt).not.toBeNull();
  });

  it('after /accept, an invalid TOTP code keeps pending and emits totp_verify_failed', async () => {
    await h.handlers.handleAccount({ chatId: 5, userId: 7 });
    await h.handlers.handleAccept({ chatId: 5, userId: 7 });
    h.reply.mockClear();

    await h.handlers.handleMessage({ chatId: 5, userId: 7, text: '000000' });
    expect(h.reply).toHaveBeenCalledTimes(1);
    const [, text] = h.reply.mock.calls[0];
    expect(text).toMatch(/invalid/i);
    // Still pending — user can retry
    expect(h.handlers.pendingFor(7)?.kind).toBe('totp_setup_confirm');
    const auditRows = h.store.listAudit({ sinceTs: 0, limit: 50 });
    expect(auditRows.some((r) => r.event === 'totp_verify_failed')).toBe(true);
  });

  it('/decline with pending disclaimer clears pending and does not create user', async () => {
    await h.handlers.handleAccount({ chatId: 5, userId: 7 });
    expect(h.handlers.pendingFor(7)?.kind).toBe('disclaimer');
    h.reply.mockClear();

    await h.handlers.handleDecline({ chatId: 5, userId: 7 });
    expect(h.reply).toHaveBeenCalledTimes(1);
    const [, text] = h.reply.mock.calls[0];
    expect(text).toMatch(/cancel/i);
    expect(h.handlers.pendingFor(7)).toBeUndefined();
    expect(h.store.getUser(7)).toBeNull();
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

  // N6: /balance reads live NAV (freshly awaited), not a cached value.
  it('N6: /balance reflects the latest NAV returned by getNav (live, not stale)', async () => {
    const secret = await enrollFully(h, 7);
    h.store.addShares(7, 100);
    // Initial NAV: $100 total → $1.00/share → user has $100.
    h.navProvider.totalUsd = 100;
    h.navProvider.totalShares = 100;

    await h.handlers.handleBalance({ chatId: 5, userId: 7 });
    h.reply.mockClear();

    // Mutate nav between /balance and the TOTP reply; the handler should
    // see the NEW value because it awaits getNav() afresh on every call.
    h.navProvider.totalUsd = 500;
    h.navProvider.totalShares = 100;

    const restore = advancePastNextTotpStep();
    try {
      const code = await totpCodeFor(secret);
      await h.handlers.handleMessage({ chatId: 5, userId: 7, text: code });
    } finally { restore(); }

    expect(h.reply).toHaveBeenCalledTimes(1);
    const [, text] = h.reply.mock.calls[0];
    // User value now $500 (100 shares * $5.00/share), not $100.
    expect(text).toMatch(/\$500(\.00)?/);
    expect(text).not.toMatch(/\$100(\.00)?\b/);
  });

  // N6: /balance replies gracefully when getNav is null (e.g., RPC + snapshot both unavailable).
  it('N6: /balance replies "NAV unavailable" if getNav returns null', async () => {
    const secret = await enrollFully(h, 7);
    h.store.addShares(7, 100);
    // Swap in a nav provider that returns null.
    const state2 = h.state;
    const store2 = h.store;
    const enr2 = h.enrollment;
    const cd2 = h.cooldowns;
    const reply2 = vi.fn(async () => {});
    const nowRef2 = { current: 1_000_000 };
    const handlers2 = new CommandHandlers({
      store: store2, enrollment: enr2, cooldowns: cd2,
      masterKey: MASTER_KEY, reply: reply2,
      config: makeConfig(),
      getNav: async () => null,
      nowMs: () => nowRef2.current,
    });
    void state2;

    await handlers2.handleBalance({ chatId: 5, userId: 7 });
    reply2.mockClear();

    const restore = advancePastNextTotpStep();
    try {
      const code = await totpCodeFor(secret);
      await handlers2.handleMessage({ chatId: 5, userId: 7, text: code });
    } finally { restore(); }

    expect(reply2).toHaveBeenCalledTimes(1);
    const [, text] = reply2.mock.calls[0];
    expect(text).toMatch(/NAV unavailable|try again/i);
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

  it('refuses withdrawal when daily USD cap would be exceeded', async () => {
    // Build a dedicated harness with a lower maxDailyWithdrawalUsdPerUser cap
    const dir = mkdtempSync(join(tmpdir(), 'bertmm-cmd-cap-'));
    const state = new StateStore(join(dir, 'state.db'));
    state.init();
    const store = new DepositorStore(state);
    const enrollment = new Enrollment({ store, masterKey: MASTER_KEY, ensureAta: async () => {} });
    const cooldowns = new Cooldowns({ store, cooldownMs: 24 * 3600 * 1000 });
    const reply = vi.fn(async () => {});
    const navProvider = { totalUsd: 2000, totalShares: 1000 }; // navPerShare=2
    const nowRef = { current: 1_000_000 };
    const handlers = new CommandHandlers({
      store, enrollment, cooldowns, masterKey: MASTER_KEY, reply,
      config: {
        withdrawalFeeBps: 30,
        minWithdrawalUsd: 10,
        maxDailyWithdrawalsPerUser: 10,
        maxDailyWithdrawalUsdPerUser: 500,
        maxPendingWithdrawals: 20,
      },
      getNav: async () => navProvider,
      nowMs: () => nowRef.current,
    });
    try {
      // Enroll user 1 fully (mirrors enrollFully but on this local harness)
      await enrollment.accept({ telegramId: 1, now: 100 });
      const { secretBase32 } = await enrollment.beginTotpEnrollment({ telegramId: 1 });
      const { TOTP } = await import('otpauth');
      const code = new TOTP({ secret: secretBase32 }).generate();
      const ok = await enrollment.confirmTotp({ telegramId: 1, code, now: 101 });
      if (!ok) throw new Error('confirmTotp failed');

      store.setWhitelistImmediate({ telegramId: 1, address: DEST, ts: 150 });
      store.addShares(1, 2000);
      // Pre-seed ~$400 of completed withdrawals in last 24h.
      // 400 shares at navPerShareAt=1.0 → (400 - 1.2) * 1 = $398.8
      const wid = store.enqueueWithdrawal({
        telegramId: 1, destination: DEST, sharesBurned: 400, feeShares: 1.2, queuedAt: 150,
      });
      store.setWithdrawalProcessing(wid);
      store.completeWithdrawal({
        id: wid, txSig: 'prev',
        solLamportsOut: 4_000_000_000n, bertRawOut: 0n,
        navPerShareAt: 1.0, processedAt: 160,
      });

      // Request $200 → would push total to ~$598.8, exceeding $500 cap.
      await handlers.handleWithdraw({ chatId: 1, userId: 1, text: '/withdraw 200' });

      // Rejection — no pending, no new withdrawal queued
      expect(handlers.pendingFor(1)).toBeUndefined();
      expect(store.countPendingWithdrawals()).toBe(0);
      const lastReply = reply.mock.calls.at(-1)?.[1] ?? '';
      expect(lastReply).toMatch(/daily.*cap|limit/i);
    } finally {
      state.close();
      rmSync(dir, { recursive: true, force: true });
    }
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

describe('CommandHandlers — /stats (public)', () => {
  let h: Harness;
  beforeEach(() => { h = buildHarness(); });
  afterEach(() => { h.state.close(); rmSync(h.dir, { recursive: true, force: true }); });

  it('returns TVL + NAV/share from live NAV; no 24h snapshot → delta shown as —', async () => {
    h.navProvider.totalUsd = 2000;
    h.navProvider.totalShares = 1000;

    await h.handlers.handleStats({ chatId: 5, userId: 7 });
    expect(h.reply).toHaveBeenCalledTimes(1);
    const [, text] = h.reply.mock.calls[0];
    expect(text).toMatch(/TVL/i);
    expect(text).toMatch(/\$2,?000/);
    expect(text).toMatch(/NAV/i);
    expect(text).toMatch(/\$2\.00/);
    // No 24h snapshot present
    expect(text).toMatch(/24h.*—|—.*24h/i);
  });

  it('with 24h snapshot: shows delta', async () => {
    h.navProvider.totalUsd = 2200;
    h.navProvider.totalShares = 1000;
    // Snapshot from ~24h ago with navPerShare=2.0; live is 2.2 → +10%
    h.store.insertNavSnapshot({
      ts: h.nowRef.current - 24 * 3600 * 1000,
      totalValueUsd: 2000, totalShares: 1000, navPerShare: 2.0, source: 'hourly',
    });

    await h.handlers.handleStats({ chatId: 5, userId: 7 });
    const [, text] = h.reply.mock.calls[0];
    expect(text).toMatch(/\+10\.0?0?%|10\.0?0?%/);
  });
});

describe('CommandHandlers — TOTP rate limiting', () => {
  let h: Harness;
  beforeEach(() => { h = buildHarness(); });
  afterEach(() => { h.state.close(); rmSync(h.dir, { recursive: true, force: true }); });

  it('5 consecutive bad codes trip lockout; emits totp_rate_limited with until', async () => {
    await enrollFully(h, 7);

    // Four bad codes: each replies "invalid", no lockout yet.
    for (let i = 0; i < 4; i++) {
      await h.handlers.handleDeposit({ chatId: 5, userId: 7 });
      expect(h.handlers.pendingFor(7)?.kind).toBe('deposit_reveal');
      await h.handlers.handleMessage({ chatId: 5, userId: 7, text: '000000' });
      const lastReply = h.reply.mock.calls.at(-1)?.[1] ?? '';
      expect(lastReply).toMatch(/invalid/i);
    }
    // No lockout audit yet.
    let auditRows = h.store.listAudit({ sinceTs: 0, limit: 200 });
    expect(auditRows.some((r) => r.event === 'totp_rate_limited')).toBe(false);
    expect(auditRows.filter((r) => r.event === 'totp_verify_failed').length).toBe(4);

    // Fifth bad code trips lockout.
    await h.handlers.handleDeposit({ chatId: 5, userId: 7 });
    await h.handlers.handleMessage({ chatId: 5, userId: 7, text: '000000' });
    const lockedReply = h.reply.mock.calls.at(-1)?.[1] ?? '';
    expect(lockedReply).toMatch(/locked/i);
    expect(lockedReply).toMatch(/\d+m\s+\d+s/);

    auditRows = h.store.listAudit({ sinceTs: 0, limit: 200 });
    const rlRows = auditRows.filter((r) => r.event === 'totp_rate_limited');
    expect(rlRows.length).toBe(1);
    const details = JSON.parse(rlRows[0]!.detailsJson ?? '{}');
    expect(typeof details.until).toBe('number');
    expect(details.until).toBeGreaterThan(h.nowRef.current);
    // The final verify also recorded a totp_verify_failed before tripping.
    expect(auditRows.filter((r) => r.event === 'totp_verify_failed').length).toBe(5);
  });

  it('during lockout, /deposit replies with lockout message and does not set pending', async () => {
    await enrollFully(h, 7);
    // Force a lockout by burning 5 bad codes.
    for (let i = 0; i < 5; i++) {
      await h.handlers.handleDeposit({ chatId: 5, userId: 7 });
      await h.handlers.handleMessage({ chatId: 5, userId: 7, text: '000000' });
    }
    // Pending should be undefined after the 5th attempt cleared it.
    expect(h.handlers.pendingFor(7)).toBeUndefined();
    h.reply.mockClear();

    // Now a fresh /deposit attempt during lockout:
    await h.handlers.handleDeposit({ chatId: 5, userId: 7 });
    expect(h.reply).toHaveBeenCalledTimes(1);
    const [, text] = h.reply.mock.calls[0];
    expect(text).toMatch(/locked/i);
    expect(text).toMatch(/\d+m\s+\d+s/);
    // No pending action was set — the handler refuses at dispatch time.
    expect(h.handlers.pendingFor(7)).toBeUndefined();
  });

  it('during lockout, /balance /withdraw /setwhitelist /cancelwhitelist all refuse', async () => {
    const ADDR = '7BZ16d4tgebvQ7j59tY1QkwCQ4xd6tqN9GzdAH9v1arF';
    await enrollFully(h, 7);
    h.store.setWhitelistImmediate({ telegramId: 7, address: ADDR, ts: 100 });
    h.store.addShares(7, 100);
    h.navProvider.totalUsd = 200;
    h.navProvider.totalShares = 100;
    // Burn 5 bad codes to lock the user.
    for (let i = 0; i < 5; i++) {
      await h.handlers.handleDeposit({ chatId: 5, userId: 7 });
      await h.handlers.handleMessage({ chatId: 5, userId: 7, text: '000000' });
    }
    h.reply.mockClear();

    await h.handlers.handleBalance({ chatId: 5, userId: 7 });
    expect(h.handlers.pendingFor(7)).toBeUndefined();
    expect(h.reply.mock.calls.at(-1)?.[1]).toMatch(/locked/i);

    await h.handlers.handleWithdraw({ chatId: 5, userId: 7, text: '/withdraw 50' });
    expect(h.handlers.pendingFor(7)).toBeUndefined();
    expect(h.reply.mock.calls.at(-1)?.[1]).toMatch(/locked/i);

    await h.handlers.handleSetWhitelist({ chatId: 5, userId: 7, text: `/setwhitelist ${ADDR}` });
    expect(h.handlers.pendingFor(7)).toBeUndefined();
    expect(h.reply.mock.calls.at(-1)?.[1]).toMatch(/locked/i);

    await h.handlers.handleCancelWhitelist({ chatId: 5, userId: 7 });
    expect(h.handlers.pendingFor(7)).toBeUndefined();
    expect(h.reply.mock.calls.at(-1)?.[1]).toMatch(/locked/i);
  });

  it('successful TOTP clears the failure counter; next bad code does not trip lockout', async () => {
    const secret = await enrollFully(h, 7);
    // Burn 4 bad codes (one shy of lockout).
    for (let i = 0; i < 4; i++) {
      await h.handlers.handleDeposit({ chatId: 5, userId: 7 });
      await h.handlers.handleMessage({ chatId: 5, userId: 7, text: '000000' });
    }

    // Now a valid code should reset the counter.
    await h.handlers.handleDeposit({ chatId: 5, userId: 7 });
    expect(h.handlers.pendingFor(7)?.kind).toBe('deposit_reveal');
    const restore = advancePastNextTotpStep();
    try {
      const code = await totpCodeFor(secret);
      await h.handlers.handleMessage({ chatId: 5, userId: 7, text: code });
    } finally { restore(); }
    // Depicts a successful reveal, not a lockout.
    expect(h.reply.mock.calls.at(-1)?.[1]).not.toMatch(/locked/i);

    // Now one more bad code should NOT trip the lockout — the counter was cleared.
    await h.handlers.handleDeposit({ chatId: 5, userId: 7 });
    await h.handlers.handleMessage({ chatId: 5, userId: 7, text: '000000' });
    const lastReply = h.reply.mock.calls.at(-1)?.[1] ?? '';
    expect(lastReply).toMatch(/invalid/i);
    expect(lastReply).not.toMatch(/locked/i);

    // No totp_rate_limited audit event was ever emitted.
    const auditRows = h.store.listAudit({ sinceTs: 0, limit: 200 });
    expect(auditRows.some((r) => r.event === 'totp_rate_limited')).toBe(false);
  });

  it('failures older than 15 minutes fall off the rolling window', async () => {
    await enrollFully(h, 7);
    // Burn 4 bad codes at t=nowRef.current.
    for (let i = 0; i < 4; i++) {
      await h.handlers.handleDeposit({ chatId: 5, userId: 7 });
      await h.handlers.handleMessage({ chatId: 5, userId: 7, text: '000000' });
    }
    // Advance the clock by 15 minutes + 1 second — those 4 failures expire.
    h.nowRef.current += 15 * 60_000 + 1_000;

    // A fifth bad code should NOT trip the lockout because the prior 4 have
    // fallen out of the rolling window; this is now the first recent failure.
    await h.handlers.handleDeposit({ chatId: 5, userId: 7 });
    await h.handlers.handleMessage({ chatId: 5, userId: 7, text: '000000' });
    const lastReply = h.reply.mock.calls.at(-1)?.[1] ?? '';
    expect(lastReply).toMatch(/invalid/i);
    expect(lastReply).not.toMatch(/locked/i);

    const auditRows = h.store.listAudit({ sinceTs: 0, limit: 200 });
    expect(auditRows.some((r) => r.event === 'totp_rate_limited')).toBe(false);
  });
});

describe('CommandHandlers — withdraw_amount_entry', () => {
  it('reply with a valid USD number transitions pending to { withdraw, amountUsd } and prompts TOTP', async () => {
    const h = buildHarness();
    try {
      await enrollFully(h, 7);
      // simulate the button-tap side effect: mark pending as amount-entry
      h.handlers['pending'].set(7, { kind: 'withdraw_amount_entry' } as any);
      // user must have a whitelist for withdraw to progress
      h.store.setWhitelistImmediate({ telegramId: 7, address: 'ABC'.repeat(15), ts: 1 });
      h.navProvider.totalUsd = 100;
      h.navProvider.totalShares = 50;
      h.store.addShares(7, 25);

      await h.handlers.handleMessage({ chatId: 5, userId: 7, text: '25' });

      const p = h.handlers.pendingFor(7);
      expect(p?.kind).toBe('withdraw');
      expect((p as any).amountUsd).toBeCloseTo(25, 2);
      const lastText = h.reply.mock.calls[h.reply.mock.calls.length - 1][1];
      expect(lastText).toMatch(/6-digit code/i);
    } finally {
      h.state.close();
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  it('reply with non-number clears pending and emits "invalid amount"', async () => {
    const h = buildHarness();
    try {
      await enrollFully(h, 7);
      h.handlers['pending'].set(7, { kind: 'withdraw_amount_entry' } as any);
      await h.handlers.handleMessage({ chatId: 5, userId: 7, text: 'banana' });
      expect(h.handlers.pendingFor(7)).toBeUndefined();
      const lastText = h.reply.mock.calls[h.reply.mock.calls.length - 1][1];
      expect(lastText).toMatch(/invalid/i);
    } finally {
      h.state.close();
      rmSync(h.dir, { recursive: true, force: true });
    }
  });
});

describe('CommandHandlers — /menu', () => {
  it('unenrolled user gets welcome text + welcomeKeyboard', async () => {
    const h = buildHarness();
    try {
      await h.handlers.handleMenu({ chatId: 5, userId: 7 });
      const [chatId, text, extras] = h.reply.mock.calls[0];
      expect(chatId).toBe(5);
      expect(text).toMatch(/Welcome/i);
      expect(extras?.keyboard?.inline_keyboard?.[0]?.[0]?.callback_data).toBe('nav:create_account');
    } finally { h.state.close(); rmSync(h.dir, { recursive: true, force: true }); }
  });

  it('enrolled user gets main menu keyboard', async () => {
    const h = buildHarness();
    try {
      await enrollFully(h, 7);
      await h.handlers.handleMenu({ chatId: 5, userId: 7 });
      const [, , extras] = h.reply.mock.calls[h.reply.mock.calls.length - 1];
      const flat = extras?.keyboard?.inline_keyboard?.flat().map((b: any) => b.callback_data) ?? [];
      expect(flat).toContain('act:deposit');
      expect(flat).toContain('act:withdraw');
      expect(flat).toContain('nav:settings');
    } finally { h.state.close(); rmSync(h.dir, { recursive: true, force: true }); }
  });
});

describe('CommandHandlers — enrollment keyboards', () => {
  it('handleAccount (new user) attaches disclaimer keyboard', async () => {
    const h = buildHarness();
    try {
      await h.handlers.handleAccount({ chatId: 5, userId: 7 });
      const [, , extras] = h.reply.mock.calls[0];
      const flat = extras?.keyboard?.inline_keyboard?.flat().map((b: any) => b.callback_data) ?? [];
      expect(flat).toEqual(['enr:accept', 'enr:decline']);
    } finally { h.state.close(); rmSync(h.dir, { recursive: true, force: true }); }
  });

  it('handleAccept sends QR image (photoBase64) + cancel keyboard', async () => {
    const h = buildHarness();
    try {
      h.handlers['pending'].set(7, { kind: 'disclaimer' } as any);
      await h.handlers.handleAccept({ chatId: 5, userId: 7 });
      const call = h.reply.mock.calls.find(([, , e]: any[]) => e?.photoBase64);
      expect(call).toBeTruthy();
      const [, caption, extras] = call!;
      expect(caption).toMatch(/scan this QR/i);
      expect(extras.photoBase64).toMatch(/^[A-Za-z0-9+/]+=*$/);
      const flat = extras?.keyboard?.inline_keyboard?.flat().map((b: any) => b.callback_data) ?? [];
      expect(flat).toEqual(['cancel']);
    } finally { h.state.close(); rmSync(h.dir, { recursive: true, force: true }); }
  });

  it('post-enrollment confirmation reply attaches main menu keyboard', async () => {
    const h = buildHarness();
    try {
      await h.enrollment.accept({ telegramId: 7, now: 100 });
      const { secretBase32 } = await h.enrollment.beginTotpEnrollment({ telegramId: 7 });
      h.handlers['pending'].set(7, { kind: 'totp_setup_confirm' } as any);
      const { TOTP } = await import('otpauth');
      const code = new TOTP({ secret: secretBase32 }).generate();
      const restore = advancePastNextTotpStep();
      try {
        await h.handlers.handleMessage({ chatId: 5, userId: 7, text: code });
      } finally { restore(); }
      const last = h.reply.mock.calls[h.reply.mock.calls.length - 1];
      const extras = last[2];
      const flat = extras?.keyboard?.inline_keyboard?.flat().map((b: any) => b.callback_data) ?? [];
      expect(flat).toContain('act:deposit');
      expect(flat).toContain('act:balance');
    } finally { h.state.close(); rmSync(h.dir, { recursive: true, force: true }); }
  });
});

describe('CommandHandlers — deposit/balance/stats keyboards', () => {
  it('handleDeposit prompt uses cancelKeyboard; reveal uses postDepositKeyboard', async () => {
    const h = buildHarness();
    try {
      const secret = await enrollFully(h, 7);
      await h.handlers.handleDeposit({ chatId: 5, userId: 7 });
      let last = h.reply.mock.calls[h.reply.mock.calls.length - 1];
      expect(last[2]?.keyboard?.inline_keyboard?.[0]?.[0]?.callback_data).toBe('cancel');
      const restore = advancePastNextTotpStep();
      try {
        const code = await totpCodeFor(secret);
        await h.handlers.handleMessage({ chatId: 5, userId: 7, text: code });
      } finally { restore(); }
      last = h.reply.mock.calls[h.reply.mock.calls.length - 1];
      const flat = last[2]?.keyboard?.inline_keyboard?.flat().map((b: any) => b.callback_data) ?? [];
      expect(flat).toEqual(['act:balance', 'nav:home']);
    } finally { h.state.close(); rmSync(h.dir, { recursive: true, force: true }); }
  });

  it('handleBalance reveal uses postBalanceKeyboard', async () => {
    const h = buildHarness();
    try {
      const secret = await enrollFully(h, 7);
      h.navProvider.totalUsd = 100; h.navProvider.totalShares = 50;
      h.store.addShares(7, 25);
      await h.handlers.handleBalance({ chatId: 5, userId: 7 });
      const restore = advancePastNextTotpStep();
      try {
        const code = await totpCodeFor(secret);
        await h.handlers.handleMessage({ chatId: 5, userId: 7, text: code });
      } finally { restore(); }
      const last = h.reply.mock.calls[h.reply.mock.calls.length - 1];
      const flat = last[2]?.keyboard?.inline_keyboard?.flat().map((b: any) => b.callback_data) ?? [];
      expect(flat).toEqual(['act:withdraw', 'act:deposit', 'nav:home']);
    } finally { h.state.close(); rmSync(h.dir, { recursive: true, force: true }); }
  });

  it('handleStats reply includes [🏠 Menu] when user enrolled', async () => {
    const h = buildHarness();
    try {
      await enrollFully(h, 7);
      h.navProvider.totalUsd = 100; h.navProvider.totalShares = 50;
      await h.handlers.handleStats({ chatId: 5, userId: 7 });
      const last = h.reply.mock.calls[h.reply.mock.calls.length - 1];
      const flat = last[2]?.keyboard?.inline_keyboard?.flat().map((b: any) => b.callback_data) ?? [];
      expect(flat).toEqual(['nav:home']);
    } finally { h.state.close(); rmSync(h.dir, { recursive: true, force: true }); }
  });

  it('handleStats reply has no keyboard for non-enrolled user (or no userId)', async () => {
    const h = buildHarness();
    try {
      h.navProvider.totalUsd = 100; h.navProvider.totalShares = 50;
      await h.handlers.handleStats({ chatId: 5 });
      const last = h.reply.mock.calls[h.reply.mock.calls.length - 1];
      expect(last[2]?.keyboard).toBeUndefined();
    } finally { h.state.close(); rmSync(h.dir, { recursive: true, force: true }); }
  });
});

describe('CommandHandlers — withdraw/whitelist keyboards', () => {
  it('handleWithdraw with no arg shows amount picker + sets pending=withdraw_amount_entry', async () => {
    const h = buildHarness();
    try {
      await enrollFully(h, 7);
      h.store.setWhitelistImmediate({ telegramId: 7, address: 'A'.repeat(44), ts: 1 });
      await h.handlers.handleWithdraw({ chatId: 5, userId: 7, text: '/withdraw' });
      const last = h.reply.mock.calls[h.reply.mock.calls.length - 1];
      expect(last[1]).toMatch(/how much/i);
      const flat = last[2]?.keyboard?.inline_keyboard?.flat().map((b: any) => b.callback_data) ?? [];
      expect(flat).toContain('wd:p50');
      expect(flat).toContain('wd:custom');
      expect(h.handlers.pendingFor(7)?.kind).toBe('withdraw_amount_entry');
    } finally { h.state.close(); rmSync(h.dir, { recursive: true, force: true }); }
  });

  it('handleWithdraw <amount> prompt uses cancelKeyboard', async () => {
    const h = buildHarness();
    try {
      await enrollFully(h, 7);
      h.store.setWhitelistImmediate({ telegramId: 7, address: 'A'.repeat(44), ts: 1 });
      h.navProvider.totalUsd = 100; h.navProvider.totalShares = 50;
      h.store.addShares(7, 25);
      await h.handlers.handleWithdraw({ chatId: 5, userId: 7, text: '/withdraw 50%' });
      const last = h.reply.mock.calls[h.reply.mock.calls.length - 1];
      const flat = last[2]?.keyboard?.inline_keyboard?.flat().map((b: any) => b.callback_data) ?? [];
      expect(flat).toEqual(['cancel']);
    } finally { h.state.close(); rmSync(h.dir, { recursive: true, force: true }); }
  });

  it('handleSetWhitelist prompt uses cancelKeyboard', async () => {
    const h = buildHarness();
    try {
      await enrollFully(h, 7);
      await h.handlers.handleSetWhitelist({ chatId: 5, userId: 7, text: '/setwhitelist' });
      const last = h.reply.mock.calls[h.reply.mock.calls.length - 1];
      const flat = last[2]?.keyboard?.inline_keyboard?.flat().map((b: any) => b.callback_data) ?? [];
      expect(flat).toEqual(['cancel']);
    } finally { h.state.close(); rmSync(h.dir, { recursive: true, force: true }); }
  });

  it('handleCancelWhitelist prompt uses cancelKeyboard', async () => {
    const h = buildHarness();
    try {
      await enrollFully(h, 7);
      h.store.setWhitelistImmediate({ telegramId: 7, address: 'A'.repeat(44), ts: 1 });
      await h.handlers.handleCancelWhitelist({ chatId: 5, userId: 7 });
      const last = h.reply.mock.calls[h.reply.mock.calls.length - 1];
      const flat = last[2]?.keyboard?.inline_keyboard?.flat().map((b: any) => b.callback_data) ?? [];
      expect(flat).toEqual(['cancel']);
    } finally { h.state.close(); rmSync(h.dir, { recursive: true, force: true }); }
  });
});

/**
 * C1 regression: the wrapper lambda in main.ts used to be
 *   reply: (chatId, text) => tgCmd.reply(chatId, text)
 * which silently dropped the third `extras` argument. Every keyboard + the
 * enrollment QR photo were stripped in production even though the direct
 * vi.fn() mocks elsewhere in this file covered keyboards being attached.
 *
 * These tests wire a real TelegramCommander.reply (with fetch mocked) through
 * both lambda shapes. The buggy 2-arg form drops reply_markup from the HTTP
 * body; the correct 3-arg form (as main.ts now does) preserves it.
 */
describe('CommandHandlers — reply wiring regression (C1)', () => {
  async function wireAndTap(lambdaMode: 'buggy-2arg' | 'fixed-3arg') {
    const { TelegramCommander } = await import('../../src/telegramCommander.js');
    const { CommandHandlers } = await import('../../src/vault/commands.js');
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 1 } }),
    }));
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const h = buildHarness();
    try {
      const tgCmd = new TelegramCommander({
        botToken: 'tok', operatorUserId: 1, depositorStore: h.store,
      });
      const reply = lambdaMode === 'fixed-3arg'
        ? (chatId: number, text: string, extras?: any) => tgCmd.reply(chatId, text, extras)
        // Mimics the original main.ts bug — silently drops extras.
        : (chatId: number, text: string) => tgCmd.reply(chatId, text);
      const wiredHandlers = new CommandHandlers({
        store: h.store,
        enrollment: h.enrollment,
        cooldowns: h.cooldowns,
        masterKey: MASTER_KEY,
        reply,
        config: makeConfig(),
        getNav: async () => h.navProvider,
        nowMs: () => h.nowRef.current,
      });
      await enrollFully(h, 7);
      // handleMenu on an enrolled user emits the main-menu keyboard.
      await wiredHandlers.handleMenu({ chatId: 5, userId: 7 });
      const sendMsgCall = fetchMock.mock.calls.find((c: any) =>
        typeof c[0] === 'string' && c[0].endsWith('/sendMessage'),
      );
      const body = sendMsgCall ? JSON.parse((sendMsgCall as any)[1].body as string) : null;
      return { body };
    } finally {
      h.state.close();
      rmSync(h.dir, { recursive: true, force: true });
      globalThis.fetch = realFetch;
    }
  }

  it('3-arg wrapper (fix): HTTP body includes reply_markup with main-menu buttons', async () => {
    const { body } = await wireAndTap('fixed-3arg');
    expect(body).not.toBeNull();
    expect(body.reply_markup).toBeDefined();
    const flat = body.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);
    expect(flat).toContain('act:deposit');
    expect(flat).toContain('act:balance');
  });

  it('2-arg wrapper (the bug): HTTP body has no reply_markup — proves the regression', async () => {
    const { body } = await wireAndTap('buggy-2arg');
    expect(body).not.toBeNull();
    expect(body.reply_markup).toBeUndefined();
  });
});
