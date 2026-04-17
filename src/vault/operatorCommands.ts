import type { DepositorStore } from './depositorStore.js';
import type { StateStore } from '../stateStore.js';
import type { AuditLog } from './audit.js';
import type { ReplyFn } from './commands.js';
import { VAULT_PAUSED_FLAG } from './flags.js';

export interface OperatorCommandsDeps {
  store: DepositorStore;
  state: StateStore;
  audit: AuditLog;
  reply: ReplyFn;
  nowMs: () => number;
}

/**
 * Operator-only vault commands. All are assumed to have been authorized by
 * the caller (TelegramCommander.registerOperatorCommand gates on
 * `chatId === operatorChatId`). No further auth inside the handler.
 *
 *  /pausevault           — set `vault_paused=1` flag
 *  /resumevault          — clear the flag
 *  /vaultstatus          — TVL + shares + queued count + last NAV + last 5 audit
 *  /forceprocess <id>    — reset a failed withdrawal back to 'queued'
 */
export class OperatorCommandHandlers {
  constructor(private deps: OperatorCommandsDeps) {}

  async handlePause(msg: { chatId: number; userId: number }): Promise<void> {
    this.deps.state.setFlag(VAULT_PAUSED_FLAG, '1', 'operator /pausevault');
    this.deps.audit.write({
      ts: this.deps.nowMs(), telegramId: msg.userId, event: 'vault_paused',
    });
    await this.deps.reply(
      msg.chatId,
      'Vault paused. Withdrawals will not drain until /resumevault.',
    );
  }

  async handleResume(msg: { chatId: number; userId: number }): Promise<void> {
    // setFlag with empty string — keeps schema simple (no DELETE FROM flags).
    // Downstream readers should treat empty or missing as "not paused".
    this.deps.state.setFlag(VAULT_PAUSED_FLAG, '', 'operator /resumevault');
    this.deps.audit.write({
      ts: this.deps.nowMs(), telegramId: msg.userId, event: 'vault_resumed',
    });
    await this.deps.reply(
      msg.chatId,
      'Vault resumed. Withdrawals will drain on next tick.',
    );
  }

  async handleStatus(msg: { chatId: number; userId: number }): Promise<void> {
    const snap = this.deps.store.latestNavSnapshot();
    const totalShares = this.deps.store.totalShares();
    const queuedCount = this.deps.store.countPendingWithdrawals();
    const pendingWhitelist = this.deps.store.countPendingWhitelistChanges();
    const paused = (this.deps.state.getFlag(VAULT_PAUSED_FLAG) ?? '') === '1';
    const recent = this.deps.store.listRecentAuditEvents(5);

    const tvlStr = snap
      ? `$${snap.totalValueUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
      : '(no NAV snapshot yet)';
    const navStr = snap
      ? `$${snap.navPerShare.toFixed(6)}`
      : '—';
    const navAgeStr = snap
      ? new Date(snap.ts).toISOString()
      : '—';

    const auditLines = recent.length > 0
      ? recent.map((e) => {
          const when = new Date(e.ts).toISOString();
          const tid = e.telegramId === null ? '—' : String(e.telegramId);
          return `  ${when}  ${e.event}  (user ${tid})`;
        }).join('\n')
      : '  (no audit events yet)';

    const lines = [
      `Vault status`,
      `  paused: ${paused ? 'YES' : 'no'}`,
      `  TVL: ${tvlStr}`,
      `  total shares: ${totalShares}`,
      `  queued withdrawals: ${queuedCount}`,
      `  pending whitelist changes: ${pendingWhitelist}`,
      `  NAV/share: ${navStr}`,
      `  last NAV snapshot: ${navAgeStr}`,
      `Last 5 audit events:`,
      auditLines,
    ];
    await this.deps.reply(msg.chatId, lines.join('\n'));
  }

  async handleForceProcess(
    msg: { chatId: number; userId: number; text: string },
  ): Promise<void> {
    const parts = msg.text.trim().split(/\s+/);
    const raw = parts[1];
    if (!raw) {
      await this.deps.reply(
        msg.chatId,
        'Usage: /forceprocess <withdrawal-id>',
      );
      return;
    }
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) {
      await this.deps.reply(
        msg.chatId,
        `Invalid id '${raw}'. Usage: /forceprocess <withdrawal-id>`,
      );
      return;
    }
    const w = this.deps.store.getWithdrawalById(id);
    if (!w) {
      await this.deps.reply(msg.chatId, `Withdrawal #${id} not found.`);
      return;
    }
    if (w.status !== 'failed') {
      await this.deps.reply(
        msg.chatId,
        `Withdrawal #${id} is in status '${w.status}', not 'failed'. Only failed withdrawals can be requeued.`,
      );
      return;
    }
    this.deps.store.requeueFailedWithdrawal(id);
    this.deps.audit.write({
      ts: this.deps.nowMs(), telegramId: msg.userId, event: 'withdrawal_requeued',
      details: { id, previousReason: w.failureReason },
    });
    await this.deps.reply(
      msg.chatId,
      `Withdrawal #${id} reset to queued; will be retried on next drain.`,
    );
  }
}
