import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StateStore } from '../src/stateStore.js';
import { DepositorStore } from '../src/vault/depositorStore.js';
import { TelegramCommander } from '../src/telegramCommander.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('TelegramCommander auth', () => {
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

  it('accepts operator command from authorized chat', async () => {
    const handler = vi.fn(async () => {});
    const commander = new TelegramCommander({
      botToken: 'tok', operatorChatId: 100, depositorStore: store,
    });
    commander.registerOperatorCommand('pause', handler);
    await commander.dispatch({ chatId: 100, userId: 100, text: '/pause', messageId: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('rejects operator command from unauthorized chat', async () => {
    const handler = vi.fn(async () => {});
    const commander = new TelegramCommander({
      botToken: 'tok', operatorChatId: 100, depositorStore: store,
    });
    commander.registerOperatorCommand('pause', handler);
    await commander.dispatch({ chatId: 200, userId: 200, text: '/pause', messageId: 1 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('accepts vault command from a depositor user', async () => {
    store.createUser({ telegramId: 500, role: 'depositor', depositAddress: 'A',
      depositSecretEnc: Buffer.alloc(0), depositSecretIv: Buffer.alloc(0),
      disclaimerAt: 100, createdAt: 100 });
    const handler = vi.fn(async () => {});
    const commander = new TelegramCommander({
      botToken: 'tok', operatorChatId: 100, depositorStore: store,
    });
    commander.registerVaultCommand('balance', handler);
    await commander.dispatch({ chatId: 500, userId: 500, text: '/balance', messageId: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('rejects vault command from non-registered user', async () => {
    const handler = vi.fn(async () => {});
    const commander = new TelegramCommander({
      botToken: 'tok', operatorChatId: 100, depositorStore: store,
    });
    commander.registerVaultCommand('balance', handler);
    await commander.dispatch({ chatId: 999, userId: 999, text: '/balance', messageId: 1 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('public commands accept anyone', async () => {
    const handler = vi.fn(async () => {});
    const commander = new TelegramCommander({
      botToken: 'tok', operatorChatId: 100, depositorStore: store,
    });
    commander.registerPublicCommand('stats', handler);
    await commander.dispatch({ chatId: 999, userId: 999, text: '/stats', messageId: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('/account is accessible to anyone (pre-enrollment)', async () => {
    const handler = vi.fn(async () => {});
    const commander = new TelegramCommander({
      botToken: 'tok', operatorChatId: 100, depositorStore: store,
    });
    commander.registerEnrollmentCommand('account', handler);
    await commander.dispatch({ chatId: 999, userId: 999, text: '/account', messageId: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
