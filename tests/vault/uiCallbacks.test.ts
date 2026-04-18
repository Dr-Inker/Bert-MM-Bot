import { describe, it, expect, vi } from 'vitest';
import { makeCallbackRouter } from '../../src/vault/uiCallbacks.js';

function makeMockHandlers() {
  return {
    handleMenu:            vi.fn(async () => {}),
    handleAccount:         vi.fn(async () => {}),
    handleAccept:          vi.fn(async () => {}),
    handleDecline:         vi.fn(async () => {}),
    handleDeposit:         vi.fn(async () => {}),
    handleBalance:         vi.fn(async () => {}),
    handleWithdraw:        vi.fn(async () => {}),
    handleSetWhitelist:    vi.fn(async () => {}),
    handleCancelWhitelist: vi.fn(async () => {}),
    handleStats:           vi.fn(async () => {}),
    setPending:            vi.fn(() => {}),
    clearPending:          vi.fn(() => {}),
  };
}

function makeMockReply() { return vi.fn(async () => {}); }

describe('uiCallbacks — routeCallback', () => {
  it('nav:home → handleMenu', async () => {
    const h = makeMockHandlers(); const reply = makeMockReply();
    const route = makeCallbackRouter({ handlers: h as any, reply });
    await route({ id: 'q', userId: 1, chatId: 2, data: 'nav:home' });
    expect(h.handleMenu).toHaveBeenCalledWith({ chatId: 2, userId: 1 });
  });

  it('nav:create_account → handleAccount', async () => {
    const h = makeMockHandlers(); const reply = makeMockReply();
    const route = makeCallbackRouter({ handlers: h as any, reply });
    await route({ id: 'q', userId: 1, chatId: 2, data: 'nav:create_account' });
    expect(h.handleAccount).toHaveBeenCalledWith({ chatId: 2, userId: 1 });
  });

  it('enr:accept → handleAccept', async () => {
    const h = makeMockHandlers(); const reply = makeMockReply();
    const route = makeCallbackRouter({ handlers: h as any, reply });
    await route({ id: 'q', userId: 1, chatId: 2, data: 'enr:accept' });
    expect(h.handleAccept).toHaveBeenCalledWith({ chatId: 2, userId: 1 });
  });

  it('act:deposit → handleDeposit', async () => {
    const h = makeMockHandlers(); const reply = makeMockReply();
    const route = makeCallbackRouter({ handlers: h as any, reply });
    await route({ id: 'q', userId: 1, chatId: 2, data: 'act:deposit' });
    expect(h.handleDeposit).toHaveBeenCalledWith({ chatId: 2, userId: 1 });
  });

  it('act:balance → handleBalance', async () => {
    const h = makeMockHandlers(); const reply = makeMockReply();
    const route = makeCallbackRouter({ handlers: h as any, reply });
    await route({ id: 'q', userId: 1, chatId: 2, data: 'act:balance' });
    expect(h.handleBalance).toHaveBeenCalledWith({ chatId: 2, userId: 1 });
  });

  it('act:stats → handleStats', async () => {
    const h = makeMockHandlers(); const reply = makeMockReply();
    const route = makeCallbackRouter({ handlers: h as any, reply });
    await route({ id: 'q', userId: 1, chatId: 2, data: 'act:stats' });
    expect(h.handleStats).toHaveBeenCalledWith({ chatId: 2, userId: 1 });
  });

  it('act:withdraw → handleWithdraw with empty text (triggers amount picker)', async () => {
    const h = makeMockHandlers(); const reply = makeMockReply();
    const route = makeCallbackRouter({ handlers: h as any, reply });
    await route({ id: 'q', userId: 1, chatId: 2, data: 'act:withdraw' });
    expect(h.handleWithdraw).toHaveBeenCalledWith({ chatId: 2, userId: 1, text: '/withdraw' });
  });

  it('wd:p50 → handleWithdraw("/withdraw 50%")', async () => {
    const h = makeMockHandlers(); const reply = makeMockReply();
    const route = makeCallbackRouter({ handlers: h as any, reply });
    await route({ id: 'q', userId: 1, chatId: 2, data: 'wd:p50' });
    expect(h.handleWithdraw).toHaveBeenCalledWith({ chatId: 2, userId: 1, text: '/withdraw 50%' });
  });

  it('wd:custom → setPending(withdraw_amount_entry) + reply prompt', async () => {
    const h = makeMockHandlers(); const reply = makeMockReply();
    const route = makeCallbackRouter({ handlers: h as any, reply });
    await route({ id: 'q', userId: 1, chatId: 2, data: 'wd:custom' });
    expect(h.setPending).toHaveBeenCalledWith(1, { kind: 'withdraw_amount_entry' });
    expect(reply).toHaveBeenCalledWith(2, expect.stringMatching(/USD amount/i), expect.anything());
  });

  it('wl:set → sets pending=setwhitelist_address_entry and prompts for address (does NOT call handleSetWhitelist)', async () => {
    const h = makeMockHandlers(); const reply = makeMockReply();
    const route = makeCallbackRouter({ handlers: h as any, reply });
    await route({ id: 'q', userId: 1, chatId: 2, data: 'wl:set' });
    expect(h.handleSetWhitelist).not.toHaveBeenCalled();
    expect(h.setPending).toHaveBeenCalledWith(1, { kind: 'setwhitelist_address_entry' });
    expect(reply).toHaveBeenCalledWith(
      2,
      expect.stringMatching(/paste the Solana address/i),
      expect.objectContaining({ keyboard: expect.anything() }),
    );
    // The keyboard should be a cancel-only keyboard.
    const kb = reply.mock.calls[0][2].keyboard;
    expect(kb.inline_keyboard.flat().map((b: any) => b.callback_data)).toEqual(['cancel']);
  });

  it('nav:settings → reply with settings keyboard', async () => {
    const h = makeMockHandlers(); const reply = makeMockReply();
    const route = makeCallbackRouter({ handlers: h as any, reply });
    await route({ id: 'q', userId: 1, chatId: 2, data: 'nav:settings' });
    expect(reply).toHaveBeenCalled();
    const kb = reply.mock.calls[0][2].keyboard;
    expect(kb.inline_keyboard.flat().map((b: any) => b.callback_data))
      .toEqual(['wl:set', 'wl:cancel', 'nav:home']);
  });

  it('cancel → clearPending + reply "Cancelled"', async () => {
    const h = makeMockHandlers(); const reply = makeMockReply();
    const route = makeCallbackRouter({ handlers: h as any, reply });
    await route({ id: 'q', userId: 1, chatId: 2, data: 'cancel' });
    expect(h.clearPending).toHaveBeenCalledWith(1);
    expect(reply).toHaveBeenCalled();
  });

  it('unknown callback_data → no-op (no handler called, no throw)', async () => {
    const h = makeMockHandlers(); const reply = makeMockReply();
    const route = makeCallbackRouter({ handlers: h as any, reply });
    await expect(route({ id: 'q', userId: 1, chatId: 2, data: 'totally-bogus' })).resolves.toBeUndefined();
    expect(h.handleMenu).not.toHaveBeenCalled();
  });
});
