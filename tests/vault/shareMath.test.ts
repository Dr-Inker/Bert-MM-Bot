import { describe, it, expect } from 'vitest';
import {
  computeNavPerShare,
  computeSharesForDeposit,
  splitFee,
  usdForShares,
  splitUsdIntoTokens,
} from '../../src/vault/shareMath.js';

describe('shareMath', () => {
  it('bootstrap NAV is $1 per share when total_shares = total_usd', () => {
    expect(computeNavPerShare({ totalUsd: 220, totalShares: 220 })).toBeCloseTo(1);
  });

  it('handles empty pool (returns $1 as sentinel for first deposit)', () => {
    expect(computeNavPerShare({ totalUsd: 0, totalShares: 0 })).toBe(1);
  });

  it('computes shares = deposit_usd / nav', () => {
    expect(computeSharesForDeposit({ depositUsd: 100, navPerShare: 2 })).toBe(50);
  });

  it('splits 0.3% fee off burned shares', () => {
    const r = splitFee({ sharesBurned: 100, feeBps: 30 });
    expect(r.feeShares).toBeCloseTo(0.3);
    expect(r.netShares).toBeCloseTo(99.7);
  });

  it('splits fee correctly for 0 bps (no fee)', () => {
    const r = splitFee({ sharesBurned: 100, feeBps: 0 });
    expect(r.feeShares).toBe(0);
    expect(r.netShares).toBe(100);
  });

  it('round-trips: deposit then withdraw same shares at same NAV returns USD - fee', () => {
    const navPerShare = 1.05;
    const deposited = 500;
    const shares = computeSharesForDeposit({ depositUsd: deposited, navPerShare });
    const fee = splitFee({ sharesBurned: shares, feeBps: 30 });
    const received = usdForShares({ netShares: fee.netShares, navPerShare });
    expect(received).toBeCloseTo(deposited * (1 - 0.003), 6);
  });

  it('splits USD into SOL+BERT by pool composition', () => {
    const r = splitUsdIntoTokens({
      usd: 100,
      solFrac: 0.6,
      solUsd: 200,
      bertUsd: 0.01,
    });
    expect(r.solLamports).toBe(Math.floor(60 / 200 * 1e9));
    expect(r.bertRaw).toBe(Math.floor(40 / 0.01 * 1e6));
  });

  it('splitUsdIntoTokens handles 100% SOL composition', () => {
    const r = splitUsdIntoTokens({
      usd: 100, solFrac: 1, solUsd: 200, bertUsd: 0.01,
    });
    expect(r.bertRaw).toBe(0);
    expect(r.solLamports).toBe(Math.floor(100 / 200 * 1e9));
  });
});
