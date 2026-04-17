import type { DepositorStore } from './depositorStore.js';
import type { StateStore } from '../stateStore.js';
import type { AuditLog } from './audit.js';
import type { CreditEngine } from './creditEngine.js';
import type { ReplyFn } from './commands.js';
import { VAULT_PAUSED_FLAG } from './flags.js';
import { computeNavPerShare } from './shareMath.js';

export interface OperatorCommandsDeps {
  store: DepositorStore;
  state: StateStore;
  audit: AuditLog;
  reply: ReplyFn;
  nowMs: () => number;
  /**
   * Optional — only wired when the full vault runtime is constructed.
   * /recreditdeposit and /resettotp are no-ops (with a reply) when absent.
   */
  creditEngine?: CreditEngine;
  /**
   * Optional oracle lookup — used by /recreditdeposit. Returns null when the
   * oracle is unhealthy. Callers should reply with "try again" in that case.
   */
  getMid?: () => Promise<{ solUsd: number; bertUsd: number } | null>;
}

/**
 * Operator-only vault commands. All are assumed to have been authorized by
 * the caller (TelegramCommander.registerOperatorCommand gates on
 * operator user id). No further auth inside the handler.
 *
 *  /pausevault                    — set `vault_paused=1` flag
 *  /resumevault                   — clear the flag
 *  /vaultstatus                   — TVL + shares + queued count + last NAV + last 5 audit
 *  /forceprocess <id>             — reset a failed withdrawal back to 'queued'
 *  /recreditdeposit <inboundSig>  — break-glass: credit shares for a deposit
 *                                    that was swept on-chain but never credited
 *                                    (e.g., DB lock between sweep and credit).
 *  /resettotp <telegramId>        — wipe a user's TOTP secret so they re-enroll.
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
    // N1: refuse requeue if the row already has a tx_sig. That means the
    // on-chain transfer has landed — retrying would double-pay the user.
    if (w.txSig) {
      await this.deps.reply(
        msg.chatId,
        `Withdrawal #${id} has an on-chain tx_sig (${w.txSig}). Do NOT requeue. ` +
          `Reconcile manually via /reconcilewithdrawal ${id}.`,
      );
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

  /**
   * /recreditdeposit <inboundTxSig>
   *
   * Break-glass recovery for the "swept but not credited" failure mode. The
   * oracle-preflight fix in onInflow handles the common case (oracle down);
   * this command handles the rare residual cases (DB lock between sweep and
   * credit, unexpected error inside creditEngine, etc.).
   *
   * The command:
   *   1. Looks up deposit_detected + deposit_swept audit rows for the sig.
   *      Both are required — detected carries amounts, swept carries the
   *      sweepTxSig.
   *   2. Confirms no vault_deposits row already exists for that sig (if yes,
   *      replies "already credited" and returns — no-op).
   *   3. Fetches current mid price and current navPerShare from the store.
   *   4. Calls creditEngine.credit(...) which writes the vault_deposits row,
   *      mints shares, writes NAV snapshot, and writes deposit_credited audit.
   *   5. Emits an additional deposit_recredited audit naming the operator.
   */
  async handleRecreditDeposit(
    msg: { chatId: number; userId: number; text: string },
  ): Promise<void> {
    const parts = msg.text.trim().split(/\s+/);
    const inboundTxSig = parts[1];
    if (!inboundTxSig) {
      await this.deps.reply(
        msg.chatId,
        'Usage: /recreditdeposit <inboundTxSig>',
      );
      return;
    }
    if (!this.deps.creditEngine || !this.deps.getMid) {
      await this.deps.reply(
        msg.chatId,
        'Recredit is not wired in this environment (missing creditEngine/getMid).',
      );
      return;
    }

    // Already credited? vault_deposits has UNIQUE(inbound_tx_sig).
    if (this.deps.store.hasDeposit(inboundTxSig)) {
      await this.deps.reply(
        msg.chatId,
        `Deposit ${inboundTxSig} already credited — nothing to do.`,
      );
      return;
    }

    // Pull audit events for this sig. Scan a window large enough to catch
    // the detect + sweep pair; the caller invokes this shortly after the
    // failure (operator intervention is on the order of minutes-to-hours).
    // We use listRecentAuditEvents to walk newest-first; match on the sig
    // inside detailsJson.
    const recent = this.deps.store.listRecentAuditEvents(5000);
    let detectedJson: any = null;
    let sweptJson: any = null;
    let telegramId: number | null = null;
    for (const e of recent) {
      if (e.event !== 'deposit_detected' && e.event !== 'deposit_swept') continue;
      let parsed: any;
      try { parsed = JSON.parse(e.detailsJson); } catch { continue; }
      if (parsed?.inboundTxSig !== inboundTxSig) continue;
      if (e.event === 'deposit_detected' && detectedJson === null) {
        detectedJson = parsed;
        telegramId = e.telegramId;
      }
      if (e.event === 'deposit_swept' && sweptJson === null) {
        sweptJson = parsed;
        if (telegramId === null) telegramId = e.telegramId;
      }
      if (detectedJson && sweptJson) break;
    }
    if (!detectedJson) {
      await this.deps.reply(
        msg.chatId,
        `No deposit_detected audit for ${inboundTxSig}.`,
      );
      return;
    }
    if (!sweptJson) {
      await this.deps.reply(
        msg.chatId,
        `Found deposit_detected but no deposit_swept for ${inboundTxSig} — sweep may not have landed. Investigate the deposit address balance before recrediting.`,
      );
      return;
    }
    if (telegramId === null) {
      await this.deps.reply(msg.chatId, 'Could not infer telegramId from audit rows.');
      return;
    }
    const sweepTxSig: string | undefined =
      typeof sweptJson.sweepTxSig === 'string' ? sweptJson.sweepTxSig : undefined;
    if (!sweepTxSig) {
      await this.deps.reply(msg.chatId, 'deposit_swept audit row has no sweepTxSig.');
      return;
    }

    // Amounts live in deposit_detected (canonical) but deposit_swept now also
    // includes them after N2 — prefer whichever is present.
    const pickBigint = (...vals: any[]): bigint | null => {
      for (const v of vals) {
        if (v === undefined || v === null) continue;
        try { return BigInt(String(v)); } catch { continue; }
      }
      return null;
    };
    const solLamports = pickBigint(detectedJson.solLamports, sweptJson.solLamports);
    const bertRaw = pickBigint(detectedJson.bertRaw, sweptJson.bertRaw);
    if (solLamports === null || bertRaw === null) {
      await this.deps.reply(msg.chatId, 'Could not parse amounts from audit rows.');
      return;
    }
    const confirmedAt: number | undefined =
      typeof sweptJson.confirmedAt === 'number' ? sweptJson.confirmedAt : undefined;

    const mid = await this.deps.getMid();
    if (!mid) {
      await this.deps.reply(
        msg.chatId,
        'Oracle unavailable — try /recreditdeposit again when the oracle recovers.',
      );
      return;
    }
    const snap = this.deps.store.latestNavSnapshot();
    const navPerShare = computeNavPerShare({
      totalUsd: snap?.totalValueUsd ?? 0,
      totalShares: this.deps.store.totalShares(),
    });

    try {
      this.deps.creditEngine.credit({
        telegramId,
        inboundTxSig,
        sweepTxSig,
        solLamports,
        bertRaw,
        solUsd: mid.solUsd,
        bertUsd: mid.bertUsd,
        navPerShareAtDeposit: navPerShare,
        confirmedAt: confirmedAt ?? this.deps.nowMs(),
        sweptAt: this.deps.nowMs(),
        now: this.deps.nowMs(),
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      // UNIQUE(inbound_tx_sig) race — treat as "already credited".
      if (/UNIQUE/i.test(reason)) {
        await this.deps.reply(msg.chatId, `Deposit ${inboundTxSig} already credited (race).`);
        return;
      }
      await this.deps.reply(msg.chatId, `Recredit failed: ${reason}`);
      return;
    }

    const deposits = this.deps.store.listDepositsForUser(telegramId);
    const matchingDeposit = deposits.find((d) => d.inboundTxSig === inboundTxSig);
    const sharesMinted = matchingDeposit?.sharesMinted ?? 0;

    this.deps.audit.write({
      ts: this.deps.nowMs(),
      telegramId: msg.userId,
      event: 'deposit_recredited',
      details: {
        inboundTxSig,
        sweepTxSig,
        targetTelegramId: telegramId,
        sharesMinted,
        navPerShare,
      },
    });
    await this.deps.reply(
      msg.chatId,
      `Recredited deposit ${inboundTxSig}: ${sharesMinted.toFixed(4)} shares minted to user ${telegramId} at NAV/share $${navPerShare.toFixed(6)}.`,
    );
  }

  /**
   * /resettotp <telegramId>
   *
   * N17: break-glass recovery when a depositor loses their authenticator.
   * Wipes the user's TOTP secret so the next /account call runs enrollment
   * again. Operator confirms via out-of-band verification (e.g., a signed
   * message from the user's whitelist address) before running this.
   */
  async handleResetTotp(
    msg: { chatId: number; userId: number; text: string },
  ): Promise<void> {
    const m = msg.text.match(/^\/resettotp\s+(-?\d+)/);
    if (!m) {
      await this.deps.reply(msg.chatId, 'Usage: /resettotp <telegram_user_id>');
      return;
    }
    const targetId = Number(m[1]);
    const user = this.deps.store.getUser(targetId);
    if (!user) {
      await this.deps.reply(msg.chatId, `No user with telegram_id ${targetId}.`);
      return;
    }
    this.deps.store.clearUserTotp(targetId);
    this.deps.audit.write({
      ts: this.deps.nowMs(),
      telegramId: msg.userId,   // operator, not target
      event: 'totp_reset',
      details: { targetUserId: targetId },
    });
    await this.deps.reply(
      msg.chatId,
      `TOTP reset for user ${targetId}. They must run /account to re-enroll.`,
    );
  }
}
