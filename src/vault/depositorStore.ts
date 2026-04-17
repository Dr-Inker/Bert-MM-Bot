import type Database from 'better-sqlite3';
import type { StateStore } from '../stateStore.js';
import type {
  VaultUser, VaultDeposit, VaultWithdrawal, WithdrawalStatus,
  PendingWhitelistChange, NavSnapshotRow,
} from './types.js';

export class DepositorStore {
  private db: Database.Database;

  constructor(private state: StateStore) {
    // StateStore exposes db via (state as any).db — add a getter if preferred
    this.db = (state as unknown as { db: Database.Database }).db;
  }

  /** Run fn in a transaction (delegates to state.withTransaction). */
  withTransaction<T>(fn: () => T): T {
    return this.state.withTransaction(fn);
  }

  // ── Users ──────────────────────────────────────────────────────────────
  createUser(args: {
    telegramId: number; role: 'operator' | 'depositor'; depositAddress: string;
    depositSecretEnc: Buffer; depositSecretIv: Buffer;
    disclaimerAt: number; createdAt: number;
  }): void {
    this.db.prepare(`
      INSERT INTO vault_users(telegram_id, role, deposit_address, deposit_secret_enc,
                              deposit_secret_iv, disclaimer_at, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?)
    `).run(args.telegramId, args.role, args.depositAddress,
           args.depositSecretEnc, args.depositSecretIv,
           args.disclaimerAt, args.createdAt);
  }

  getUser(telegramId: number): VaultUser | null {
    const row = this.db.prepare(`SELECT * FROM vault_users WHERE telegram_id=?`).get(telegramId) as any;
    return row ? this.rowToUser(row) : null;
  }

  getUserByDepositAddress(addr: string): VaultUser | null {
    const row = this.db.prepare(`SELECT * FROM vault_users WHERE deposit_address=?`).get(addr) as any;
    return row ? this.rowToUser(row) : null;
  }

  listUsers(): VaultUser[] {
    return (this.db.prepare(`SELECT * FROM vault_users ORDER BY created_at`).all() as any[])
      .map(r => this.rowToUser(r));
  }

  getUserSecrets(telegramId: number): {
    depositSecretEnc: Buffer; depositSecretIv: Buffer;
    totpSecretEnc: Buffer | null; totpSecretIv: Buffer | null;
  } | null {
    const row = this.db.prepare(`
      SELECT deposit_secret_enc, deposit_secret_iv, totp_secret_enc, totp_secret_iv
      FROM vault_users WHERE telegram_id=?
    `).get(telegramId) as any;
    if (!row) return null;
    return {
      depositSecretEnc: row.deposit_secret_enc,
      depositSecretIv: row.deposit_secret_iv,
      totpSecretEnc: row.totp_secret_enc ?? null,
      totpSecretIv: row.totp_secret_iv ?? null,
    };
  }

  setTotp(args: { telegramId: number; secretEnc: Buffer; secretIv: Buffer; enrolledAt: number }): void {
    this.db.prepare(`
      UPDATE vault_users SET totp_secret_enc=?, totp_secret_iv=?, totp_enrolled_at=?
      WHERE telegram_id=?
    `).run(args.secretEnc, args.secretIv, args.enrolledAt, args.telegramId);
  }

  setTotpLastCounter(telegramId: number, counter: number): void {
    this.db.prepare(`UPDATE vault_users SET totp_last_used_counter=? WHERE telegram_id=?`)
      .run(counter, telegramId);
  }

  setWhitelistImmediate(args: { telegramId: number; address: string; ts: number }): void {
    this.db.prepare(`
      UPDATE vault_users SET whitelist_address=?, whitelist_set_at=? WHERE telegram_id=?
    `).run(args.address, args.ts, args.telegramId);
  }

  // ── Shares ─────────────────────────────────────────────────────────────
  getShares(telegramId: number): number {
    const row = this.db.prepare(`SELECT shares FROM vault_shares WHERE telegram_id=?`)
      .get(telegramId) as { shares: number } | undefined;
    return row?.shares ?? 0;
  }

  addShares(telegramId: number, delta: number): void {
    const existing = this.db.prepare(`SELECT shares FROM vault_shares WHERE telegram_id=?`)
      .get(telegramId) as { shares: number } | undefined;
    if (existing) {
      this.db.prepare(`UPDATE vault_shares SET shares=? WHERE telegram_id=?`)
        .run(existing.shares + delta, telegramId);
    } else {
      this.db.prepare(`INSERT INTO vault_shares(telegram_id, shares) VALUES(?, ?)`)
        .run(telegramId, delta);
    }
  }

  totalShares(): number {
    const row = this.db.prepare(`SELECT COALESCE(SUM(shares),0) AS total FROM vault_shares`)
      .get() as { total: number };
    return row.total;
  }

