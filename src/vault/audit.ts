import type { DepositorStore } from './depositorStore.js';

/**
 * Canonical set of audit event names emitted by vault handlers.
 * Keep this in sync with vault-design.md audit-event table.
 */
export type AuditEvent =
  | 'disclaimer_accepted'
  | 'totp_enrolled'
  | 'deposit_reveal'
  | 'balance_reveal'
  | 'whitelist_set'
  | 'whitelist_cancel'
  | 'withdrawal_queued'
  | 'withdrawal_completed'
  | 'withdrawal_failed'
  | 'withdrawal_db_sync_failed'
  | 'totp_verify_failed'
  | 'totp_rate_limited'
  | 'totp_reset'
  | 'vault_paused'
  | 'vault_resumed'
  | 'withdrawal_requeued'
  | 'deposit_detected'
  | 'deposit_swept'
  | 'deposit_sweep_failed'
  | 'deposit_deferred_oracle_unavailable'
  | 'deposit_recredited'
  | 'whitelist_activated'
  | 'bootstrap';

/**
 * Thin typed wrapper around DepositorStore.writeAudit so call sites get a
 * compile-time check on event names + consistent JSON encoding of details.
 */
export class AuditLog {
  constructor(private store: DepositorStore) {}

  write(args: {
    ts: number;
    telegramId: number | null;
    event: AuditEvent;
    details?: Record<string, unknown>;
  }): void {
    this.store.writeAudit({
      ts: args.ts,
      telegramId: args.telegramId,
      event: args.event,
      detailsJson: JSON.stringify(args.details ?? {}),
    });
  }
}
