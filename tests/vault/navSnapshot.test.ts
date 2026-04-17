import { describe, it, expect } from 'vitest';
import {
  computeNav,
  computeVaultStats,
  formatVaultStatsLine,
} from '../../src/vault/navSnapshot.js';
import type { NavSnapshotRow } from '../../src/vault/types.js';

describe('navSnapshot', () => {
  it('sums free + position + fees', () => {
    const r = computeNav({
      freeSolLamports: 1_000_000_000n,   // 1 SOL
      freeBertRaw: 100_000_000n,         // 100 BERT
      positionTotalValueUsd: 50,
      uncollectedFeesBert: 1_000_000n,   // 1 BERT
      uncollectedFeesSol: 0n,
      solUsd: 100,
      bertUsd: 0.01,
    });
    // free: 1 × 100 + 100 × 0.01 = 100 + 1 = 101
    // position: 50
    // fees: 1 × 0.01 = 0.01
    expect(r.totalUsd).toBeCloseTo(151.01);
    expect(r.freeUsd).toBeCloseTo(101);
    expect(r.positionUsd).toBe(50);
    expect(r.feesUsd).toBeCloseTo(0.01);
  });

  it('handles zero position', () => {
    const r = computeNav({
      freeSolLamports: 2_000_000_000n,
      freeBertRaw: 0n,
      positionTotalValueUsd: 0,
      uncollectedFeesBert: 0n,
      uncollectedFeesSol: 0n,
      solUsd: 150,
      bertUsd: 0.01,
    });
    expect(r.totalUsd).toBeCloseTo(300);
  });

  it('computes solFrac for token split', () => {
    const r = computeNav({
      freeSolLamports: 1_000_000_000n,   // 1 SOL = $100
      freeBertRaw: 10_000_000n,          // 10 BERT = $0.10
      positionTotalValueUsd: 0,
      uncollectedFeesBert: 0n,
      uncollectedFeesSol: 0n,
      solUsd: 100,
      bertUsd: 0.01,
    });
    // freeUsd=100.10 — 100 SOL, 0.10 BERT → solFrac ~ 100/100.10
    expect(r.solFrac).toBeCloseTo(100 / 100.10, 3);
  });
});

describe('computeVaultStats', () => {
  it('computes NAV/share and 24h delta from baseline snapshot', () => {
    const baseline: NavSnapshotRow = {
      ts: 0,
      totalValueUsd: 100,
      totalShares: 100,
      navPerShare: 1.0,
      source: 'hourly',
    };
    const s = computeVaultStats({
      depositorCount: 3,
      totalShares: 100,
      tvlUsd: 110,         // +10% TVL, same shares → NAV/share = 1.10
      queuedWithdrawals: 2,
      snapshot24hAgo: baseline,
    });
    expect(s.depositorCount).toBe(3);
    expect(s.tvlUsd).toBe(110);
    expect(s.totalShares).toBe(100);
    expect(s.navPerShare).toBeCloseTo(1.10);
    expect(s.navPerShareDelta24hPct).toBeCloseTo(10.0);
    expect(s.queuedWithdrawals).toBe(2);
  });

  it('returns 0% delta when no baseline snapshot', () => {
    const s = computeVaultStats({
      depositorCount: 1,
      totalShares: 50,
      tvlUsd: 75,
      queuedWithdrawals: 0,
      snapshot24hAgo: null,
    });
    expect(s.navPerShare).toBeCloseTo(1.5);
    expect(s.navPerShareDelta24hPct).toBe(0);
  });

  it('returns sentinel NAV/share when no shares outstanding', () => {
    const s = computeVaultStats({
      depositorCount: 0,
      totalShares: 0,
      tvlUsd: 0,
      queuedWithdrawals: 0,
      snapshot24hAgo: null,
    });
    expect(s.navPerShare).toBe(1); // computeNavPerShare sentinel
  });

  it('handles negative delta', () => {
    const baseline: NavSnapshotRow = {
      ts: 0, totalValueUsd: 100, totalShares: 100, navPerShare: 1.0, source: 'hourly',
    };
    const s = computeVaultStats({
      depositorCount: 2,
      totalShares: 100,
      tvlUsd: 95,          // -5%
      queuedWithdrawals: 0,
      snapshot24hAgo: baseline,
    });
    expect(s.navPerShareDelta24hPct).toBeCloseTo(-5.0);
  });

  it('formatVaultStatsLine produces expected string with positive delta', () => {
    const line = formatVaultStatsLine({
      depositorCount: 3,
      tvlUsd: 1234.56,
      totalShares: 1000,
      navPerShare: 1.2346,
      navPerShareDelta24hPct: 1.23,
      queuedWithdrawals: 2,
    });
    expect(line).toBe(
      'Vault: 3 depositors, TVL $1234.56, NAV/share $1.2346 (24h Δ +1.23%), 2 queued',
    );
  });

  it('formatVaultStatsLine produces expected string with negative delta', () => {
    const line = formatVaultStatsLine({
      depositorCount: 1,
      tvlUsd: 50,
      totalShares: 50,
      navPerShare: 1.0,
      navPerShareDelta24hPct: -0.5,
      queuedWithdrawals: 0,
    });
    expect(line).toBe(
      'Vault: 1 depositors, TVL $50.00, NAV/share $1.0000 (24h Δ -0.50%), 0 queued',
    );
  });
});
