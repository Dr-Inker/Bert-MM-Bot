import { describe, it, expect } from 'vitest';
import {
  welcomeKeyboard,
  mainMenuKeyboard,
  cancelKeyboard,
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

  it('mainMenuKeyboard has Deposit, Balance, Withdraw, Settings, Stats in 3 rows', () => {
    const kb = mainMenuKeyboard();
    expect(kb.inline_keyboard.length).toBe(3);
    const flat = kb.inline_keyboard.flat().map(b => b.callback_data);
    expect(flat).toEqual([
      'act:deposit',  'act:balance',
      'act:withdraw', 'nav:settings',
      'act:stats',
    ]);
  });

  it('cancelKeyboard has single Cancel button with callback_data=cancel', () => {
    const kb = cancelKeyboard();
    expect(kb.inline_keyboard).toEqual([[{ text: expect.stringMatching(/Cancel/i), callback_data: 'cancel' }]]);
  });
});
