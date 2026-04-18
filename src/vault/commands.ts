import type { DepositorStore } from './depositorStore.js';
import type { Enrollment } from './enrollment.js';
import type { Cooldowns } from './cooldowns.js';
import type { InlineKeyboardMarkup } from '../types.js';
import { DISCLAIMER_TEXT } from './disclaimer.js';
import { AuditLog } from './audit.js';
import { decrypt } from './encryption.js';
import { verifyCode } from './totp.js';
import { computeNavPerShare, usdForShares, splitFee } from './shareMath.js';
import { TotpRateLimiter, formatLockoutRemaining } from './rateLimiter.js';
import {
  welcomeKeyboard,
  mainMenuKeyboard,
  disclaimerKeyboard,
  cancelKeyboard,
  errorKeyboard,
  postDepositKeyboard,
  postBalanceKeyboard,
  postActionKeyboard,
  withdrawAmountKeyboard,
} from './uiKeyboards.js';
import { PublicKey } from '@solana/web3.js';
import QRCode from 'qrcode';

export interface ReplyFn {
  (chatId: number, text: string, extras?: { photoBase64?: string; keyboard?: InlineKeyboardMarkup }): Promise<void>;
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
   * In main.ts this closes over venue + store and computes a LIVE NAV (fresh
   * balance + position value + current mid) rather than the last snapshot —
   * see N6 in the security review. Falls back to the latest snapshot when
   * any dependency (RPC, oracle) is momentarily unavailable.
   */
  getNav: () => Promise<{ totalUsd: number; totalShares: number } | null>;
  nowMs: () => number;
  /**
   * Optional TOTP rate limiter. If omitted, a limiter with default
   * parameters (5 failures / 15-min rolling window → 15-min lockout) is
   * constructed. Tests may inject a custom limiter to tune window/threshold.
   */
  totpRateLimiter?: TotpRateLimiter;
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
  | { kind: 'withdraw_amount_entry' }              // NEW: awaiting free-text USD amount
  | { kind: 'withdraw'; amountUsd: number }
  | { kind: 'setwhitelist_first'; address: string }
  | { kind: 'setwhitelist_change'; address: string }
  | { kind: 'cancelwhitelist' };

/** Maximum consecutive invalid TOTP codes during enrollment confirm before we
 *  clear pending and tell the user to start over via /account. Prevents a
 *  stuck session and (very lightly) raises the cost of brute-forcing. */
const TOTP_SETUP_MAX_FAILURES = 5;

export class CommandHandlers {
  private pending = new Map<number, PendingAction>();
  private totpSetupFailures = new Map<number, number>();
  private audit: AuditLog;
  private rateLimiter: TotpRateLimiter;

  constructor(private deps: CommandsDeps) {
    this.audit = new AuditLog(deps.store);
    this.rateLimiter = deps.totpRateLimiter ?? new TotpRateLimiter();
  }

  /**
   * If the user is currently locked out, emit a reply with remaining time and
   * return true. Callers should early-return on true. Does NOT audit — the
   * `totp_rate_limited` event fires exactly once at lockout onset (inside
   * `verifyTotpGated`); subsequent rejections are silent beyond the user
   * reply to avoid spamming the audit log during a sustained attack.
   */
  private async rejectIfLocked(
    chatId: number,
    userId: number,
  ): Promise<boolean> {
    const now = this.deps.nowMs();
    const until = this.rateLimiter.isLockedOut(userId, now);
    if (until === null) return false;
    const remaining = formatLockoutRemaining(until - now);
    await this.deps.reply(
      chatId,
      `Too many failed attempts. Locked for ${remaining}.`,
    );
    return true;
  }

