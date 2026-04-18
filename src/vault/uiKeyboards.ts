import type { InlineKeyboardMarkup } from '../types.js';

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
        { text: '💰 Deposit',  callback_data: 'act:deposit' },
        { text: '📊 Balance',  callback_data: 'act:balance' },
      ],
      [
        { text: '💸 Withdraw', callback_data: 'act:withdraw' },
        { text: '⚙️ Settings', callback_data: 'nav:settings' },
      ],
      [
        { text: '📈 Stats',    callback_data: 'act:stats' },
      ],
    ],
  };
}

export function cancelKeyboard(): InlineKeyboardMarkup {
  return { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel' }]] };
}