  // ── Deposits ───────────────────────────────────────────────────────────
  creditDeposit(args: Omit<VaultDeposit, 'id'>): number {
    return this.withTransaction(() => {
      const info = this.db.prepare(`
        INSERT INTO vault_deposits(telegram_id, inbound_tx_sig, sweep_tx_sig,
                                   sol_lamports, bert_raw, sol_usd, bert_usd,
                                   nav_per_share_at, shares_minted, confirmed_at, swept_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        args.telegramId, args.inboundTxSig, args.sweepTxSig,
        args.solLamports, args.bertRaw, args.solUsd, args.bertUsd,
        args.navPerShareAt, args.sharesMinted, args.confirmedAt, args.sweptAt,
      );
      this.addShares(args.telegramId, args.sharesMinted);
      return info.lastInsertRowid as number;
    });
  }

  hasDeposit(inboundTxSig: string): boolean {
    const row = this.db.prepare(`SELECT 1 FROM vault_deposits WHERE inbound_tx_sig=?`)
      .get(inboundTxSig);
    return !!row;
  }

  listDepositsForUser(telegramId: number): VaultDeposit[] {
    return (this.db.prepare(`SELECT * FROM vault_deposits WHERE telegram_id=? ORDER BY id`)
      .all(telegramId) as any[]).map(r => this.rowToDeposit(r));
  }

  // ── Withdrawals ────────────────────────────────────────────────────────
  enqueueWithdrawal(args: {
    telegramId: number; destination: string;
    sharesBurned: number; feeShares: number; queuedAt: number;
  }): number {
    const info = this.db.prepare(`
      INSERT INTO vault_withdrawals(telegram_id, status, destination,
                                    shares_burned, fee_shares, queued_at)
      VALUES(?, 'queued', ?, ?, ?, ?)
    `).run(args.telegramId, args.destination, args.sharesBurned, args.feeShares, args.queuedAt);
    return info.lastInsertRowid as number;
  }

  setWithdrawalProcessing(id: number): void {
    this.db.prepare(`UPDATE vault_withdrawals SET status='processing' WHERE id=? AND status='queued'`)
      .run(id);
  }

  completeWithdrawal(args: {
    id: number; txSig: string;
    solLamportsOut: bigint; bertRawOut: bigint;
    navPerShareAt: number; processedAt: number;
  }): void {
    this.withTransaction(() => {
      const w = this.db.prepare(`SELECT telegram_id, shares_burned FROM vault_withdrawals WHERE id=?`)
        .get(args.id) as { telegram_id: number; shares_burned: number } | undefined;
      if (!w) throw new Error(`completeWithdrawal: id ${args.id} not found`);
      this.db.prepare(`
        UPDATE vault_withdrawals SET status='completed', tx_sig=?,
          sol_lamports_out=?, bert_raw_out=?, nav_per_share_at=?, processed_at=?
        WHERE id=?
      `).run(args.txSig, args.solLamportsOut, args.bertRawOut, args.navPerShareAt, args.processedAt, args.id);
      this.addShares(w.telegram_id, -w.shares_burned);
    });
  }

  failWithdrawal(args: { id: number; reason: string; processedAt: number }): void {
    this.db.prepare(`
      UPDATE vault_withdrawals SET status='failed', failure_reason=?, processed_at=?
      WHERE id=?
    `).run(args.reason, args.processedAt, args.id);
  }

  listWithdrawalsByStatus(status: WithdrawalStatus): VaultWithdrawal[] {
    return (this.db.prepare(`SELECT * FROM vault_withdrawals WHERE status=? ORDER BY id`)
      .all(status) as any[]).map(r => this.rowToWithdrawal(r));
  }

  /** Sum USD value delivered (net of fee) for completed withdrawals in last 24h. */
  sumCompletedWithdrawalUsdLast24h(telegramId: number, nowMs: number): number {
    const since = nowMs - 24 * 3600 * 1000;
    const row = this.db.prepare(`
      SELECT COALESCE(SUM((shares_burned - fee_shares) * nav_per_share_at), 0) AS total
      FROM vault_withdrawals
      WHERE telegram_id=? AND status='completed' AND processed_at >= ?
    `).get(telegramId, since) as { total: number };
    return row.total;
  }

  countPendingWithdrawals(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM vault_withdrawals WHERE status IN ('queued','processing')`).get() as { n: number };
    return row.n;
  }

  // ── Whitelist changes ─────────────────────────────────────────────────
  enqueueWhitelistChange(args: {
    telegramId: number; oldAddress: string | null; newAddress: string;
    requestedAt: number; activatesAt: number; initialStatus: 'pending' | 'activated';
  }): number {
    const info = this.db.prepare(`
      INSERT INTO vault_pending_whitelist_changes(telegram_id, old_address, new_address,
                                                   requested_at, activates_at, status)
      VALUES(?, ?, ?, ?, ?, ?)
    `).run(args.telegramId, args.oldAddress, args.newAddress,
           args.requestedAt, args.activatesAt, args.initialStatus);
    return info.lastInsertRowid as number;
  }

  listDueWhitelistChanges(nowMs: number): PendingWhitelistChange[] {
    return (this.db.prepare(`
      SELECT * FROM vault_pending_whitelist_changes
      WHERE status='pending' AND activates_at <= ?
      ORDER BY activates_at
    `).all(nowMs) as any[]).map(r => this.rowToWhitelistChange(r));
  }

  mostRecentPendingChange(telegramId: number): PendingWhitelistChange | null {
    const row = this.db.prepare(`
      SELECT * FROM vault_pending_whitelist_changes
      WHERE telegram_id=? AND status='pending'
      ORDER BY requested_at DESC LIMIT 1
    `).get(telegramId) as any;
    return row ? this.rowToWhitelistChange(row) : null;
  }

  markWhitelistActivated(id: number): void {
    this.db.prepare(`UPDATE vault_pending_whitelist_changes SET status='activated' WHERE id=?`)
      .run(id);
  }

  cancelPendingWhitelist(id: number, reason: string): void {
    this.db.prepare(`UPDATE vault_pending_whitelist_changes SET status='cancelled', cancel_reason=? WHERE id=?`)
      .run(reason, id);
  }

  // ── NAV snapshots ─────────────────────────────────────────────────────
  insertNavSnapshot(row: NavSnapshotRow): void {
    this.db.prepare(`
      INSERT INTO vault_nav_snapshots(ts, total_value_usd, total_shares, nav_per_share, source)
      VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(ts) DO UPDATE SET total_value_usd=excluded.total_value_usd,
        total_shares=excluded.total_shares, nav_per_share=excluded.nav_per_share, source=excluded.source
    `).run(row.ts, row.totalValueUsd, row.totalShares, row.navPerShare, row.source);
  }

  latestNavSnapshot(): NavSnapshotRow | null {
    const row = this.db.prepare(`SELECT * FROM vault_nav_snapshots ORDER BY ts DESC LIMIT 1`).get() as any;
    if (!row) return null;
    return {
      ts: row.ts, totalValueUsd: row.total_value_usd, totalShares: row.total_shares,
      navPerShare: row.nav_per_share, source: row.source,
    };
  }

  navSnapshotAtOrBefore(ts: number): NavSnapshotRow | null {
    const row = this.db.prepare(`SELECT * FROM vault_nav_snapshots WHERE ts<=? ORDER BY ts DESC LIMIT 1`)
      .get(ts) as any;
    if (!row) return null;
    return {
      ts: row.ts, totalValueUsd: row.total_value_usd, totalShares: row.total_shares,
      navPerShare: row.nav_per_share, source: row.source,
    };
  }

  // ── Audit log ─────────────────────────────────────────────────────────
  writeAudit(args: { ts: number; telegramId: number | null; event: string; detailsJson: string }): void {
    this.db.prepare(`
      INSERT INTO vault_audit_log(ts, telegram_id, event, details_json) VALUES(?, ?, ?, ?)
    `).run(args.ts, args.telegramId, args.event, args.detailsJson);
  }

  listAudit(args: { sinceTs: number; limit: number }): Array<{ ts: number; telegramId: number | null; event: string; detailsJson: string }> {
    return (this.db.prepare(`SELECT * FROM vault_audit_log WHERE ts>=? ORDER BY ts DESC LIMIT ?`)
      .all(args.sinceTs, args.limit) as any[])
      .map(r => ({ ts: r.ts, telegramId: r.telegram_id, event: r.event, detailsJson: r.details_json }));
  }

  // ── Row mappers ───────────────────────────────────────────────────────
  private rowToUser(r: any): VaultUser {
    return {
      telegramId: r.telegram_id, role: r.role, depositAddress: r.deposit_address,
      totpEnrolledAt: r.totp_enrolled_at, totpLastUsedCounter: r.totp_last_used_counter,
      whitelistAddress: r.whitelist_address, whitelistSetAt: r.whitelist_set_at,
      disclaimerAt: r.disclaimer_at, createdAt: r.created_at,
    };
  }
  private rowToDeposit(r: any): VaultDeposit {
    return {
      id: r.id, telegramId: r.telegram_id, inboundTxSig: r.inbound_tx_sig, sweepTxSig: r.sweep_tx_sig,
      solLamports: BigInt(r.sol_lamports), bertRaw: BigInt(r.bert_raw),
      solUsd: r.sol_usd, bertUsd: r.bert_usd, navPerShareAt: r.nav_per_share_at,
      sharesMinted: r.shares_minted, confirmedAt: r.confirmed_at, sweptAt: r.swept_at,
    };
  }
  private rowToWithdrawal(r: any): VaultWithdrawal {
    return {
      id: r.id, telegramId: r.telegram_id, status: r.status, destination: r.destination,
      sharesBurned: r.shares_burned, feeShares: r.fee_shares, navPerShareAt: r.nav_per_share_at,
      solLamportsOut: r.sol_lamports_out === null ? null : BigInt(r.sol_lamports_out),
      bertRawOut: r.bert_raw_out === null ? null : BigInt(r.bert_raw_out),
      txSig: r.tx_sig, failureReason: r.failure_reason,
      queuedAt: r.queued_at, processedAt: r.processed_at,
    };
  }
  private rowToWhitelistChange(r: any): PendingWhitelistChange {
    return {
      id: r.id, telegramId: r.telegram_id, oldAddress: r.old_address, newAddress: r.new_address,
      requestedAt: r.requested_at, activatesAt: r.activates_at, status: r.status,
      cancelReason: r.cancel_reason,
    };
  }
}