  /**
   * Verify `code` for `userId` with lockout + audit side effects.
   * - If the user is already locked, returns `{ ok: false, locked: true, until }`
   *   without invoking the underlying code verifier.
   * - On verify failure, records the failure; if this failure trips the
   *   lockout threshold, emits `totp_rate_limited` (once) and returns with
   *   `locked: true, until`. Otherwise emits `totp_verify_failed` and returns
   *   `locked: false`.
   * - On verify success, clears the user's failure counters.
   *
   * `op` is used only for the audit details.
   */
  private verifyTotpGated(
    userId: number,
    code: string,
    op: string,
  ):
    | { ok: true }
    | { ok: false; locked: true; until: number }
    | { ok: false; locked: false } {
    const now = this.deps.nowMs();
    const lockedUntil = this.rateLimiter.isLockedOut(userId, now);
    if (lockedUntil !== null) {
      return { ok: false, locked: true, until: lockedUntil };
    }
    const v = this.verifyTotp(userId, code);
    if (v.ok) {
      this.rateLimiter.recordSuccess(userId);
      return { ok: true };
    }
    const r = this.rateLimiter.recordFailure(userId, now);
    this.audit.write({
      ts: now,
      telegramId: userId,
      event: 'totp_verify_failed',
      details: { op },
    });
    if (r.lockedUntil !== null) {
      this.audit.write({
        ts: now,
        telegramId: userId,
        event: 'totp_rate_limited',
        details: { until: r.lockedUntil },
      });
      return { ok: false, locked: true, until: r.lockedUntil };
    }
    return { ok: false, locked: false };
  }

  /** Test accessor — returns what (if any) action is awaiting TOTP for this user. */
  pendingFor(userId: number): PendingAction | undefined {
    return this.pending.get(userId);
  }

  /** Set a pending action for the user. Used by uiCallbacks (e.g. wd:custom). */
  setPending(userId: number, action: PendingAction): void {
    this.pending.set(userId, action);
  }

  /** Clear any pending action for the user. Used by uiCallbacks (cancel button). */
  clearPending(userId: number): void {
    this.pending.delete(userId);
  }

  // ── /account ───────────────────────────────────────────────────────────
  async handleAccount(msg: { chatId: number; userId: number }): Promise<void> {
    const existing = this.deps.store.getUser(msg.userId);
    if (!existing) {
      this.pending.set(msg.userId, { kind: 'disclaimer' });
      await this.deps.reply(msg.chatId, DISCLAIMER_TEXT, { keyboard: disclaimerKeyboard() });
      return;
    }
    if (existing.totpEnrolledAt === null) {
      const { secretBase32 } = await this.deps.enrollment.beginTotpEnrollment({
        telegramId: msg.userId,
      });
      this.pending.set(msg.userId, { kind: 'totp_setup_confirm' });
      const otpauthUri = `otpauth://totp/BertMMVault:${msg.userId}?secret=${secretBase32}&issuer=BertMMVault`;
      const dataUrl = await QRCode.toDataURL(otpauthUri);
      const photoBase64 = dataUrl.replace(/^data:image\/png;base64,/, '');
      await this.deps.reply(
        msg.chatId,
        `🔐 Scan this QR in Google Auth or Authy.\nOr enter secret manually: ${secretBase32}\n\nReply with the 6-digit code.`,
        { photoBase64, keyboard: cancelKeyboard() },
      );
      return;
    }
    await this.deps.reply(msg.chatId, 'Account ready.', { keyboard: mainMenuKeyboard() });
  }

