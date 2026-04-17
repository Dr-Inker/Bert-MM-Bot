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

describe('CommandHandlers — /account', () => {
  let dir: string;
  let state: StateStore;
  let store: DepositorStore;
  let enrollment: Enrollment;
  let cooldowns: Cooldowns;
  let reply: ReturnType<typeof vi.fn>;
  let handlers: CommandHandlers;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bertmm-cmd-'));
    state = new StateStore(join(dir, 'state.db'));
    state.init();
    store = new DepositorStore(state);
    enrollment = new Enrollment({ store, masterKey: MASTER_KEY, ensureAta: async () => {} });
    cooldowns = new Cooldowns({ store, cooldownMs: 24 * 3600 * 1000 });
    reply = vi.fn(async () => {});
    handlers = new CommandHandlers({
      store, enrollment, cooldowns, masterKey: MASTER_KEY, reply,
      config: makeConfig(),
      getNav: () => ({ totalUsd: 0, totalShares: 0 }),
      nowMs: () => 1_000_000,
    });
  });
  afterEach(() => { state.close(); rmSync(dir, { recursive: true, force: true }); });

  it('fresh user: replies with the disclaimer and sets pending=disclaimer', async () => {
    await handlers.handleAccount({ chatId: 5, userId: 7 });
    expect(reply).toHaveBeenCalledTimes(1);
    const [chatId, text] = reply.mock.calls[0];
    expect(chatId).toBe(5);
    expect(text).toContain('BERT Vault');
    expect(text).toBe(DISCLAIMER_TEXT);
    expect(handlers.pendingFor(7)?.kind).toBe('disclaimer');
  });

  it('user exists but TOTP not enrolled: restarts TOTP setup and prompts for code', async () => {
    // Seed user via enrollment.accept (no TOTP yet)
    await enrollment.accept({ telegramId: 7, now: 100 });
    await handlers.handleAccount({ chatId: 5, userId: 7 });
    expect(reply).toHaveBeenCalledTimes(1);
    const [chatId, text] = reply.mock.calls[0];
    expect(chatId).toBe(5);
    // Should contain the fallback text secret
    expect(text).toMatch(/[A-Z2-7]{8,}/);
    expect(text).toMatch(/6-digit code/i);
    expect(handlers.pendingFor(7)?.kind).toBe('totp_setup_confirm');
  });

  it('fully enrolled user: replies with help message', async () => {
    await enrollment.accept({ telegramId: 7, now: 100 });
    const { secretBase32 } = await enrollment.beginTotpEnrollment({ telegramId: 7 });
    const { TOTP } = await import('otpauth');
    const code = new TOTP({ secret: secretBase32 }).generate();
    await enrollment.confirmTotp({ telegramId: 7, code, now: 200 });

    await handlers.handleAccount({ chatId: 5, userId: 7 });
    expect(reply).toHaveBeenCalledTimes(1);
    const [, text] = reply.mock.calls[0];
    expect(text).toMatch(/\/deposit/);
    expect(text).toMatch(/\/balance/);
    expect(text).toMatch(/\/withdraw/);
    // No pending action for a fully-enrolled /account call
    expect(handlers.pendingFor(7)).toBeUndefined();
  });
});
