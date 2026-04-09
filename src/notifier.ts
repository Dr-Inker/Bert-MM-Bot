import { logger } from './logger.js';

export type Severity = 'INFO' | 'WARN' | 'CRITICAL';

export interface NotifierChannels {
  telegram?: { botToken: string; chatIdInfo: string; chatIdCritical: string };
  discord?: { webhookInfo: string; webhookCritical: string };
}

export class Notifier {
  constructor(private readonly channels: NotifierChannels) {}

  async send(sev: Severity, message: string): Promise<void> {
    const text = `[${sev}] ${new Date().toISOString()}\n${message}`;
    const critical = sev === 'CRITICAL';
    const tasks: Promise<unknown>[] = [];

    if (this.channels.discord) {
      const url = critical
        ? this.channels.discord.webhookCritical
        : this.channels.discord.webhookInfo;
      tasks.push(this.postDiscord(url, text));
    }
    if (this.channels.telegram) {
      const chatId = critical
        ? this.channels.telegram.chatIdCritical
        : this.channels.telegram.chatIdInfo;
      tasks.push(this.postTelegram(this.channels.telegram.botToken, chatId, text));
    }

    await Promise.allSettled(tasks);
  }

  private async postDiscord(url: string, content: string): Promise<void> {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) logger.warn({ status: res.status }, 'discord webhook non-2xx');
    } catch (e) {
      logger.warn({ err: e }, 'discord webhook post failed');
    }
  }

  private async postTelegram(token: string, chatId: string, text: string): Promise<void> {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
      if (!res.ok) logger.warn({ status: res.status }, 'telegram send failed');
    } catch (e) {
      logger.warn({ err: e }, 'telegram send threw');
    }
  }
}
