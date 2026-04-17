import type { DepositorStore } from './depositorStore.js';
import type { Enrollment } from './enrollment.js';
import type { Cooldowns } from './cooldowns.js';
import { DISCLAIMER_TEXT } from './disclaimer.js';
import { AuditLog } from './audit.js';
import { decrypt } from './encryption.js';
import { verifyCode } from './totp.js';
import { computeNavPerShare, usdForShares } from './shareMath.js';
import { PublicKey } from '@solana/web3.js';

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

  // ── /deposit ───────────────────────────────────────────────────────────
  async handleDeposit(msg: { chatId: number; userId: number }): Promise<void> {
    const user = this.deps.store.getUser(msg.userId);
    if (!user || user.totpEnrolledAt === null) {
      await this.deps.reply(msg.chatId, 'Please enroll first via /account.');
      return;
    }
    this.pending.set(msg.userId, { kind: 'deposit_reveal' });
    await this.deps.reply(msg.chatId, 'Reply with your current 6-digit 2FA code to reveal your deposit address.');
  }

  /**
   * Consume the user's next plain-text message as the TOTP response to a
   * pending action. No-op if there is no pending action for the user.
   * Returns after dispatching to the appropriate branch.
   */
  async handleMessage(msg: { chatId: number; userId: number; text: string }): Promise<void> {
    const pending = this.pending.get(msg.userId);
    if (!pending) return;

    switch (pending.kind) {
      case 'deposit_reveal':
        await this.respondDepositReveal(msg);
        return;
      case 'balance_reveal':
        await this.respondBalanceReveal(msg);
        return;
      case 'setwhitelist_first':
      case 'setwhitelist_change':
        await this.respondSetWhitelist(msg, pending);
        return;
      case 'cancelwhitelist':
        await this.respondCancelWhitelist(msg);
        return;
      default:
        // Other branches wired in later sub-steps. Drop the pending entry to
        // avoid leaking state if we hit an unhandled branch in dev.
        return;
    }
  }

  /**
   * Verify the TOTP code in `msg.text` for `msg.userId`. On success, persist
   * the new counter and return the accepted counter. On failure, return null.
   * Always clears any pending action for the user.
   */
  private verifyTotp(userId: number, code: string): { ok: boolean } {
    const user = this.deps.store.getUser(userId);
    if (!user || user.totpEnrolledAt === null) return { ok: false };
    const secrets = this.deps.store.getUserSecrets(userId);
    if (!secrets || !secrets.totpSecretEnc || !secrets.totpSecretIv) return { ok: false };
    const secretBase32 = decrypt(
      secrets.totpSecretEnc,
      secrets.totpSecretIv,
      this.deps.masterKey,
    ).toString('utf8');
    const r = verifyCode({
      secret: secretBase32,
      code,
      lastUsedCounter: user.totpLastUsedCounter,
    });
    if (!r.ok) return { ok: false };
    this.deps.store.setTotpLastCounter(userId, r.counter);
    return { ok: true };
  }

  // ── /balance ───────────────────────────────────────────────────────────
  async handleBalance(msg: { chatId: number; userId: number }): Promise<void> {
    const user = this.deps.store.getUser(msg.userId);
    if (!user || user.totpEnrolledAt === null) {
      await this.deps.reply(msg.chatId, 'Please enroll first via /account.');
      return;
    }
    this.pending.set(msg.userId, { kind: 'balance_reveal' });
    await this.deps.reply(msg.chatId, 'Reply with your current 6-digit 2FA code to view your balance.');
  }

  private async respondBalanceReveal(msg: { chatId: number; userId: number; text: string }): Promise<void> {
    this.pending.delete(msg.userId);
    const v = this.verifyTotp(msg.userId, msg.text.trim());
    if (!v.ok) {
      this.audit.write({
        ts: this.deps.nowMs(), telegramId: msg.userId,
        event: 'totp_verify_failed', details: { op: 'balance_reveal' },
      });
      await this.deps.reply(msg.chatId, '2FA code invalid. Try /balance again.');
      return;
    }
    const shares = this.deps.store.getShares(msg.userId);
    const nav = this.deps.getNav();
    const navPerShare = computeNavPerShare({ totalUsd: nav.totalUsd, totalShares: nav.totalShares });
    const usd = usdForShares({ netShares: shares, navPerShare });
    this.audit.write({
      ts: this.deps.nowMs(), telegramId: msg.userId, event: 'balance_reveal',
      details: { shares, navPerShare, usd },
    });
    await this.deps.reply(
      msg.chatId,
      `${shares.toFixed(2)} shares — approx $${usd.toFixed(2)}\n(NAV/share: $${navPerShare.toFixed(6)})`,
    );
  }

  // ── /setwhitelist ─────────────────────────────────────────────────────
  async handleSetWhitelist(msg: { chatId: number; userId: number; text: string }): Promise<void> {
    const user = this.deps.store.getUser(msg.userId);
    if (!user || user.totpEnrolledAt === null) {
      await this.deps.reply(msg.chatId, 'Please enroll first via /account.');
      return;
    }
    const parts = msg.text.trim().split(/\s+/);
    const addr = parts[1];
    if (!addr) {
      await this.deps.reply(msg.chatId, 'Usage: /setwhitelist <solana-address>');
      return;
    }
    try {
      // eslint-disable-next-line no-new
      new PublicKey(addr);
    } catch {
      await this.deps.reply(msg.chatId, 'That does not look like a valid Solana address.');
      return;
    }
    if (user.whitelistAddress === null) {
      this.pending.set(msg.userId, { kind: 'setwhitelist_first', address: addr });
      await this.deps.reply(
        msg.chatId,
        `First whitelist setup. Reply with your 2FA code to set ${addr} immediately.`,
      );
    } else {
      this.pending.set(msg.userId, { kind: 'setwhitelist_change', address: addr });
      await this.deps.reply(
        msg.chatId,
        `Whitelist change requested: ${addr}.\n` +
          `Reply with your 2FA code to enqueue. Changes activate after a 24-hour cooldown; ` +
          `use /cancelwhitelist before it activates to abort.`,
      );
    }
  }

  // ── /cancelwhitelist ──────────────────────────────────────────────────
  async handleCancelWhitelist(msg: { chatId: number; userId: number }): Promise<void> {
    const user = this.deps.store.getUser(msg.userId);
    if (!user || user.totpEnrolledAt === null) {
      await this.deps.reply(msg.chatId, 'Please enroll first via /account.');
      return;
    }
    this.pending.set(msg.userId, { kind: 'cancelwhitelist' });
    await this.deps.reply(msg.chatId, 'Reply with your 2FA code to cancel the pending whitelist change.');
  }

  private async respondSetWhitelist(
    msg: { chatId: number; userId: number; text: string },
    pending: Extract<PendingAction, { kind: 'setwhitelist_first' | 'setwhitelist_change' }>,
  ): Promise<void> {
    this.pending.delete(msg.userId);
    const v = this.verifyTotp(msg.userId, msg.text.trim());
    if (!v.ok) {
      this.audit.write({
        ts: this.deps.nowMs(), telegramId: msg.userId,
        event: 'totp_verify_failed', details: { op: pending.kind },
      });
      await this.deps.reply(msg.chatId, '2FA code invalid. Try /setwhitelist again.');
      return;
    }
    const result = this.deps.cooldowns.requestChange({
      telegramId: msg.userId, newAddress: pending.address, now: this.deps.nowMs(),
    });
    this.audit.write({
      ts: this.deps.nowMs(), telegramId: msg.userId, event: 'whitelist_set',
      details: { address: pending.address, immediate: result.immediate, activatesAt: result.activatesAt },
    });
    if (result.immediate) {
      await this.deps.reply(msg.chatId, `Whitelist set to ${pending.address} (effective immediately).`);
    } else {
      const activates = new Date(result.activatesAt).toISOString();
      await this.deps.reply(
        msg.chatId,
        `Whitelist change queued. Activates at ${activates}. Use /cancelwhitelist to abort before then.`,
      );
    }
  }

  private async respondCancelWhitelist(
    msg: { chatId: number; userId: number; text: string },
  ): Promise<void> {
    this.pending.delete(msg.userId);
    const v = this.verifyTotp(msg.userId, msg.text.trim());
    if (!v.ok) {
      this.audit.write({
        ts: this.deps.nowMs(), telegramId: msg.userId,
        event: 'totp_verify_failed', details: { op: 'cancelwhitelist' },
      });
      await this.deps.reply(msg.chatId, '2FA code invalid. Try /cancelwhitelist again.');
      return;
    }
    const ok = this.deps.cooldowns.cancelPending({
      telegramId: msg.userId, reason: 'user', now: this.deps.nowMs(),
    });
    this.audit.write({
      ts: this.deps.nowMs(), telegramId: msg.userId, event: 'whitelist_cancel',
      details: { cancelled: ok },
    });
    await this.deps.reply(
      msg.chatId,
      ok ? 'Pending whitelist change cancelled.' : 'Nothing to cancel — no pending whitelist change.',
    );
  }

  private async respondDepositReveal(msg: { chatId: number; userId: number; text: string }): Promise<void> {
    this.pending.delete(msg.userId);
    const v = this.verifyTotp(msg.userId, msg.text.trim());
    if (!v.ok) {
      this.audit.write({
        ts: this.deps.nowMs(), telegramId: msg.userId,
        event: 'totp_verify_failed', details: { op: 'deposit_reveal' },
      });
      await this.deps.reply(msg.chatId, '2FA code invalid. Try /deposit again.');
      return;
    }
    const user = this.deps.store.getUser(msg.userId)!;
    this.audit.write({
      ts: this.deps.nowMs(), telegramId: msg.userId, event: 'deposit_reveal',
    });
    await this.deps.reply(
      msg.chatId,
      `Your deposit address (SOL + BERT):\n${user.depositAddress}\n\n` +
        `Send SOL and/or BERT to this address. Funds will be swept + credited after the next tick.`,
    );
  }
}
