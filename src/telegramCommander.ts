import { logger } from './logger.js';
import type { InlineKeyboardMarkup } from './types.js';
import type { DepositorStore } from './vault/depositorStore.js';

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_S = 30;

/**
 * Incoming Telegram message (post-parsing) handed to command handlers.
 */
export interface IncomingMessage {
  chatId: number;
  userId: number;
  text: string;
  messageId: number;
}

export type CommandHandler = (msg: IncomingMessage) => Promise<void>;

type Kind = 'operator' | 'vault' | 'public' | 'enrollment';

export interface TelegramCommanderDeps {
  botToken: string;
  /**
   * Telegram **user id** of the operator. Commands of kind 'operator' are
   * authorized by `msg.userId === operatorUserId`, which works in both
   * private DMs (userId == chatId) and group chats (userId !== chatId).
   *
   * When the vault is enabled, main.ts sources this from
   * `cfg.vault.operatorTelegramId`. When only the MM bot is running, it
   * falls back to `cfg.notifier.telegram.chatIdInfo` (which for private-DM
   * deployments is the same as the operator's user id).
   */
  operatorUserId: number;
  depositorStore: DepositorStore;
}

/**
 * Listens for Telegram bot commands via long-polling (getUpdates) and
 * dispatches to handlers registered on a command registry.
 *
 * Authorization kinds:
 *  - operator:   requires userId === operatorUserId
 *  - vault:      requires depositorStore.getUser(userId) exists
 *  - public:     anyone
 *  - enrollment: anyone (e.g. /account, the enrollment entry point)
 */
export class TelegramCommander {
  private offset = 0;
  private running = false;
  private readonly botToken: string;
  private readonly operatorUserId: number;
  private readonly depositorStore: DepositorStore;
  private handlers = new Map<string, { kind: Kind; fn: CommandHandler }>();
  private fallback: CommandHandler | null = null;

  constructor(deps: TelegramCommanderDeps) {
    this.botToken = deps.botToken;
    this.operatorUserId = deps.operatorUserId;
    this.depositorStore = deps.depositorStore;
  }

  registerOperatorCommand(name: string, fn: CommandHandler): void {
    this.handlers.set(name.toLowerCase(), { kind: 'operator', fn });
  }

  registerVaultCommand(name: string, fn: CommandHandler): void {
    this.handlers.set(name.toLowerCase(), { kind: 'vault', fn });
  }

  registerPublicCommand(name: string, fn: CommandHandler): void {
    this.handlers.set(name.toLowerCase(), { kind: 'public', fn });
  }

  registerEnrollmentCommand(name: string, fn: CommandHandler): void {
    this.handlers.set(name.toLowerCase(), { kind: 'enrollment', fn });
  }

  /**
   * Register a fallback handler invoked when the user sends a non-command
   * plain-text message (no leading `/`). Used by vault commands to consume
   * TOTP-code replies against a pending action. Only called for users that
   * have a vault row (registered depositors).
   */
  registerFallback(fn: CommandHandler): void {
    this.fallback = fn;
  }

  /**
   * Authorize and dispatch a parsed command. Returns silently when the text
   * is not a recognized command or the caller is not authorized.
   */
  async dispatch(msg: IncomingMessage): Promise<void> {
    const match = msg.text.match(/^\/([a-z_]+)(?:\s|$)/i);
    if (!match || !match[1]) {
      // Non-command message: route to fallback if set + user is a registered
      // depositor. (TOTP replies to pending vault actions.)
      if (this.fallback) {
        const user = this.depositorStore.getUser(msg.userId);
        if (user) {
          await this.fallback(msg);
        }
      }
      return;
    }
    const name = match[1].toLowerCase();
    const h = this.handlers.get(name);
    if (!h) return;

    switch (h.kind) {
      case 'public':
      case 'enrollment':
        await h.fn(msg);
        return;
      case 'operator':
        // N3: authorize on user id, not chat id. Works in private DMs and in
        // group chats (where chatId is the group's negative id but userId is
        // still the sender). Aligns with how vault commands authenticate.
        if (msg.userId === this.operatorUserId) {
          await h.fn(msg);
        } else {
          logger.warn(
            { chatId: msg.chatId, userId: msg.userId, cmd: name },
            'telegram operator command from unauthorized user',
          );
        }
        return;
      case 'vault': {
        const user = this.depositorStore.getUser(msg.userId);
        if (user) {
          await h.fn(msg);
        } else {
          logger.warn({ userId: msg.userId, cmd: name }, 'telegram vault command from non-registered user');
        }
        return;
      }
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    logger.info({ registered: Array.from(this.handlers.keys()) }, 'telegram commander started');
    this.pollLoop();
  }

  stop(): void {
    this.running = false;
  }

  /** Send a reply to the given chat. Public so handlers registered from main.ts can use it.
   *  Optionally attaches an inline keyboard (reply_markup) and/or sends as a photo caption.
   *  When photoBase64 is provided, the Bot API endpoint switches from sendMessage to sendPhoto. */
  async reply(
    chatId: number,
    text: string,
    extras?: { keyboard?: InlineKeyboardMarkup; photoBase64?: string },
  ): Promise<void> {
    const keyboard = extras?.keyboard;
    const photoBase64 = extras?.photoBase64;
    try {
      if (photoBase64) {
        const form = new FormData();
        form.append('chat_id', String(chatId));
        form.append('caption', text);
        const bytes = Buffer.from(photoBase64, 'base64');
        form.append('photo', new Blob([bytes]), 'qr.png');
        if (keyboard) form.append('reply_markup', JSON.stringify(keyboard));
        const res = await fetch(`https://api.telegram.org/bot${this.botToken}/sendPhoto`, {
          method: 'POST',
          body: form,
        });
        if (!res.ok) logger.warn({ status: res.status, endpoint: 'sendPhoto' }, 'telegram reply non-2xx');
      } else {
        const body: Record<string, unknown> = { chat_id: chatId, text };
        if (keyboard) body.reply_markup = keyboard;
        const res = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) logger.warn({ status: res.status, endpoint: 'sendMessage' }, 'telegram reply non-2xx');
      }
    } catch (e) {
      logger.warn({ err: e }, 'telegram commander reply failed');
    }
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const url = `https://api.telegram.org/bot${this.botToken}/getUpdates?offset=${this.offset}&timeout=${POLL_TIMEOUT_S}&allowed_updates=["message"]`;
        const res = await fetch(url, { signal: AbortSignal.timeout((POLL_TIMEOUT_S + 5) * 1000) });
        if (!res.ok) {
          logger.warn({ status: res.status }, 'telegram getUpdates non-2xx');
          await sleep(POLL_INTERVAL_MS);
          continue;
        }

        const data = (await res.json()) as {
          ok: boolean;
          result: Array<{
            update_id: number;
            message?: {
              message_id: number;
              chat: { id: number };
              from?: { id: number };
              text?: string;
            };
          }>;
        };

        if (!data.ok || !data.result) {
          await sleep(POLL_INTERVAL_MS);
          continue;
        }

        for (const update of data.result) {
          this.offset = update.update_id + 1;
          const msg = update.message;
          if (!msg?.text) continue;

          // Prefer from.id (user) for vault-kind auth; fall back to chat.id for
          // private chats where they're equal anyway.
          const userId = msg.from?.id ?? msg.chat.id;
          await this.dispatch({
            chatId: msg.chat.id,
            userId,
            text: msg.text.trim(),
            messageId: msg.message_id,
          });
        }
      } catch (e) {
        logger.warn({ err: e }, 'telegram commander poll error');
        await sleep(POLL_INTERVAL_MS);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
