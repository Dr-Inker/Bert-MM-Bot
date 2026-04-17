import type { DepositorStore } from './depositorStore.js';
import {
  computeNavPerShare, usdForShares, splitUsdIntoTokens,
} from './shareMath.js';
import { computeNav } from './navSnapshot.js';

export interface ExecutorDeps {
  store: DepositorStore;
  getMid: () => Promise<{ solUsd: number; bertUsd: number } | null>;
  getWalletBalances: () => Promise<{ solLamports: bigint; bertRaw: bigint }>;
  getPositionSnapshot: () => Promise<{
    totalValueUsd: number;
    solUsdInPosition: number;
    bertUsdInPosition: number;
  }>;
  reserveSolLamports: bigint;
  partialClose: (args: { needSolLamports: bigint; needBertRaw: bigint }) => Promise<void>;
  executeTransfer: (args: {
    destination: string;
    solLamports: bigint;
    bertRaw: bigint;
  }) => Promise<{ txSig: string }>;
  now: () => number;
}

/**
 * Drains queued withdrawals one at a time. For each request:
 *   1. mark processing, fetch oracle/balances/position snapshot
 *   2. compute owed USD (netShares * navPerShare) and split into (SOL, BERT)
 *   3. if free balances (minus reserve) fall short, call partialClose and re-check
 *   4. executeTransfer then completeWithdrawal in a single tx; on failure, mark failed
 */
export class WithdrawalExecutor {
  constructor(private deps: ExecutorDeps) {}

  async drain(): Promise<void> {
    const queued = this.deps.store.listWithdrawalsByStatus('queued');
    for (const w of queued) {
      this.deps.store.setWithdrawalProcessing(w.id);
      try {
        await this.processOne(w.id);
      } catch (e) {
        // N1: If the row already has a tx_sig populated, the on-chain
        // transfer landed but the downstream DB work failed. Marking the row
        // `failed` would mislead /forceprocess into requeuing — double-pay.
        // Leave the row in `processing` and let the operator reconcile via
        // the `withdrawal_db_sync_failed` audit already written by processOne.
        const current = this.deps.store.getWithdrawalById(w.id);
        if (current?.txSig) {
          // Already audited in processOne; just continue without marking failed.
          continue;
        }
        const reason = e instanceof Error ? `unexpected: ${e.message}` : 'unexpected_error';
        this.deps.store.failWithdrawal({ id: w.id, reason, processedAt: this.deps.now() });
        // Do not re-throw — continue processing remaining withdrawals.
      }
    }
  }

