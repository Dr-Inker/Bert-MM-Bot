import {
  Connection, Keypair, PublicKey, Transaction,
} from '@solana/web3.js';
import type { Logger } from 'pino';
import type { DepositorStore } from './depositorStore.js';
import type { CreditEngine } from './creditEngine.js';
import type { InflowEvent } from './depositWatcher.js';
import { decrypt } from './encryption.js';
import { buildSweepInstructions } from './sweeper.js';

export interface DepositPipelineDeps {
  store: DepositorStore;
  connection: Connection;
  /** Main pool wallet. Receives swept funds and signs the sweep tx as fee payer. */
  payerKeypair: Keypair;
  bertMint: PublicKey;
  masterKey: Buffer;
  creditEngine: CreditEngine;
  /** Oracle lookup for USD-value at credit time. Returns null when oracle is unhealthy. */
  getMid: () => Promise<{ solUsd: number; bertUsd: number } | null>;
  /** NAV/share at the moment of credit — determines share issuance. */
  getNavPerShare: () => Promise<number>;
  /** Lamports to leave in the deposit address to keep the BERT ATA rent-exempt. */
  rentReserveLamports: bigint;
  now: () => number;
  log: Logger;
  /**
   * Submit a pre-built transaction and return its signature. Tests override to
   * avoid touching the RPC. Production wires this to txSubmitter or a raw
   * sendAndConfirm — whichever the caller prefers.
   */
  submitTx: (tx: Transaction, extraSigners: Keypair[]) => Promise<string>;
}

/**
 * Glues deposit-watcher → sweeper → creditEngine together as the onInflow
 * callback. The watcher calls `onInflow(event)` for every new signature that
 * moves SOL or BERT into a user's deposit address; this pipeline:
 *
 *   1. Looks up the user by deposit address.
 *   2. Decrypts the deposit keypair using the master key.
 *   3. Builds + submits a sweep tx that moves funds to the pool wallet.
 *   4. On sweep confirmation, calls CreditEngine.credit to mint shares and
 *      write the NAV snapshot + audit row in a single DB transaction.
 *   5. On any failure, writes a `deposit_sweep_failed` audit row and re-raises
 *      nothing — the caller (depositWatcher) continues polling.
 *
 * Idempotency: the watcher already filters signatures it has already credited
 * via `isAlreadyCredited`, and the `inbound_tx_sig` UNIQUE constraint on
 * `vault_deposits` is the authoritative guard. A sweep that fails partway
 * through is safe to retry because the watcher will re-emit the same signature
 * on the next poll (it won't appear in `isAlreadyCredited` until credit
 * completes) — but the deposit address may be partially drained, which is
 * exactly what the sweeper's "drain whatever is left" semantics are designed
 * for.
 */
export class DepositPipeline {
  constructor(private deps: DepositPipelineDeps) {}

