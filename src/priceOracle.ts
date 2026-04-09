import type { MidPrice } from './types.js';

export interface PriceSample {
  source: string;
  bertUsd: number;
  solUsd: number;
  bertPerSol: number;
  ts: number;
}

export function computeTrustedMid(
  samples: PriceSample[],
  _solUsd: number,
  now: number,
  divergenceBps = 150,
): MidPrice | null {
  if (samples.length < 2) return null;
  const prices = samples.map((s) => s.bertUsd).sort((a, b) => a - b);
  const min = prices[0]!;
  const max = prices[prices.length - 1]!;
  const median = prices[Math.floor(prices.length / 2)]!;
  const divergence = ((max - min) / median) * 10_000;
  if (divergence > divergenceBps) return null;
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  const solUsdMean = samples.reduce((a, s) => a + s.solUsd, 0) / samples.length;
  return {
    bertUsd: mean,
    solUsd: solUsdMean,
    bertPerSol: solUsdMean / mean,
    ts: now,
    sources: samples.map((s) => s.source),
  };
}

export interface PriceFetchers {
  fetchRaydium: () => Promise<PriceSample | null>;
  fetchJupiter: () => Promise<PriceSample | null>;
  fetchDexScreener: () => Promise<PriceSample | null>;
}

export async function fetchAllSources(fetchers: PriceFetchers): Promise<PriceSample[]> {
  const results = await Promise.allSettled([
    fetchers.fetchRaydium(),
    fetchers.fetchJupiter(),
    fetchers.fetchDexScreener(),
  ]);
  return results
    .filter((r): r is PromiseFulfilledResult<PriceSample | null> => r.status === 'fulfilled')
    .map((r) => r.value)
    .filter((s): s is PriceSample => s !== null);
}