  // ── /accept (disclaimer) ──────────────────────────────────────────────
  /**
   * Consumes a pending 'disclaimer' action: creates the user's deposit
   * keypair, begins TOTP enrollment, and shows the Base32 secret. The user's
   * next plain-text reply (expected: a 6-digit code) then confirms TOTP via
   * handleMessage's 'totp_setup_confirm' branch.
   */
  async handleAccept(msg: { chatId: number; userId: number }): Promise<void> {
    const pending = this.pending.get(msg.userId);
    if (!pending || pending.kind !== 'disclaimer') {
      await this.deps.reply(msg.chatId, 'No pending action. Use /account to start.');
      return;
    }
    this.pending.delete(msg.userId);
    const now = this.deps.nowMs();
    await this.deps.enrollment.accept({ telegramId: msg.userId, now });
    this.audit.write({ ts: now, telegramId: msg.userId, event: 'disclaimer_accepted' });
    const { secretBase32 } = await this.deps.enrollment.beginTotpEnrollment({
      telegramId: msg.userId,
    });
    this.pending.set(msg.userId, { kind: 'totp_setup_confirm' });
    this.totpSetupFailures.delete(msg.userId);
    const otpauthUri = `otpauth://totp/BertMMVault:${msg.userId}?secret=${secretBase32}&issuer=BertMMVault`;
    const dataUrl = await QRCode.toDataURL(otpauthUri);
    const photoBase64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    await this.deps.reply(
      msg.chatId,
      `🔐 Scan this QR in Google Auth or Authy.\nOr enter secret manually: ${secretBase32}\n\nReply with the 6-digit code.`,
      { photoBase64, keyboard: cancelKeyboard() },
    );
  }

  // ── /decline (disclaimer) ─────────────────────────────────────────────
  async handleDecline(msg: { chatId: number; userId: number }): Promise<void> {
    this.pending.delete(msg.userId);
    this.totpSetupFailures.delete(msg.userId);
    await this.deps.reply(msg.chatId, 'Cancelled. Use /account any time to reconsider.');
  }

  // ── /deposit ───────────────────────────────────────────────────────────
  async handleDeposit(msg: { chatId: number; userId: number }): Promise<void> {
    const user = this.deps.store.getUser(msg.userId);
    if (!user || user.totpEnrolledAt === null) {
      await this.deps.reply(msg.chatId, 'Please enroll first via /account.');
      return;
    }
    if (await this.rejectIfLocked(msg.chatId, msg.userId)) return;
    this.pending.set(msg.userId, { kind: 'deposit_reveal' });
    await this.deps.reply(
      msg.chatId,
      'Reply with your current 6-digit 2FA code to reveal your deposit address.',
      { keyboard: cancelKeyboard() },
    );
  }

  /**
   * Consume the user's next plain-text message as the TOTP response to a
   * pending action. No-op if there is no pending action for the user.
   * Returns after dispatching to the appropriate branch.
   */
  async handleMessage(msg: { chatId: number; userId: number; text: string }): Promise<void> {
    const pending = this.pending.get(msg.userId);
    if (!pending) return;

    // Rate-limit preflight for any TOTP-consuming pending action. A locked-out
    // user gets a time-remaining reply; pending is left intact so when the
    // lockout expires their next code attempt can proceed normally (no state
    // cleanup needed — the /deposit, /balance, etc. flows only set pending,
    // they don't perform any irreversible action).
    if (
      pending.kind !== 'disclaimer' &&
      (await this.rejectIfLocked(msg.chatId, msg.userId))
    ) {
      return;
    }

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
      case 'withdraw_amount_entry':
        await this.respondWithdrawAmountEntry(msg);
        return;
      case 'withdraw':
        await this.respondWithdraw(msg, pending);
        return;
      case 'totp_setup_confirm':
        await this.respondTotpSetupConfirm(msg);
        return;
      case 'disclaimer':
        // Disclaimer is consumed via /accept or /decline commands, not a
        // free-text reply. Drop any plain-text message and keep pending so
        // the user still gets a chance to /accept.
        return;
      default:
        // Other branches wired in later sub-steps. Drop the pending entry to
        // avoid leaking state if we hit an unhandled branch in dev.
        return;
    }
  }

