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

    try {
      const r = await this.deps.executeTransfer({
        destination: row.destination,
        solLamports: needSol,
        bertRaw: needBert,
      });
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
          txSig: r.txSig,
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
            id, txSig: r.txSig, sharesBurned: row.sharesBurned,
            feeShares: row.feeShares, usdOwed, navPerShare,
          }),
        });
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : 'unknown';
      this.deps.store.failWithdrawal({ id, reason, processedAt: now });
      this.deps.store.writeAudit({
        ts: now,
        telegramId: row.telegramId,
        event: 'withdrawal_failed',
        detailsJson: JSON.stringify({ id, reason }),
      });
    }
  }
}
