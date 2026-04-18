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
  // Pad each single-button-row label to a fixed ~30-char visible width
  // with regular spaces, centred around the real label. Some Telegram
  // clients size inline buttons to the text width and left-align them
  // in the row; a heavily-padded fixed-width label forces a consistent
  // wide button that visually centres the text regardless of client
  // rendering rules.
  const TARGET = 30;
  const center = (s: string): string => {
    // Count emoji as 2 visual cells (close enough for our labels).
    const visual = [...s].reduce((n, ch) => n + (ch.codePointAt(0)! > 0xffff ? 2 : 1), 0);
    const pad = Math.max(0, TARGET - visual);
    const left = Math.floor(pad / 2);
    const right = pad - left;
    return ' '.repeat(left) + s + ' '.repeat(right);
  };
  return {
    inline_keyboard: [
      [{ text: center('💰 Deposit'),   callback_data: 'act:deposit' }],
      [{ text: center('📊 Balance'),   callback_data: 'act:balance' }],
      [{ text: center('💸 Withdraw'),  callback_data: 'act:withdraw' }],
      [{ text: center('🎯 Whitelist'), callback_data: 'wl:set' }],
      [{ text: center('⚙️ Settings'),  callback_data: 'nav:settings' }],
      [{ text: center('📈 Stats'),     callback_data: 'act:stats' }],
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
