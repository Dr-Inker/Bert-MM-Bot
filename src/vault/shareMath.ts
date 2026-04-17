export const SOL_DECIMALS = 9;
export const BERT_DECIMALS = 6;

/** NAV per share = total_usd / total_shares. Returns 1 as sentinel when pool is empty. */
export function computeNavPerShare(args: { totalUsd: number; totalShares: number }): number {
  if (args.totalShares <= 0) return 1;
  return args.totalUsd / args.totalShares;
}

/** shares = deposit_usd / nav_per_share. Assumes navPerShare > 0. */
export function computeSharesForDeposit(args: {
  depositUsd: number;
  navPerShare: number;
}): number {
  if (args.navPerShare <= 0) throw new Error('computeSharesForDeposit: navPerShare must be > 0');
  return args.depositUsd / args.navPerShare;
}

/** Split total burned shares into (fee, net) by fee bps. */
export function splitFee(args: { sharesBurned: number; feeBps: number }): {
  feeShares: number;
  netShares: number;
} {
  const feeShares = args.sharesBurned * (args.feeBps / 10_000);
  return { feeShares, netShares: args.sharesBurned - feeShares };
}

/** USD value of `netShares` at `navPerShare`. */
export function usdForShares(args: { netShares: number; navPerShare: number }): number {
  return args.netShares * args.navPerShare;
}

/** Split USD amount into SOL lamports + BERT raw units based on pool composition fraction. */
export function splitUsdIntoTokens(args: {
  usd: number;
  solFrac: number;     // 0..1 fraction of pool in SOL by USD
  solUsd: number;      // price
  bertUsd: number;     // price
}): { solLamports: number; bertRaw: number } {
  if (args.solUsd <= 0 || args.bertUsd <= 0) {
    throw new Error('splitUsdIntoTokens: prices must be > 0');
  }
  const solUsdShare = args.usd * args.solFrac;
  const bertUsdShare = args.usd * (1 - args.solFrac);
  const solLamports = Math.floor(solUsdShare / args.solUsd * 10 ** SOL_DECIMALS);
  const bertRaw = Math.floor(bertUsdShare / args.bertUsd * 10 ** BERT_DECIMALS);
  return { solLamports, bertRaw };
}
