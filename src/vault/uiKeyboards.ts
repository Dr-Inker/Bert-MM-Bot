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
  // 2 buttons per row. Telegram normally enforces 50/50 width split on
  // 2-button rows. Some clients (seen in testing) instead size each
  // button to its label text — which left-aligns narrow buttons and
  // makes them look tiny. To defend against that, pad each label to a
  // fixed width using **non-breaking spaces (U+00A0)**: these render
  // identical to regular spaces but are NOT whitespace per the strict
  // definition used by some Telegram clients' label trimmers, so they
  // survive the round trip and force a visibly wider button. Padding
  // is symmetric so the real text sits in the middle of its half-row
  // on left-aligning clients too.
  const TARGET = 32;        // visual cells per button label
  const NBSP = '\u00A0';
  const pad = (s: string): string => {
    const visual = [...s].reduce((n, ch) => n + (ch.codePointAt(0)! > 0xffff ? 2 : 1), 0);
    const n = Math.max(0, TARGET - visual);
    const left = Math.floor(n / 2);
    const right = n - left;
    return NBSP.repeat(left) + s + NBSP.repeat(right);
  };
  return {
    inline_keyboard: [
      [
        { text: pad('💰 Deposit'),   callback_data: 'act:deposit' },
        { text: pad('📊 Balance'),   callback_data: 'act:balance' },
      ],
      [
        { text: pad('💸 Withdraw'),  callback_data: 'act:withdraw' },
        { text: pad('🎯 Whitelist'), callback_data: 'wl:set' },
      ],
      [
        { text: pad('⚙️ Settings'),  callback_data: 'nav:settings' },
        { text: pad('📈 Stats'),     callback_data: 'act:stats' },
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
