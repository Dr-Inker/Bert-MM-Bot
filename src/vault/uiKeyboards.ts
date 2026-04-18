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
  // One button per row, each label padded to ~24 visible chars with
  // leading+trailing U+2003 em spaces. Some Telegram clients size inline
  // buttons to the text width and left-align them in the row; padding
  // forces a consistent, wider button that *looks* centered on every
  // client (native-centered clients are unaffected since they already
  // centre the already-padded text).
  const PAD_BEFORE = '\u2003\u2003\u2003';   // 3 em-spaces = wide margin
  const PAD_AFTER  = '\u2003\u2003\u2003';
  const pad = (label: string) => `${PAD_BEFORE}${label}${PAD_AFTER}`;
  return {
    inline_keyboard: [
      [{ text: pad('💰 Deposit'),   callback_data: 'act:deposit' }],
      [{ text: pad('📊 Balance'),   callback_data: 'act:balance' }],
      [{ text: pad('💸 Withdraw'),  callback_data: 'act:withdraw' }],
      [{ text: pad('🎯 Whitelist'), callback_data: 'wl:set' }],
      [{ text: pad('⚙️ Settings'),  callback_data: 'nav:settings' }],
      [{ text: pad('📈 Stats'),     callback_data: 'act:stats' }],
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
