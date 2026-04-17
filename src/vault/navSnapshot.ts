import { SOL_DECIMALS, BERT_DECIMALS } from './shareMath.js';

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