  private async respondTotpSetupConfirm(
    msg: { chatId: number; userId: number; text: string },
  ): Promise<void> {
    const code = msg.text.trim();
    const now = this.deps.nowMs();
    const ok = await this.deps.enrollment.confirmTotp({
      telegramId: msg.userId, code, now,
    });
    if (ok) {
      this.pending.delete(msg.userId);
      this.totpSetupFailures.delete(msg.userId);
      this.rateLimiter.recordSuccess(msg.userId);
      this.audit.write({ ts: now, telegramId: msg.userId, event: 'totp_enrolled' });
      await this.deps.reply(msg.chatId, '✅ Account ready.', { keyboard: mainMenuKeyboard() });
      return;
    }
    const failures = (this.totpSetupFailures.get(msg.userId) ?? 0) + 1;
    this.audit.write({
      ts: now, telegramId: msg.userId,
      event: 'totp_verify_failed', details: { op: 'totp_setup_confirm', failures },
    });
    // Setup failures also feed the global rate limiter (cross-counts with
    // runtime failures). If this failure trips the threshold, emit the
    // one-shot `totp_rate_limited` event and show the lockout message instead
    // of the generic "invalid code" reply.
    const r = this.rateLimiter.recordFailure(msg.userId, now);
    if (r.lockedUntil !== null) {
      this.pending.delete(msg.userId);
      this.totpSetupFailures.delete(msg.userId);
      this.audit.write({
        ts: now, telegramId: msg.userId,
        event: 'totp_rate_limited', details: { until: r.lockedUntil },
      });
      const remaining = formatLockoutRemaining(r.lockedUntil - now);
      await this.deps.reply(
        msg.chatId,
        `Too many failed attempts. Locked for ${remaining}.`,
        { keyboard: errorKeyboard({ retryCallback: 'nav:create_account' }) },
      );
      return;
    }
    if (failures >= TOTP_SETUP_MAX_FAILURES) {
      this.pending.delete(msg.userId);
      this.totpSetupFailures.delete(msg.userId);
      await this.deps.reply(
        msg.chatId,
        `Too many invalid codes. Start over via /account.`,
        { keyboard: errorKeyboard({ retryCallback: 'nav:create_account' }) },
      );
      return;
    }
    this.totpSetupFailures.set(msg.userId, failures);
    await this.deps.reply(msg.chatId, 'Invalid code. Try again.', { keyboard: cancelKeyboard() });
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
    if (await this.rejectIfLocked(msg.chatId, msg.userId)) return;
    this.pending.set(msg.userId, { kind: 'balance_reveal' });
    await this.deps.reply(
      msg.chatId,
      'Reply with your current 6-digit 2FA code to view your balance.',
      { keyboard: cancelKeyboard() },
    );
  }

  private async respondBalanceReveal(msg: { chatId: number; userId: number; text: string }): Promise<void> {
    this.pending.delete(msg.userId);
    const v = this.verifyTotpGated(msg.userId, msg.text.trim(), 'balance_reveal');
    if (!v.ok) {
      if (v.locked) {
        const remaining = formatLockoutRemaining(v.until - this.deps.nowMs());
        await this.deps.reply(
          msg.chatId,
          `Too many failed attempts. Locked for ${remaining}.`,
          { keyboard: errorKeyboard({ retryCallback: 'act:balance' }) },
        );
        return;
      }
      await this.deps.reply(
        msg.chatId,
        '2FA code invalid. Try /balance again.',
        { keyboard: errorKeyboard({ retryCallback: 'act:balance' }) },
      );
      return;
    }
    const shares = this.deps.store.getShares(msg.userId);
    const nav = await this.deps.getNav();
    if (!nav) {
      await this.deps.reply(msg.chatId, 'NAV unavailable — try again shortly.');
      return;
    }
    const navPerShare = computeNavPerShare({ totalUsd: nav.totalUsd, totalShares: nav.totalShares });
    const usd = usdForShares({ netShares: shares, navPerShare });
    this.audit.write({
      ts: this.deps.nowMs(), telegramId: msg.userId, event: 'balance_reveal',
      details: { shares, navPerShare, usd },
    });
    await this.deps.reply(
      msg.chatId,
      `${shares.toFixed(2)} shares — approx $${usd.toFixed(2)}\n(NAV/share: $${navPerShare.toFixed(6)})`,
      { keyboard: postBalanceKeyboard() },
    );
  }