  async onInflow(event: InflowEvent): Promise<void> {
    const user = this.deps.store.getUserByDepositAddress(event.depositAddress);
    if (!user) {
      this.deps.log.warn({ event }, 'deposit: unknown address (no user row)');
      return;
    }

    // Log detection immediately so we have a durable record even if sweep fails.
    this.deps.store.writeAudit({
      ts: this.deps.now(),
      telegramId: user.telegramId,
      event: 'deposit_detected',
      detailsJson: JSON.stringify({
        inboundTxSig: event.inboundTxSig,
        solLamports: event.solLamports.toString(),
        bertRaw: event.bertRaw.toString(),
      }),
    });

    // N2: Preflight the oracle BEFORE sweeping. If the oracle is unhealthy we
    // cannot compute a NAV/share to credit shares against, and sweeping first
    // would leave funds stuck in the main wallet with no way to retry (the
    // deposit address is drained). Defer by returning — the watcher will
    // re-emit the same inboundTxSig on the next poll and we'll try again.
    const preflightMid = await this.deps.getMid();
    if (!preflightMid) {
      this.deps.log.warn(
        { telegramId: user.telegramId, inboundTxSig: event.inboundTxSig },
        'deposit: oracle unhealthy — deferring sweep until oracle recovers',
      );
      this.deps.store.writeAudit({
        ts: this.deps.now(),
        telegramId: user.telegramId,
        event: 'deposit_deferred_oracle_unavailable',
        detailsJson: JSON.stringify({ inboundTxSig: event.inboundTxSig }),
      });
      return;
    }

    // Decrypt the deposit keypair for signing.
    const secrets = this.deps.store.getUserSecrets(user.telegramId);
    if (!secrets) {
      this.deps.log.error({ telegramId: user.telegramId }, 'deposit: secrets row missing');
      return;
    }
    let depositKp: Keypair;
    try {
      const secretBytes = decrypt(secrets.depositSecretEnc, secrets.depositSecretIv, this.deps.masterKey);
      depositKp = Keypair.fromSecretKey(secretBytes);
    } catch (e) {
      this.deps.log.error({ err: e, telegramId: user.telegramId }, 'deposit: decrypt failed');
      this.recordFailure(user.telegramId, event, 'decrypt_failed');
      return;
    }

    // Build sweep instructions.
    let ixs;
    try {
      ixs = buildSweepInstructions({
        fromKeypair: depositKp,
        toWallet: this.deps.payerKeypair.publicKey,
        solLamports: event.solLamports,
        bertRaw: event.bertRaw,
        bertMint: this.deps.bertMint,
        rentReserveLamports: this.deps.rentReserveLamports,
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.deps.log.warn({ err: e, telegramId: user.telegramId }, 'deposit: sweep build failed');
      this.recordFailure(user.telegramId, event, `sweep_build_failed: ${reason}`);
      return;
    }
    if (ixs.length === 0) {
      // Nothing to do — shouldn't happen (watcher filters zero-delta), but be safe.
      this.deps.log.info({ telegramId: user.telegramId }, 'deposit: zero sweep ixs, skipping');
      return;
    }

    // Build + submit the sweep tx. The deposit keypair co-signs (source of
    // funds); the payer keypair covers fees.
    const tx = new Transaction();
    for (const ix of ixs) tx.add(ix);
    const { blockhash } = await this.deps.connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = this.deps.payerKeypair.publicKey;

    let sweepSig: string;
    try {
      sweepSig = await this.deps.submitTx(tx, [depositKp]);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.deps.log.error({ err: e, telegramId: user.telegramId }, 'deposit: sweep submit failed');
      this.recordFailure(user.telegramId, event, `sweep_submit_failed: ${reason}`);
      return;
    }
    const sweptAt = this.deps.now();
    // N2: include amounts in deposit_swept so /recreditdeposit can recover
    // without needing to cross-reference deposit_detected for the figures.
    this.deps.store.writeAudit({
      ts: sweptAt,
      telegramId: user.telegramId,
      event: 'deposit_swept',
      detailsJson: JSON.stringify({
        inboundTxSig: event.inboundTxSig,
        sweepTxSig: sweepSig,
        solLamports: event.solLamports.toString(),
        bertRaw: event.bertRaw.toString(),
        confirmedAt: event.confirmedAt,
      }),
    });

    // Oracle snapshot for USD conversion + NAV per share.
    const mid = await this.deps.getMid();
    if (!mid) {
      this.deps.log.error({ telegramId: user.telegramId, sweepSig },
        'deposit: oracle unhealthy — credit deferred (will re-process on next poll)');
      // The sweep landed but we could not record shares; this row will NOT
      // prevent a retry because the watcher uses vault_deposits as the
      // idempotency oracle. On the next poll, the same inboundTxSig will be
      // re-emitted and we'll try again. Sweep itself is idempotent-ish: if
      // the deposit address is empty, buildSweepInstructions returns 0 ixs.
      this.recordFailure(user.telegramId, event, 'oracle_unavailable_after_sweep');
      return;
    }
    const navPerShare = await this.deps.getNavPerShare();

    try {
      this.deps.creditEngine.credit({
        telegramId: user.telegramId,
        inboundTxSig: event.inboundTxSig,
        sweepTxSig: sweepSig,
        solLamports: event.solLamports,
        bertRaw: event.bertRaw,
        solUsd: mid.solUsd,
        bertUsd: mid.bertUsd,
        navPerShareAtDeposit: navPerShare,
        confirmedAt: event.confirmedAt,
        sweptAt,
        now: sweptAt,
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.deps.log.error({ err: e, telegramId: user.telegramId, sweepSig },
        'deposit: credit failed');
      this.recordFailure(user.telegramId, event, `credit_failed: ${reason}`);
    }
  }

  private recordFailure(telegramId: number, event: InflowEvent, reason: string): void {
    this.deps.store.writeAudit({
      ts: this.deps.now(),
      telegramId,
      event: 'deposit_sweep_failed',
      detailsJson: JSON.stringify({
        inboundTxSig: event.inboundTxSig,
        reason,
      }),
    });
  }
}
