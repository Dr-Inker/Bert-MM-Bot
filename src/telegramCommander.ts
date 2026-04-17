import { logger } from './logger.js';
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
  operatorChatId: number;
  depositorStore: DepositorStore;
}

/**
 * Listens for Telegram bot commands via long-polling (getUpdates) and
 * dispatches to handlers registered on a command registry.
 *
 * Authorization kinds:
 *  - operator:   requires chatId === operatorChatId
 *  - vault:      requires depositorStore.getUser(userId) exists
 *  - public:     anyone
 *  - enrollment: anyone (e.g. /account, the enrollment entry point)
 */
export class TelegramCommander {
  private offset = 0;
  private running = false;
  private readonly botToken: string;
  private readonly operatorChatId: number;
  private readonly depositorStore: DepositorStore;
  private handlers = new Map<string, { kind: Kind; fn: CommandHandler }>();

  constructor(deps: TelegramCommanderDeps) {
    this.botToken = deps.botToken;
    this.operatorChatId = deps.operatorChatId;
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
   * Authorize and dispatch a parsed command. Returns silently when the text
   * is not a recognized command or the caller is not authorized.
   */
  async dispatch(msg: IncomingMessage): Promise<void> {
    const match = msg.text.match(/^\/([a-z_]+)(?:\s|$)/i);
    if (!match || !match[1]) return;
    const name = match[1].toLowerCase();
    const h = this.handlers.get(name);
    if (!h) return;

    switch (h.kind) {
      case 'public':
      case 'enrollment':
        await h.fn(msg);
        return;
      case 'operator':
        if (msg.chatId === this.operatorChatId) {
          await h.fn(msg);
        } else {
          logger.warn({ chatId: msg.chatId, cmd: name }, 'telegram operator command from unauthorized chat');
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

  /** Send a reply to the given chat. Public so handlers registered from main.ts can use it. */
  async reply(chatId: number, text: string): Promise<void> {
    try {
      await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
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
