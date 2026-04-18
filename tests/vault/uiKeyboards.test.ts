import { describe, it, expect } from 'vitest';
import {
  welcomeKeyboard,
  mainMenuKeyboard,
  cancelKeyboard,
} from '../../src/vault/uiKeyboards.js';
import {
  disclaimerKeyboard,
  settingsKeyboard,
  withdrawAmountKeyboard,
  postDepositKeyboard,
  postBalanceKeyboard,
  postActionKeyboard,
  errorKeyboard,
} from '../../src/vault/uiKeyboards.js';

describe('uiKeyboards — core', () => {
  it('welcomeKeyboard has [Create account] and [Stats] on one row', () => {
    const kb = welcomeKeyboard();
    expect(kb.inline_keyboard.length).toBe(1);
    expect(kb.inline_keyboard[0].map(b => b.callback_data)).toEqual([
      'nav:create_account',
      'act:stats',
    ]);
    expect(kb.inline_keyboard[0][0].text).toMatch(/Create account/i);
  });

  it('mainMenuKeyboard has 3 rows of 2 buttons (even 50/50 split)', () => {
    const kb = mainMenuKeyboard();
    expect(kb.inline_keyboard.length).toBe(3);
    for (const row of kb.inline_keyboard) expect(row.length).toBe(2);
    const flat = kb.inline_keyboard.flat().map(b => b.callback_data);
    expect(flat).toEqual([
      'act:deposit',  'act:balance',
      'act:withdraw', 'wl:set',
      'nav:settings', 'act:stats',
    ]);
    // Each half-row label is padded with non-breaking spaces so it
    // reads as centred and wider on clients that left-align button
    // text and/or trim regular whitespace.
    const NBSP = '\u00A0';
    for (const row of kb.inline_keyboard) {
      for (const btn of row) {
        expect(btn.text.startsWith(NBSP)).toBe(true);
        expect(btn.text.endsWith(NBSP)).toBe(true);
      }
    }
  });

  it('cancelKeyboard has single Cancel button with callback_data=cancel', () => {
    const kb = cancelKeyboard();
    expect(kb.inline_keyboard).toEqual([[{ text: expect.stringMatching(/Cancel/i), callback_data: 'cancel' }]]);
  });
});

describe('uiKeyboards — flow', () => {
  it('disclaimerKeyboard has [I accept] and [Decline]', () => {
    const kb = disclaimerKeyboard();
    const data = kb.inline_keyboard.flat().map(b => b.callback_data);
    expect(data).toEqual(['enr:accept', 'enr:decline']);
  });

  it('settingsKeyboard has Set Whitelist, Cancel Whitelist, Menu', () => {
    const kb = settingsKeyboard();
    const data = kb.inline_keyboard.flat().map(b => b.callback_data);
    expect(data).toEqual(['wl:set', 'wl:cancel', 'nav:home']);
  });

  it('withdrawAmountKeyboard has 25/50/75/100/custom/cancel', () => {
    const kb = withdrawAmountKeyboard();
    const data = kb.inline_keyboard.flat().map(b => b.callback_data);
    expect(data).toEqual(['wd:p25','wd:p50','wd:p75','wd:p100','wd:custom','cancel']);
  });

  it('postDepositKeyboard offers Balance + Home', () => {
    expect(postDepositKeyboard().inline_keyboard.flat().map(b => b.callback_data))
      .toEqual(['act:balance', 'nav:home']);
  });

  it('postBalanceKeyboard offers Withdraw, Deposit more, Home', () => {
    expect(postBalanceKeyboard().inline_keyboard.flat().map(b => b.callback_data))
      .toEqual(['act:withdraw', 'act:deposit', 'nav:home']);
  });

  it('postActionKeyboard is just Home', () => {
    expect(postActionKeyboard().inline_keyboard.flat().map(b => b.callback_data))
      .toEqual(['nav:home']);
  });

  it('errorKeyboard offers Try again + Home when retryable', () => {
    expect(errorKeyboard({ retryCallback: 'act:balance' }).inline_keyboard.flat().map(b => b.callback_data))
      .toEqual(['act:balance', 'nav:home']);
  });

  it('errorKeyboard without retryCallback is just Home', () => {
    expect(errorKeyboard().inline_keyboard.flat().map(b => b.callback_data))
      .toEqual(['nav:home']);
  });
});
