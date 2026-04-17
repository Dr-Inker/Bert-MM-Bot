import { describe, it, expect } from 'vitest';
import { computeNav } from '../../src/vault/navSnapshot.js';

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
