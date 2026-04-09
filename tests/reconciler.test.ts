import { describe, it, expect } from 'vitest';
import { reconcile } from '../src/reconciler.js';
import type { StoredPosition } from '../src/stateStore.js';
import type { PositionSnapshot } from '../src/types.js';

function mkStored(overrides: Partial<StoredPosition> = {}): StoredPosition {
  return {
    nftMint: 'ABC',
    lowerUsd: 0.008,
    upperUsd: 0.012,
    centerUsd: 0.01,
    openedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function mkOnchain(overrides: Partial<PositionSnapshot> = {}): PositionSnapshot {
  return {
    nftMint: 'ABC',
    range: { lowerBertUsd: 0.008, upperBertUsd: 0.012, centerBertUsd: 0.01, widthPct: 20 },
    bertAmount: 100n,
    solAmount: 100n,
    uncollectedFeesBert: 0n,
    uncollectedFeesSol: 0n,
    totalValueUsd: 2000,
    openedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('reconcile', () => {
  it('OK when both empty', () => {
    expect(reconcile(null, null).kind).toBe('OK_EMPTY');
  });
  it('OK when both match', () => {
    expect(reconcile(mkStored(), mkOnchain()).kind).toBe('OK_MATCH');
  });
  it('MISMATCH when only state has position', () => {
    expect(reconcile(mkStored(), null).kind).toBe('MISMATCH');
  });
  it('MISMATCH when only chain has position', () => {
    expect(reconcile(null, mkOnchain()).kind).toBe('MISMATCH');
  });
  it('MISMATCH when NFT mints differ', () => {
    expect(reconcile(mkStored({ nftMint: 'AAA' }), mkOnchain({ nftMint: 'BBB' })).kind).toBe(
      'MISMATCH',
    );
  });
  it('MISMATCH when ranges differ', () => {
    expect(
      reconcile(
        mkStored({ lowerUsd: 0.008 }),
        mkOnchain({
          range: { lowerBertUsd: 0.009, upperBertUsd: 0.012, centerBertUsd: 0.01, widthPct: 20 },
        }),
      ).kind,
    ).toBe('MISMATCH');
  });
  it('OK within floating-point tolerance', () => {
    expect(
      reconcile(
        mkStored({ lowerUsd: 0.008 }),
        mkOnchain({
          range: { lowerBertUsd: 0.00800001, upperBertUsd: 0.012, centerBertUsd: 0.01, widthPct: 20 },
        }),
      ).kind,
    ).toBe('OK_MATCH');
  });
});
