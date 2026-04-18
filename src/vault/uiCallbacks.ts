import type { CommandHandlers, ReplyFn } from './commands.js';
import { settingsKeyboard, cancelKeyboard, postActionKeyboard } from './uiKeyboards.js';

interface RouterDeps {
  handlers: Pick<
    CommandHandlers,
    | 'handleMenu' | 'handleAccount' | 'handleAccept' | 'handleDecline'
    | 'handleDeposit' | 'handleBalance' | 'handleStats'
    | 'handleWithdraw' | 'handleSetWhitelist' | 'handleCancelWhitelist'
    | 'setPending' | 'clearPending'
  >;
  reply: ReplyFn;
}

/**
 * Construct a callback-data router that maps inline-keyboard taps to
 * CommandHandlers methods. Intended to be wired into the TelegramCommander
 * dispatchCallback hook in main.ts (T11). Unknown callback_data values are a
 * silent no-op — TelegramCommander.dispatchCallback already issues
 * answerCallbackQuery so the spinner clears regardless.
 */
export function makeCallbackRouter(deps: RouterDeps) {
  return async function route(q: {
    id: string;
    userId: number;
    chatId: number;
    data: string;
  }): Promise<void> {
    const { handlers, reply } = deps;
    const ctx = { chatId: q.chatId, userId: q.userId };
    switch (q.data) {
      case 'nav:home':           return handlers.handleMenu(ctx);
      case 'nav:create_account': return handlers.handleAccount(ctx);
      case 'nav:settings':
        await reply(q.chatId, 'Settings', { keyboard: settingsKeyboard() });
        return;

      case 'enr:accept':         return handlers.handleAccept(ctx);
      case 'enr:decline':        return handlers.handleDecline(ctx);

      case 'act:deposit':        return handlers.handleDeposit(ctx);
      case 'act:balance':        return handlers.handleBalance(ctx);
      case 'act:stats':          return handlers.handleStats(ctx);
      case 'act:withdraw':       return handlers.handleWithdraw({ ...ctx, text: '/withdraw' });

      case 'wd:p25':             return handlers.handleWithdraw({ ...ctx, text: '/withdraw 25%' });
      case 'wd:p50':             return handlers.handleWithdraw({ ...ctx, text: '/withdraw 50%' });
      case 'wd:p75':             return handlers.handleWithdraw({ ...ctx, text: '/withdraw 75%' });
      case 'wd:p100':            return handlers.handleWithdraw({ ...ctx, text: '/withdraw 100%' });
      case 'wd:custom':
        handlers.setPending(q.userId, { kind: 'withdraw_amount_entry' });
        await reply(
          q.chatId,
          'Reply with a USD amount (e.g., 25).',
          { keyboard: cancelKeyboard() },
        );
        return;

      case 'wl:set':
        handlers.setPending(q.userId, { kind: 'setwhitelist_address_entry' });
        await reply(
          q.chatId,
          'Paste the Solana address you want withdrawals sent to.\n(Must be a regular wallet, not a program account.)',
          { keyboard: cancelKeyboard() },
        );
        return;
      case 'wl:cancel':          return handlers.handleCancelWhitelist(ctx);

      case 'cancel':
        handlers.clearPending(q.userId);
        await reply(q.chatId, 'Cancelled.', { keyboard: postActionKeyboard() });
        return;

      default:
        // unknown — no-op; TelegramCommander.dispatchCallback already calls answerCallbackQuery
        return;
    }
  };
}
