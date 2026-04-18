import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CommandHandlers } from '../../src/vault/commands.js';
import { StateStore } from '../../src/stateStore.js';
import { DepositorStore } from '../../src/vault/depositorStore.js';
import { Enrollment } from '../../src/vault/enrollment.js';
import { Cooldowns } from '../../src/vault/cooldowns.js';
import { makeCallbackRouter } from '../../src/vault/uiCallbacks.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MASTER_KEY = Buffer.alloc(32, 42);

describe('UI integration — button flow → queued withdrawal', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bertmm-ui-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('tap [50%] on enrolled user with whitelist + balance → TOTP prompt, reply consumes, withdrawal queued', async () => {
    // Set up the full stack with real implementations + an in-memory SQLite db.
    const state = new StateStore(join(dir, 'state.db'));
    state.init();
    const store = new DepositorStore(state);
    const enrollment = new Enrollment({ store, masterKey: MASTER_KEY, ensureAta: async () => {} });
    const cooldowns = new Cooldowns({ store, cooldownMs: 24 * 3600 * 1000 });

    // Outbound reply capture so we can inspect the message sequence.
    const sends: Array<{ chatId: number; text: string; extras?: any }> = [];
    const reply = vi.fn(async (chatId: number, text: string, extras?: any) => {
      sends.push({ chatId, text, extras });
    });

    // navPerShare = totalUsd / totalShares = 100 / 50 = 2.
    // Crediting the user 50 shares makes their net balance = 50 * $2 = $100,
    // so a 50% withdrawal yields amountUsd = $50 (matches spec assertion).
    const handlers = new CommandHandlers({
      store, enrollment, cooldowns, masterKey: MASTER_KEY, reply,
      config: {
        withdrawalFeeBps: 30,
        minWithdrawalUsd: 10,
        maxDailyWithdrawalsPerUser: 3,
        maxDailyWithdrawalUsdPerUser: 1000,
        maxPendingWithdrawals: 20,
        uiButtons: true,
      },
      getNav: async () => ({ totalUsd: 100, totalShares: 50 }),
      nowMs: () => Date.now(),
    });
    const route = makeCallbackRouter({ handlers, reply });

    // Enroll user, set whitelist, credit shares.
    await enrollment.accept({ telegramId: 7, now: 100 });
    const { secretBase32 } = await enrollment.beginTotpEnrollment({ telegramId: 7 });
    const { TOTP } = await import('otpauth');
    const code1 = new TOTP({ secret: secretBase32 }).generate();
    const enrolled = await enrollment.confirmTotp({ telegramId: 7, code: code1, now: 101 });
    expect(enrolled).toBe(true);
    store.setWhitelistImmediate({ telegramId: 7, address: 'A'.repeat(44), ts: 200 });
    store.addShares(7, 50);

    // User taps [50%].
    await route({ id: 'q1', userId: 7, chatId: 5, data: 'wd:p50' });

    // Most-recent reply should be the TOTP confirm prompt (handleWithdraw issues
    // the "Reply with your 2FA code…" message after parsing the percentage).
    const confirm = sends[sends.length - 1];
    expect(confirm.text).toMatch(/2FA code|6-digit code/i);
    // Pending state should be set so handleMessage knows to consume the next code.
    expect(handlers.pendingFor(7)?.kind).toBe('withdraw');

    // User replies with a fresh TOTP code. Advance Date.now to the next 30s
    // step so otpauth produces a counter > lastUsedCounter (the enrollment
    // confirmation above just consumed the current step's counter). The mock
    // must wrap BOTH `TOTP.generate()` AND `handleMessage(code)` because both
    // sides read Date.now() to derive the counter.
    const stepMs = 30_000;
    const realNow = Date.now.bind(Date);
    const restore = () => { Date.now = realNow; };
    try {
      const start = realNow();
      Date.now = () => realNow() + (stepMs - (start % stepMs)) + 1_000;
      const code2 = new TOTP({ secret: secretBase32 }).generate();
      await handlers.handleMessage({ chatId: 5, userId: 7, text: code2 });
    } finally {
      restore();
    }

    // Withdrawal should be queued in the store. Real status enum is
    // 'queued' | 'processing' | 'completed' | 'failed'; an enqueued row sits
    // in 'queued' until the executor picks it up.
    const queue = store.listWithdrawalsByStatus('queued');
    expect(queue.length).toBeGreaterThanOrEqual(1);
    // VaultWithdrawal stores sharesBurned (not amountUsd directly). At
    // navPerShare=2, $50 / $2 = 25 shares; assert the implied USD value.
    const navPerShare = 100 / 50;
    const amountUsd = queue[0].sharesBurned * navPerShare;
    expect(amountUsd).toBeCloseTo(50, 1);
    expect(queue[0].telegramId).toBe(7);
    expect(queue[0].destination).toBe('A'.repeat(44));
    // Pending state should be cleared after the code consumes the action.
    expect(handlers.pendingFor(7)).toBeUndefined();

    state.close();
  });
});
