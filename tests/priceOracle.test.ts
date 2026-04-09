import { describe, it, expect } from 'vitest';
import { computeTrustedMid, PriceSample } from '../src/priceOracle.js';

const now = 1_700_000_000_000;

function sample(source: string, bertUsd: number): PriceSample {
  return { source, bertUsd, solUsd: 150, bertPerSol: 150 / bertUsd, ts: now };
}

describe('priceOracle divergence logic', () => {
  it('returns trusted mid when all 3 sources agree', () => {
    const mid = computeTrustedMid(
      [sample('raydium', 0.0082), sample('jupiter', 0.00821), sample('dexscreener', 0.00819)],
      150,
      now,
    );
    expect(mid).not.toBeNull();
    expect(mid!.sources).toEqual(['raydium', 'jupiter', 'dexscreener']);
  });

  it('returns null when sources diverge beyond threshold', () => {
    const mid = computeTrustedMid(
      [sample('raydium', 0.0082), sample('jupiter', 0.0095), sample('dexscreener', 0.0081)],
      150,
      now,
    );
    expect(mid).toBeNull();
  });

  it('returns mid with 2 agreeing sources if 3rd is missing', () => {
    const mid = computeTrustedMid([sample('raydium', 0.0082), sample('jupiter', 0.00821)], 150, now);
    expect(mid).not.toBeNull();
    expect(mid!.sources).toHaveLength(2);
  });

  it('returns null with only 1 source', () => {
    const mid = computeTrustedMid([sample('raydium', 0.0082)], 150, now);
    expect(mid).toBeNull();
  });

  it('returns null with empty input', () => {
    const mid = computeTrustedMid([], 150, now);
    expect(mid).toBeNull();
  });

  it('rejects 2% spread when threshold is 150 bps', () => {
    const mid = computeTrustedMid(
      [sample('raydium', 0.0080), sample('jupiter', 0.00816), sample('dexscreener', 0.0081)],
      150,
      now,
      150,
    );
    expect(mid).toBeNull();
  });

  it('tolerates small within-threshold divergence', () => {
    const mid = computeTrustedMid(
      [sample('raydium', 0.0080), sample('jupiter', 0.00808), sample('dexscreener', 0.0081)],
      150,
      now,
      150,
    );
    expect(mid).not.toBeNull();
  });
});
