import type { DepositorStore } from './depositorStore.js';
import type { Enrollment } from './enrollment.js';
import type { Cooldowns } from './cooldowns.js';
import { DISCLAIMER_TEXT } from './disclaimer.js';
import { AuditLog } from './audit.js';

export interface ReplyFn {
  (chatId: number, text: string, extras?: { photoBase64?: string }): Promise<void>;
}

export interface CommandsConfig {
  withdrawalFeeBps: number;
  minWithdrawalUsd: number;
  maxDailyWithdrawalsPerUser: number;
  maxDailyWithdrawalUsdPerUser: number;
  maxPendingWithdrawals: number;
}

export interface CommandsDeps {
  store: DepositorStore;
  enrollment: Enrollment;
  cooldowns: Cooldowns;
  masterKey: Buffer;
  reply: ReplyFn;
  config: CommandsConfig;
  /**
   * Return the current total NAV (USD) and total shares. For /balance + /stats.
   * In main.ts this closes over venue + store.
   */
  getNav: () => { totalUsd: number; totalShares: number };
  nowMs: () => number;
}

/**
 * Ephemeral in-memory state keyed by telegramId. "Awaiting X" flag set by a
 * command; the user's next message (expected: a 6-digit TOTP code) consumes
 * it via handleMessage. Lost on restart; that's acceptable for MVP.
 */
export type PendingAction =
  | { kind: 'disclaimer' }
  | { kind: 'totp_setup_confirm' }
  | { kind: 'deposit_reveal' }
  | { kind: 'balance_reveal' }
  | { kind: 'withdraw'; amountUsd: number }
  | { kind: 'setwhitelist_first'; address: string }
  | { kind: 'setwhitelist_change'; address: string }
  | { kind: 'cancelwhitelist' };

export class CommandHandlers {
  private pending = new Map<number, PendingAction>();
  private audit: AuditLog;

  constructor(private deps: CommandsDeps) {
    this.audit = new AuditLog(deps.store);
  }

  /** Test accessor — returns what (if any) action is awaiting TOTP for this user. */
  pendingFor(userId: number): PendingAction | undefined {
    return this.pending.get(userId);
  }

  // ── /account ───────────────────────────────────────────────────────────
  async handleAccount(msg: { chatId: number; userId: number }): Promise<void> {
    const existing = this.deps.store.getUser(msg.userId);
    if (!existing) {
      this.pending.set(msg.userId, { kind: 'disclaimer' });
      await this.deps.reply(msg.chatId, DISCLAIMER_TEXT);
      return;
    }
    if (existing.totpEnrolledAt === null) {
      const { secretBase32 } = await this.deps.enrollment.beginTotpEnrollment({
        telegramId: msg.userId,
      });
      this.pending.set(msg.userId, { kind: 'totp_setup_confirm' });
      await this.deps.reply(
        msg.chatId,
        `Set up 2FA in Google Authenticator (or Authy).\n` +
          `Add a TOTP account with this text secret:\n\n` +
          `${secretBase32}\n\n` +
          `Then reply with the current 6-digit code to confirm.`,
      );
      return;
    }
    await this.deps.reply(
      msg.chatId,
      `Account ready. Commands:\n` +
        `/deposit — show your deposit address (TOTP)\n` +
        `/balance — show shares + USD value (TOTP)\n` +
        `/withdraw <usd|pct%> — queue a withdrawal (TOTP)\n` +
        `/setwhitelist <addr> — set withdrawal destination (TOTP)\n` +
        `/cancelwhitelist — cancel pending whitelist change (TOTP)\n` +
        `/stats — vault TVL + NAV/share`,
    );
  }
}
