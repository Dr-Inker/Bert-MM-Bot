import type { StoredPosition } from './stateStore.js';
import type { PositionSnapshot } from './types.js';

export type ReconcileResult =
  | { kind: 'OK_EMPTY' }
  | { kind: 'OK_MATCH' }
  | { kind: 'MISMATCH'; reason: string };

const TOLERANCE = 1e-6;

function approxEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < TOLERANCE;
}

export function reconcile(
  stored: StoredPosition | null,
  onchain: PositionSnapshot | null,
): ReconcileResult {
  if (stored === null && onchain === null) return { kind: 'OK_EMPTY' };
  if (stored === null) {
    return { kind: 'MISMATCH', reason: 'chain has position but state.db does not' };
  }
  if (onchain === null) {
    return { kind: 'MISMATCH', reason: 'state.db has position but chain does not' };
  }
  if (stored.nftMint !== onchain.nftMint) {
    return {
      kind: 'MISMATCH',
      reason: `nft mint differs: stored=${stored.nftMint} chain=${onchain.nftMint}`,
    };
  }
  if (!approxEqual(stored.lowerUsd, onchain.range.lowerBertUsd)) {
    return {
      kind: 'MISMATCH',
      reason: `lower price differs: stored=${stored.lowerUsd} chain=${onchain.range.lowerBertUsd}`,
    };
  }
  if (!approxEqual(stored.upperUsd, onchain.range.upperBertUsd)) {
    return { kind: 'MISMATCH', reason: 'upper price differs' };
  }
  return { kind: 'OK_MATCH' };
}