  private async processOne(id: number): Promise<void> {
    const now = this.deps.now();
    const mid = await this.deps.getMid();
    if (!mid) {
      this.deps.store.failWithdrawal({ id, reason: 'oracle_unavailable', processedAt: now });
      return;
    }

    const row = this.deps.store.listWithdrawalsByStatus('processing').find(r => r.id === id);
    if (!row) return;

    const bal = await this.deps.getWalletBalances();
    const pos = await this.deps.getPositionSnapshot();

    const nav = computeNav({
      freeSolLamports: bal.solLamports,
      freeBertRaw: bal.bertRaw,
      positionTotalValueUsd: pos.totalValueUsd,
      uncollectedFeesBert: 0n,
      uncollectedFeesSol: 0n,
      solUsd: mid.solUsd,
      bertUsd: mid.bertUsd,
    });
    const totalShares = this.deps.store.totalShares();
    const navPerShare = computeNavPerShare({ totalUsd: nav.totalUsd, totalShares });

    const netShares = row.sharesBurned - row.feeShares;
    const usdOwed = usdForShares({ netShares, navPerShare });

    const { solLamports: needSolNum, bertRaw: needBertNum } = splitUsdIntoTokens({
      usd: usdOwed,
      solFrac: nav.solFrac,
      solUsd: mid.solUsd,
      bertUsd: mid.bertUsd,
    });
    const needSol = BigInt(needSolNum);
    const needBert = BigInt(needBertNum);

    const solAvailable = bal.solLamports > this.deps.reserveSolLamports
      ? bal.solLamports - this.deps.reserveSolLamports
      : 0n;

    if (needSol > solAvailable || needBert > bal.bertRaw) {
      const solShortPos = needSol > solAvailable ? needSol - solAvailable : 0n;
      const bertShortPos = needBert > bal.bertRaw ? needBert - bal.bertRaw : 0n;
      if (solShortPos > 0n || bertShortPos > 0n) {
        await this.deps.partialClose({
          needSolLamports: solShortPos,
          needBertRaw: bertShortPos,
        });
      }
      // Re-read balances after partial close
      const bal2 = await this.deps.getWalletBalances();
      const solAvail2 = bal2.solLamports > this.deps.reserveSolLamports
        ? bal2.solLamports - this.deps.reserveSolLamports
        : 0n;
      if (needSol > solAvail2 || needBert > bal2.bertRaw) {
        this.deps.store.failWithdrawal({ id, reason: 'reserves_insufficient', processedAt: now });
        return;
      }
    }

    // Execute the on-chain transfer. If this throws, no funds have moved and
    // we can safely mark the row failed below (in the transfer-failure catch).
    let transferSig: string;
    try {
      const r = await this.deps.executeTransfer({
        destination: row.destination,
        solLamports: needSol,
        bertRaw: needBert,
      });
      transferSig = r.txSig;
    } catch (e) {
      const reason = e instanceof Error ? e.message : 'unknown';
      this.deps.store.failWithdrawal({ id, reason, processedAt: now });
      this.deps.store.writeAudit({
        ts: now,
        telegramId: row.telegramId,
        event: 'withdrawal_failed',
        detailsJson: JSON.stringify({ id, reason }),
      });
      return;
    }

    // N1: pre-commit the on-chain tx signature BEFORE the completeWithdrawal
    // transaction. If the subsequent DB work fails, the populated tx_sig is
    // the authoritative signal that funds are already on-chain and the row
    // must NOT be requeued via /forceprocess (it would double-pay).
    try {
      this.deps.store.markWithdrawalSent({ id, txSig: transferSig });
    } catch (e) {
      // Defence in depth: if we can't even record the tx_sig (race / db lock),
      // emit a high-severity audit and leave the row as-is (processing). The
      // operator will see it in /vaultstatus and can reconcile manually.
      this.deps.store.writeAudit({
        ts: now,
        telegramId: row.telegramId,
        event: 'withdrawal_db_sync_failed',
        detailsJson: JSON.stringify({
          id, txSig: transferSig,
          error: e instanceof Error ? e.message : String(e),
          stage: 'markWithdrawalSent',
        }),
      });
      return;
    }

    try {
      // Snapshot totalShares BEFORE the burn so we can compute the
      // post-withdrawal pool value as (totalSharesBefore - netShares) * navPerShare.
      // Only netShares' worth of USD leaves the pool; feeShares stay in-pool
      // and accrete to remaining holders. Using totalShares()*navPerShare
      // after the burn would under-count pool value by feeShares*navPerShare.
      const totalSharesBefore = this.deps.store.totalShares();
      const postBurnTotalValueUsd = (totalSharesBefore - netShares) * navPerShare;
      this.deps.store.withTransaction(() => {
        this.deps.store.completeWithdrawal({
          id,
          txSig: transferSig,
          solLamportsOut: needSol,
          bertRawOut: needBert,
          navPerShareAt: navPerShare,
          processedAt: now,
        });
        this.deps.store.insertNavSnapshot({
          ts: now,
          totalValueUsd: postBurnTotalValueUsd,
          totalShares: this.deps.store.totalShares(),
          navPerShare,
          source: 'withdrawal',
        });
        this.deps.store.writeAudit({
          ts: now,
          telegramId: row.telegramId,
          event: 'withdrawal_completed',
          detailsJson: JSON.stringify({
            id, txSig: transferSig, sharesBurned: row.sharesBurned,
            feeShares: row.feeShares, usdOwed, navPerShare,
          }),
        });
      });
    } catch (e) {
      // N1: funds ARE on-chain (transferSig confirmed, tx_sig persisted), but
      // the share-burn / NAV snapshot / audit transaction failed. Leave the
      // row in 'processing' with tx_sig populated — operator must investigate
      // and reconcile manually. Do NOT fail the row: that would invite a
      // /forceprocess-driven double-pay.
      const reason = e instanceof Error ? e.message : String(e);
      this.deps.store.writeAudit({
        ts: now,
        telegramId: row.telegramId,
        event: 'withdrawal_db_sync_failed',
        detailsJson: JSON.stringify({
          id, txSig: transferSig, error: reason, stage: 'completeWithdrawal',
        }),
      });
      // Re-throw so the outer drain() catch logs at error level and the
      // operator sees it; the row is already safe (tx_sig blocks requeue).
      throw new Error(`withdrawal #${id} db sync failed after transfer: ${reason}`);
    }
  }
}
