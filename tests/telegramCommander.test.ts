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

  it('accepts operator command from authorized user', async () => {
    const handler = vi.fn(async () => {});
    const commander = new TelegramCommander({
      botToken: 'tok', operatorUserId: 100, depositorStore: store,
    });
    commander.registerOperatorCommand('pause', handler);
    await commander.dispatch({ chatId: 100, userId: 100, text: '/pause', messageId: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('rejects operator command from unauthorized user', async () => {
    const handler = vi.fn(async () => {});
    const commander = new TelegramCommander({
      botToken: 'tok', operatorUserId: 100, depositorStore: store,
    });
    commander.registerOperatorCommand('pause', handler);
    await commander.dispatch({ chatId: 200, userId: 200, text: '/pause', messageId: 1 });
    expect(handler).not.toHaveBeenCalled();
  });

  // N3: group-chat operator scenarios
  it('N3: accepts operator command based on userId (group chat, non-matching chatId)', async () => {
    const handler = vi.fn(async () => {});
    const commander = new TelegramCommander({
      botToken: 'tok', operatorUserId: 42, depositorStore: store,
    });
    commander.registerOperatorCommand('pause', handler);
    // chatId=-100 (a group) but userId=42 (the operator)
    await commander.dispatch({ chatId: -100, userId: 42, text: '/pause', messageId: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('N3: rejects operator command when userId mismatches even if chatId matches', async () => {
    const handler = vi.fn(async () => {});
    const commander = new TelegramCommander({
      botToken: 'tok', operatorUserId: 42, depositorStore: store,
    });
    commander.registerOperatorCommand('pause', handler);
    // chatId happens to equal the operator user id, but the sender is a
    // different user (userId=99) — must still be rejected.
    await commander.dispatch({ chatId: 42, userId: 99, text: '/pause', messageId: 1 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('accepts vault command from a depositor user', async () => {
    store.createUser({ telegramId: 500, role: 'depositor', depositAddress: 'A',
      depositSecretEnc: Buffer.alloc(0), depositSecretIv: Buffer.alloc(0),
      disclaimerAt: 100, createdAt: 100 });
    const handler = vi.fn(async () => {});
    const commander = new TelegramCommander({
      botToken: 'tok', operatorUserId: 100, depositorStore: store,
    });
    commander.registerVaultCommand('balance', handler);
    await commander.dispatch({ chatId: 500, userId: 500, text: '/balance', messageId: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('rejects vault command from non-registered user', async () => {
    const handler = vi.fn(async () => {});
    const commander = new TelegramCommander({
      botToken: 'tok', operatorUserId: 100, depositorStore: store,
    });
    commander.registerVaultCommand('balance', handler);
    await commander.dispatch({ chatId: 999, userId: 999, text: '/balance', messageId: 1 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('public commands accept anyone', async () => {
    const handler = vi.fn(async () => {});
    const commander = new TelegramCommander({
      botToken: 'tok', operatorUserId: 100, depositorStore: store,
    });
    commander.registerPublicCommand('stats', handler);
    await commander.dispatch({ chatId: 999, userId: 999, text: '/stats', messageId: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('/account is accessible to anyone (pre-enrollment)', async () => {
    const handler = vi.fn(async () => {});
    const commander = new TelegramCommander({
      botToken: 'tok', operatorUserId: 100, depositorStore: store,
    });
    commander.registerEnrollmentCommand('account', handler);
    await commander.dispatch({ chatId: 999, userId: 999, text: '/account', messageId: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('TelegramCommander.reply — extras', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  it('passes reply_markup when keyboard is provided', async () => {
    const tg = new TelegramCommander({ botToken: 't', operatorUserId: 1, depositorStore: fakeStore() });
    await tg.reply(42, 'hi', { keyboard: { inline_keyboard: [[{ text: 'x', callback_data: 'nav:home' }]] } });
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.chat_id).toBe(42);
    expect(body.text).toBe('hi');
    expect(body.reply_markup).toEqual({ inline_keyboard: [[{ text: 'x', callback_data: 'nav:home' }]] });
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/sendMessage$/);
  });

  it('uses sendPhoto when photoBase64 provided', async () => {
    const tg = new TelegramCommander({ botToken: 't', operatorUserId: 1, depositorStore: fakeStore() });
    await tg.reply(42, 'caption', { photoBase64: 'aGVsbG8=' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/sendPhoto$/);
  });

  it('no extras → sendMessage with just chat_id + text (unchanged)', async () => {
    const tg = new TelegramCommander({ botToken: 't', operatorUserId: 1, depositorStore: fakeStore() });
    await tg.reply(42, 'hi');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ chat_id: 42, text: 'hi' });
  });

  it('sendPhoto branch includes reply_markup when both photo+keyboard provided', async () => {
    const tg = new TelegramCommander({ botToken: 't', operatorUserId: 1, depositorStore: fakeStore() });
    await tg.reply(42, 'cap', {
      photoBase64: 'aGVsbG8=',
      keyboard: { inline_keyboard: [[{ text: 'x', callback_data: 'cancel' }]] },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/sendPhoto$/);
    const form = fetchMock.mock.calls[0][1].body as FormData;
    expect(form.get('reply_markup')).toBe(JSON.stringify({ inline_keyboard: [[{ text: 'x', callback_data: 'cancel' }]] }));
    expect(form.get('chat_id')).toBe('42');
    expect(form.get('caption')).toBe('cap');
  });
});

function fakeStore() { return { getUser: () => null } as any; }

describe('TelegramCommander.answerCallbackQuery', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  it('POSTs to /answerCallbackQuery with the query id', async () => {
    const tg = new TelegramCommander({ botToken: 't', operatorUserId: 1, depositorStore: fakeStore() });
    await tg.answerCallbackQuery('abc123');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/answerCallbackQuery$/);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.callback_query_id).toBe('abc123');
  });

  it('swallows errors silently', async () => {
    const tg = new TelegramCommander({ botToken: 't', operatorUserId: 1, depositorStore: fakeStore() });
    fetchMock.mockRejectedValueOnce(new Error('network'));
    await expect(tg.answerCallbackQuery('x')).resolves.toBeUndefined();
  });
});

describe('TelegramCommander.dispatchCallback', () => {
  it('calls registered callback router with parsed query, then answers', async () => {
    const answers: string[] = [];
    const fetchMock = vi.fn(async (url: string, init: any) => {
      if (url.endsWith('/answerCallbackQuery')) {
        answers.push(JSON.parse(init.body).callback_query_id);
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const tg = new TelegramCommander({ botToken: 't', operatorUserId: 1, depositorStore: fakeStore() });
    const seen: any[] = [];
    tg.setCallbackRouter(async (q) => { seen.push(q); });
    await tg.dispatchCallback({
      id: 'q1',
      from: { id: 7 },
      message: { message_id: 10, chat: { id: 42 } },
      data: 'nav:home',
    });
    expect(seen).toEqual([{ id: 'q1', userId: 7, chatId: 42, data: 'nav:home' }]);
    expect(answers).toEqual(['q1']);
  });

  it('unknown data still answers the query but logs at warn', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const tg = new TelegramCommander({ botToken: 't', operatorUserId: 1, depositorStore: fakeStore() });
    // no router registered → dispatchCallback should still call answerCallbackQuery
    await tg.dispatchCallback({
      id: 'q2', from: { id: 7 }, message: { message_id: 1, chat: { id: 42 } }, data: 'xxx',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/answerCallbackQuery$/),
      expect.anything(),
    );
  });
});

describe('TelegramCommander — allowed_updates widening', () => {
  it('includes callback_query in getUpdates URL when setCallbackRouter has been called', async () => {
    const captured: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      captured.push(url);
      return { ok: true, json: async () => ({ ok: true, result: [] }) };
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const tg = new TelegramCommander({ botToken: 't', operatorUserId: 1, depositorStore: fakeStore() });
    tg.setCallbackRouter(async () => {});
    tg.start();
    // give the poll loop one tick
    await new Promise((r) => setTimeout(r, 50));
    tg.stop();
    expect(captured[0]).toMatch(/allowed_updates=%5B%22message%22%2C%22callback_query%22%5D/);
  });

  it('only ["message"] when no callback router registered', async () => {
    const captured: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      captured.push(url);
      return { ok: true, json: async () => ({ ok: true, result: [] }) };
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const tg = new TelegramCommander({ botToken: 't', operatorUserId: 1, depositorStore: fakeStore() });
    tg.start();
    await new Promise((r) => setTimeout(r, 50));
    tg.stop();
    expect(captured[0]).toMatch(/allowed_updates=%5B%22message%22%5D/);
    expect(captured[0]).not.toMatch(/callback_query/);
  });
});