  // ── /stats (public) ───────────────────────────────────────────────────
  async handleStats(msg: { chatId: number; userId?: number }): Promise<void> {
    const nav = await this.deps.getNav();
    if (!nav) {
      await this.deps.reply(msg.chatId, 'BERT Vault stats unavailable — try again shortly.');
      return;
    }
    const navPerShare = computeNavPerShare({ totalUsd: nav.totalUsd, totalShares: nav.totalShares });
    const now = this.deps.nowMs();
    const prior = this.deps.store.navSnapshotAtOrBefore(now - 24 * 3600 * 1000);
    let deltaLine: string;
    if (prior && prior.navPerShare > 0) {
      const pct = (navPerShare - prior.navPerShare) / prior.navPerShare * 100;
      const sign = pct >= 0 ? '+' : '';
      deltaLine = `24h: ${sign}${pct.toFixed(2)}%`;
    } else {
      deltaLine = `24h: —`;
    }
    const tvlStr = nav.totalUsd.toLocaleString('en-US', { maximumFractionDigits: 2 });
    const enrolled = msg.userId != null
      ? (() => {
          const u = this.deps.store.getUser(msg.userId!);
          return !!u && u.totpEnrolledAt !== null;
        })()
      : false;
    await this.deps.reply(
      msg.chatId,
      `BERT Vault stats\n` +
        `TVL: $${tvlStr}\n` +
        `NAV/share: $${navPerShare.toFixed(2)}\n` +
        deltaLine,
      enrolled ? { keyboard: postActionKeyboard() } : undefined,
    );
  }

  // ── /menu ─────────────────────────────────────────────────────────────
  async handleMenu(msg: { chatId: number; userId: number }): Promise<void> {
    const user = this.deps.store.getUser(msg.userId);
    if (!user || user.totpEnrolledAt === null) {
      await this.deps.reply(
        msg.chatId,
        '👋 Welcome to BertMM Vault. You need to create an account first.',
        { keyboard: welcomeKeyboard() },
      );
      return;
    }
    await this.deps.reply(msg.chatId, '🏦 BertMM Vault', { keyboard: mainMenuKeyboard() });
  }

