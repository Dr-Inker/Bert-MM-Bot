import type { InlineKeyboardButton, InlineKeyboardMarkup } from '../types.js';

// Callback-data budget: ≤ 32 chars per value (Telegram limit is 64 bytes).
// Namespaces (see spec §6):
//   nav:<dest>  act:<name>  wd:<preset>  wl:<op>  enr:<step>  cancel

export function welcomeKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: '🆕 Create account', callback_data: 'nav:create_account' },
      { text: '📈 Stats',           callback_data: 'act:stats' },
    ]],
  };
}

export function mainMenuKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '💰 Deposit',    callback_data: 'act:deposit' },
        { text: '📊 Balance',    callback_data: 'act:balance' },
      ],
      [
        { text: '💸 Withdraw',   callback_data: 'act:withdraw' },
        { text: '🎯 Whitelist',  callback_data: 'wl:set' },
      ],
      [
        { text: '⚙️ Settings',   callback_data: 'nav:settings' },
        { text: '📈 Stats',      callback_data: 'act:stats' },
      ],
    ],
  };
}

export function cancelKeyboard(): InlineKeyboardMarkup {
  return { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel' }]] };
}

export function disclaimerKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: '✅ I accept',  callback_data: 'enr:accept' },
      { text: '❌ Decline',   callback_data: 'enr:decline' },
    ]],
  };
}

export function settingsKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: '🎯 Set withdrawal address',    callback_data: 'wl:set' }],
      [{ text: '🚫 Cancel pending whitelist', callback_data: 'wl:cancel' }],
      [{ text: '🏠 Menu',                     callback_data: 'nav:home' }],
    ],
  };
}

export function withdrawAmountKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '25%',  callback_data: 'wd:p25' },
        { text: '50%',  callback_data: 'wd:p50' },
      ],
      [
        { text: '75%',  callback_data: 'wd:p75' },
        { text: '100%', callback_data: 'wd:p100' },
      ],
      [{ text: '💲 Custom USD',  callback_data: 'wd:custom' }],
      [{ text: '❌ Cancel',      callback_data: 'cancel' }],
    ],
  };
}

export function postDepositKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: '📊 Balance', callback_data: 'act:balance' },
      { text: '🏠 Menu',    callback_data: 'nav:home' },
    ]],
  };
}

export function postBalanceKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: '💸 Withdraw',     callback_data: 'act:withdraw' },
      { text: '💰 Deposit more', callback_data: 'act:deposit' },
      { text: '🏠 Menu',         callback_data: 'nav:home' },
    ]],
  };
}

export function postActionKeyboard(): InlineKeyboardMarkup {
  return { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'nav:home' }]] };
}

export function errorKeyboard(opts: { retryCallback?: string } = {}): InlineKeyboardMarkup {
  const row: InlineKeyboardButton[] = [];
  if (opts.retryCallback) row.push({ text: '🔙 Try again', callback_data: opts.retryCallback });
  row.push({ text: '🏠 Menu', callback_data: 'nav:home' });
  return { inline_keyboard: [row] };
}
