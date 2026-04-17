import { SOL_DECIMALS, BERT_DECIMALS, computeNavPerShare } from './shareMath.js';
import type { NavSnapshotRow } from './types.js';

export interface NavInputs {
  freeSolLamports: bigint;
  freeBertRaw: bigint;
  positionTotalValueUsd: number;
  uncollectedFeesBert: bigint;
  uncollectedFeesSol: bigint;
  solUsd: number;
  bertUsd: number;
}

export interface NavSnapshot {
  totalUsd: number;
  freeUsd: number;
  positionUsd: number;
  feesUsd: number;
  solFrac: number;       // 0..1, SOL's share of free+position by USD value
}

/**
 * Compute NAV from on-chain state + oracle prices.
 * Matches the hourly-report math previously inlined in main.ts.
 */
export function computeNav(i: NavInputs): NavSnapshot {
  const freeSol = Number(i.freeSolLamports) / 10 ** SOL_DECIMALS;
  const freeBert = Number(i.freeBertRaw) / 10 ** BERT_DECIMALS;
  const feeBert = Number(i.uncollectedFeesBert) / 10 ** BERT_DECIMALS;
  const feeSol = Number(i.uncollectedFeesSol) / 10 ** SOL_DECIMALS;

  const freeUsd = freeSol * i.solUsd + freeBert * i.bertUsd;
  const feesUsd = feeBert * i.bertUsd + feeSol * i.solUsd;
  const positionUsd = i.positionTotalValueUsd;
  const totalUsd = freeUsd + positionUsd + feesUsd;

  // Estimate SOL fraction of the free+position value (fees are negligible + uncertain).
  // Assumes the position holds tokens in the same ratio as the pool's current composition;
  // without per-bin composition data, we approximate using free balances + position.
  // For MVP, use freeUsd composition as the proxy for withdrawal token split.
  const freeSolUsd = freeSol * i.solUsd;
  const solFrac = freeUsd > 0 ? freeSolUsd / freeUsd : 0.5;

  return { totalUsd, freeUsd, positionUsd, feesUsd, solFrac };
}

export interface VaultStats {
  depositorCount: number;
  tvlUsd: number;
  totalShares: number;
  navPerShare: number;
  /** 24h change in NAV/share as a percentage (e.g. 1.5 = +1.5%). 0 if no baseline. */
  navPerShareDelta24hPct: number;
  queuedWithdrawals: number;
}

export interface VaultStatsInputs {
  depositorCount: number;
  totalShares: number;
  tvlUsd: number;
  queuedWithdrawals: number;
  /** NAV snapshot from approximately 24h ago. Null if none. */
  snapshot24hAgo: NavSnapshotRow | null;
}

/**
 * Compute vault summary stats for the hourly Telegram report.
 *
 * `tvlUsd` is the live NAV (caller supplies — typically `computeNav().totalUsd`
 * using fresh balances + position value) so the figure stays current even
 * when the most recent DB snapshot is stale.
 *
 * The 24h delta compares current NAV/share against `snapshot24hAgo.navPerShare`.
 * Returns 0% when no baseline exists (e.g. vault < 24h old) or when the
 * baseline is effectively zero.
 */
export function computeVaultStats(i: VaultStatsInputs): VaultStats {
  const navPerShare = computeNavPerShare({
    totalUsd: i.tvlUsd,
    totalShares: i.totalShares,
  });
  let navPerShareDelta24hPct = 0;
  if (i.snapshot24hAgo && i.snapshot24hAgo.navPerShare > 0) {
    navPerShareDelta24hPct =
      ((navPerShare - i.snapshot24hAgo.navPerShare) / i.snapshot24hAgo.navPerShare) * 100;
  }
  return {
    depositorCount: i.depositorCount,
    tvlUsd: i.tvlUsd,
    totalShares: i.totalShares,
    navPerShare,
    navPerShareDelta24hPct,
    queuedWithdrawals: i.queuedWithdrawals,
  };
}

/** Format the vault stats line shown in the hourly Telegram report. */
export function formatVaultStatsLine(s: VaultStats): string {
  const sign = s.navPerShareDelta24hPct >= 0 ? '+' : '';
  return (
    `Vault: ${s.depositorCount} depositors, TVL $${s.tvlUsd.toFixed(2)}, ` +
    `NAV/share $${s.navPerShare.toFixed(4)} ` +
    `(24h Δ ${sign}${s.navPerShareDelta24hPct.toFixed(2)}%), ` +
    `${s.queuedWithdrawals} queued`
  );
}