  // ── /withdraw ─────────────────────────────────────────────────────────
  async handleWithdraw(msg: { chatId: number; userId: number; text: string }): Promise<void> {
    const user = this.deps.store.getUser(msg.userId);
    if (!user || user.totpEnrolledAt === null) {
      await this.deps.reply(msg.chatId, 'Please enroll first via /account.');
      return;
    }
    if (!user.whitelistAddress) {
      await this.deps.reply(msg.chatId, 'Set a withdrawal destination first via /setwhitelist.');
      return;
    }
    if (await this.rejectIfLocked(msg.chatId, msg.userId)) return;
    const parts = msg.text.trim().split(/\s+/);
    const raw = parts[1];
    if (!raw) {
      this.pending.set(msg.userId, { kind: 'withdraw_amount_entry' });
      await this.deps.reply(msg.chatId, 'How much to withdraw?', { keyboard: withdrawAmountKeyboard() });
      return;
    }

    // Compute the user's available USD up-front so we can parse percentage.
    const nav = await this.deps.getNav();
    if (!nav) {
      await this.deps.reply(msg.chatId, 'NAV unavailable — try again shortly.');
      return;
    }
    const navPerShare = computeNavPerShare({ totalUsd: nav.totalUsd, totalShares: nav.totalShares });
    const shares = this.deps.store.getShares(msg.userId);
    const userUsd = usdForShares({ netShares: shares, navPerShare });

    let amountUsd: number;
    if (raw.endsWith('%')) {
      const pct = Number(raw.slice(0, -1));
      if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
        await this.deps.reply(msg.chatId, 'Invalid percentage. Use e.g. /withdraw 50%');
        return;
      }
      amountUsd = userUsd * pct / 100;
    } else {
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) {
        await this.deps.reply(msg.chatId, 'Invalid amount. Use e.g. /withdraw 100 or /withdraw 50%');
        return;
      }
      amountUsd = n;
    }

    // Checks (fail-closed)
    if (amountUsd < this.deps.config.minWithdrawalUsd) {
      await this.deps.reply(
        msg.chatId,
        `Amount below minimum ($${this.deps.config.minWithdrawalUsd.toFixed(2)}).`,
      );
      return;
    }
    if (amountUsd > userUsd + 1e-6) {
      await this.deps.reply(msg.chatId, `Amount exceeds your balance ($${userUsd.toFixed(2)}).`);
      return;
    }
    const countToday = this.deps.store.countUserWithdrawalsLast24h(msg.userId, this.deps.nowMs());
    if (countToday >= this.deps.config.maxDailyWithdrawalsPerUser) {
      await this.deps.reply(
        msg.chatId,
        `Daily withdrawal limit reached (${this.deps.config.maxDailyWithdrawalsPerUser}/day). Try again tomorrow.`,
      );
      return;
    }
    const usdToday = this.deps.store.sumUserWithdrawalUsdLast24h(msg.userId, this.deps.nowMs());
    if (usdToday + amountUsd > this.deps.config.maxDailyWithdrawalUsdPerUser) {
      await this.deps.reply(
        msg.chatId,
        `Daily USD cap would be exceeded ` +
          `(cap $${this.deps.config.maxDailyWithdrawalUsdPerUser.toFixed(0)}, used $${usdToday.toFixed(2)}).`,
      );
      return;
    }
    if (this.deps.store.countPendingWithdrawals() >= this.deps.config.maxPendingWithdrawals) {
      await this.deps.reply(
        msg.chatId,
        `Withdrawal queue is full right now. Try again in a few minutes.`,
      );
      return;
    }

    this.pending.set(msg.userId, { kind: 'withdraw', amountUsd });
    await this.deps.reply(
      msg.chatId,
      `Reply with your 2FA code to queue a $${amountUsd.toFixed(2)} withdrawal to ${user.whitelistAddress}.`,
      { keyboard: cancelKeyboard() },
    );
  }

  private async respondWithdrawAmountEntry(
    msg: { chatId: number; userId: number; text: string },
  ): Promise<void> {
    this.pending.delete(msg.userId);
    const n = Number(msg.text.trim());
    if (!Number.isFinite(n) || n <= 0) {
      await this.deps.reply(msg.chatId, 'Invalid amount. Start again via /withdraw.');
      return;
    }
    const user = this.deps.store.getUser(msg.userId);
    if (!user?.whitelistAddress) {
      await this.deps.reply(msg.chatId, 'Set a withdrawal destination first via /setwhitelist.');
      return;
    }
    const nav = await this.deps.getNav();
    if (!nav) {
      await this.deps.reply(msg.chatId, 'NAV unavailable — try again shortly.');
      return;
    }
    const navPerShare = computeNavPerShare({ totalUsd: nav.totalUsd, totalShares: nav.totalShares });
    const shares = this.deps.store.getShares(msg.userId);
    const userUsd = usdForShares({ netShares: shares, navPerShare });
    if (n < this.deps.config.minWithdrawalUsd) {
      await this.deps.reply(msg.chatId, `Amount below minimum ($${this.deps.config.minWithdrawalUsd.toFixed(2)}).`);
      return;
    }
    if (n > userUsd + 1e-6) {
      await this.deps.reply(msg.chatId, `Amount exceeds your balance ($${userUsd.toFixed(2)}).`);
      return;
    }
    this.pending.set(msg.userId, { kind: 'withdraw', amountUsd: n });
    await this.deps.reply(
      msg.chatId,
      `Withdraw $${n.toFixed(2)} to ${user.whitelistAddress.slice(0, 6)}…${user.whitelistAddress.slice(-4)}?\nReply with your 6-digit code to confirm.`,
      { keyboard: cancelKeyboard() },
    );
  }

  private async respondWithdraw(
    msg: { chatId: number; userId: number; text: string },
    pending: Extract<PendingAction, { kind: 'withdraw' }>,
  ): Promise<void> {
    this.pending.delete(msg.userId);
    const v = this.verifyTotpGated(msg.userId, msg.text.trim(), 'withdraw');
    if (!v.ok) {
      if (v.locked) {
        const remaining = formatLockoutRemaining(v.until - this.deps.nowMs());
        await this.deps.reply(
          msg.chatId,
          `Too many failed attempts. Locked for ${remaining}.`,
          { keyboard: errorKeyboard({ retryCallback: 'act:withdraw' }) },
        );
        return;
      }
      await this.deps.reply(
        msg.chatId,
        '2FA code invalid. Try /withdraw again.',
        { keyboard: errorKeyboard({ retryCallback: 'act:withdraw' }) },
      );
      return;
    }
    const user = this.deps.store.getUser(msg.userId)!;
    if (!user.whitelistAddress) {
      await this.deps.reply(
        msg.chatId,
        'No whitelist address set.',
        { keyboard: errorKeyboard({ retryCallback: 'act:withdraw' }) },
      );
      return;
    }
    const nav = await this.deps.getNav();
    if (!nav) {
      await this.deps.reply(
        msg.chatId,
        'NAV unavailable — try again shortly.',
        { keyboard: errorKeyboard({ retryCallback: 'act:withdraw' }) },
      );
      return;
    }
    const navPerShare = computeNavPerShare({ totalUsd: nav.totalUsd, totalShares: nav.totalShares });
    if (navPerShare <= 0) {
      await this.deps.reply(
        msg.chatId,
        'NAV unavailable — try again shortly.',
        { keyboard: errorKeyboard({ retryCallback: 'act:withdraw' }) },
      );
      return;
    }
    const sharesBurned = pending.amountUsd / navPerShare;
    const { feeShares } = splitFee({ sharesBurned, feeBps: this.deps.config.withdrawalFeeBps });
    const id = this.deps.store.enqueueWithdrawal({
      telegramId: msg.userId,
      destination: user.whitelistAddress,
      sharesBurned,
      feeShares,
      queuedAt: this.deps.nowMs(),
    });
    this.audit.write({
      ts: this.deps.nowMs(), telegramId: msg.userId, event: 'withdrawal_queued',
      details: { id, amountUsd: pending.amountUsd, sharesBurned, feeShares, destination: user.whitelistAddress },
    });
    await this.deps.reply(
      msg.chatId,
      `Queued! Your withdrawal of $${pending.amountUsd.toFixed(2)} will be processed on the next tick.`,
      { keyboard: postActionKeyboard() },
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
      await this.deps.reply(
        msg.chatId,
        'Usage: /setwhitelist <solana-address>',
        { keyboard: cancelKeyboard() },
      );
      return;
    }
    try {
      // eslint-disable-next-line no-new
      new PublicKey(addr);
    } catch {
      await this.deps.reply(
        msg.chatId,
        'That does not look like a valid Solana address.',
        { keyboard: errorKeyboard({ retryCallback: 'wl:set' }) },
      );
      return;
    }
    if (await this.rejectIfLocked(msg.chatId, msg.userId)) return;
    if (user.whitelistAddress === null) {
      this.pending.set(msg.userId, { kind: 'setwhitelist_first', address: addr });
      await this.deps.reply(
        msg.chatId,
        `First whitelist setup. Reply with your 2FA code to set ${addr} immediately.`,
        { keyboard: cancelKeyboard() },
      );
    } else {
      this.pending.set(msg.userId, { kind: 'setwhitelist_change', address: addr });
      await this.deps.reply(
        msg.chatId,
        `Whitelist change requested: ${addr}.\n` +
          `Reply with your 2FA code to enqueue. Changes activate after a 24-hour cooldown; ` +
          `use /cancelwhitelist before it activates to abort.`,
        { keyboard: cancelKeyboard() },
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
    if (await this.rejectIfLocked(msg.chatId, msg.userId)) return;
    this.pending.set(msg.userId, { kind: 'cancelwhitelist' });
    await this.deps.reply(
      msg.chatId,
      'Reply with your 2FA code to cancel the pending whitelist change.',
      { keyboard: cancelKeyboard() },
    );
  }

  private async respondSetWhitelist(
    msg: { chatId: number; userId: number; text: string },
    pending: Extract<PendingAction, { kind: 'setwhitelist_first' | 'setwhitelist_change' }>,
  ): Promise<void> {
    this.pending.delete(msg.userId);
    const v = this.verifyTotpGated(msg.userId, msg.text.trim(), pending.kind);
    if (!v.ok) {
      if (v.locked) {
        const remaining = formatLockoutRemaining(v.until - this.deps.nowMs());
        await this.deps.reply(
          msg.chatId,
          `Too many failed attempts. Locked for ${remaining}.`,
          { keyboard: errorKeyboard({ retryCallback: 'wl:set' }) },
        );
        return;
      }
      await this.deps.reply(
        msg.chatId,
        '2FA code invalid. Try /setwhitelist again.',
        { keyboard: errorKeyboard({ retryCallback: 'wl:set' }) },
      );
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
      await this.deps.reply(
        msg.chatId,
        `Whitelist set to ${pending.address} (effective immediately).`,
        { keyboard: postActionKeyboard() },
      );
    } else {
      const activates = new Date(result.activatesAt).toISOString();
      await this.deps.reply(
        msg.chatId,
        `Whitelist change queued. Activates at ${activates}. Use /cancelwhitelist to abort before then.`,
        { keyboard: postActionKeyboard() },
      );
    }
  }

  private async respondCancelWhitelist(
    msg: { chatId: number; userId: number; text: string },
  ): Promise<void> {
    this.pending.delete(msg.userId);
    const v = this.verifyTotpGated(msg.userId, msg.text.trim(), 'cancelwhitelist');
    if (!v.ok) {
      if (v.locked) {
        const remaining = formatLockoutRemaining(v.until - this.deps.nowMs());
        await this.deps.reply(
          msg.chatId,
          `Too many failed attempts. Locked for ${remaining}.`,
          { keyboard: errorKeyboard({ retryCallback: 'wl:cancel' }) },
        );
        return;
      }
      await this.deps.reply(
        msg.chatId,
        '2FA code invalid. Try /cancelwhitelist again.',
        { keyboard: errorKeyboard({ retryCallback: 'wl:cancel' }) },
      );
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
      { keyboard: postActionKeyboard() },
    );
  }

  private async respondDepositReveal(msg: { chatId: number; userId: number; text: string }): Promise<void> {
    this.pending.delete(msg.userId);
    const v = this.verifyTotpGated(msg.userId, msg.text.trim(), 'deposit_reveal');
    if (!v.ok) {
      if (v.locked) {
        const remaining = formatLockoutRemaining(v.until - this.deps.nowMs());
        await this.deps.reply(
          msg.chatId,
          `Too many failed attempts. Locked for ${remaining}.`,
          { keyboard: errorKeyboard({ retryCallback: 'act:deposit' }) },
        );
        return;
      }
      await this.deps.reply(
        msg.chatId,
        '2FA code invalid. Try /deposit again.',
        { keyboard: errorKeyboard({ retryCallback: 'act:deposit' }) },
      );
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
      { keyboard: postDepositKeyboard() },
    );
  }
}
