import { readFileSync, writeFileSync } from 'node:fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { logger } from './logger.js';
import type { StateStore } from './stateStore.js';

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_S = 30;

/**
 * Listens for Telegram bot commands via long-polling (getUpdates).
 * Supported commands: /pause, /resume, /status
 *
 * Only responds to messages from the authorized chat ID.
 */
export class TelegramCommander {
  private offset = 0;
  private running = false;

  constructor(
    private readonly botToken: string,
    private readonly authorizedChatId: string,
    private readonly configPath: string,
    private readonly state: StateStore,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    logger.info('telegram commander started — listening for /pause, /resume, /status');
    this.pollLoop();
  }

  stop(): void {
    this.running = false;
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
            message?: { chat: { id: number }; text?: string };
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

          // Only respond to authorized chat
          if (String(msg.chat.id) !== this.authorizedChatId) {
            logger.warn({ chatId: msg.chat.id }, 'telegram command from unauthorized chat');
            continue;
          }

          const cmd = msg.text.trim().toLowerCase().split(/\s/)[0] ?? '';
          if (cmd) await this.handleCommand(cmd, msg.chat.id);
        }
      } catch (e) {
        logger.warn({ err: e }, 'telegram commander poll error');
        await sleep(POLL_INTERVAL_MS);
      }
    }
  }

  private async handleCommand(cmd: string, chatId: number): Promise<void> {
    switch (cmd) {
      case '/pause':
        this.setEnabled(false);
        await this.reply(chatId, '⏸ Bot PAUSED. Position stays open but no rebalances will occur. Send /resume to re-enable.');
        logger.info('bot paused via telegram command');
        break;

      case '/resume':
        this.setEnabled(true);
        this.state.setDegraded(false, 'cleared via telegram /resume');
        await this.reply(chatId, '▶️ Bot RESUMED. Degraded flag also cleared.');
        logger.info('bot resumed via telegram command');
        break;

      case '/status': {
        const pos = this.state.getCurrentPosition();
        const degraded = this.state.isDegraded();
        const enabled = this.isEnabled();
        const rebalancesToday = this.state.getRebalancesToday(Date.now());
        const lines = [
          enabled ? '🟢 Enabled' : '🔴 Paused',
          degraded ? '🟡 DEGRADED' : '✅ Healthy',
          `Position: ${pos ? pos.nftMint.slice(0, 8) + '...' : 'none'}`,
          pos ? `Range: $${pos.lowerUsd.toFixed(6)} – $${pos.upperUsd.toFixed(6)}` : '',
          `Rebalances today: ${rebalancesToday}`,
        ].filter(Boolean);
        await this.reply(chatId, lines.join('\n'));
        break;
      }

      case '/help':
        await this.reply(chatId, [
          'Commands:',
          '/pause — stop rebalancing (position stays open)',
          '/resume — re-enable bot + clear degraded flag',
          '/status — show current state',
          '/help — this message',
        ].join('\n'));
        break;

      default:
        // Ignore non-command messages
        break;
    }
  }

  private setEnabled(enabled: boolean): void {
    try {
      const raw = readFileSync(this.configPath, 'utf8');
      const doc = parseYaml(raw) as Record<string, unknown>;
      doc['enabled'] = enabled;
      writeFileSync(this.configPath, stringifyYaml(doc));
      const action = enabled ? 'resume' : 'pause';
      this.state.recordOperatorAction({ ts: Date.now(), command: `telegram:${action}`, osUser: 'telegram' });
    } catch (e) {
      logger.error({ err: e }, 'telegram commander: failed to update config');
    }
  }

  private isEnabled(): boolean {
    try {
      const raw = readFileSync(this.configPath, 'utf8');
      const doc = parseYaml(raw) as Record<string, unknown>;
      return doc['enabled'] !== false;
    } catch {
      return true;
    }
  }

  private async reply(chatId: number, text: string): Promise<void> {
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
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
