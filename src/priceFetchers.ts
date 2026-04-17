import type { PriceSample } from './priceOracle.js';
import type { VenueClient } from './venueClient.js';
import { logger } from './logger.js';

const BERT_MINT = 'HgBRWfYxEfvPhtqkaeymCQtHCrKE46qQ43pKe8HCpump';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
// Confirmed from inspect-pool output: BERT is mintB with 6 decimals
const BERT_DECIMALS = 6;
const SOL_DECIMALS = 9;

export function makeFetchers(raydium: VenueClient, poolAddress: string) {
  return {
    fetchRaydium: async (): Promise<PriceSample | null> => {
      try {
        const state = await raydium.getPoolState();
        // getPoolState() returns bertUsd=0 / solUsd=0 by design — the oracle relies on
        // Jupiter + DexScreener for absolute USD. Return null so the median computation
        // uses real price data only.
        if (state.bertUsd <= 0 || state.solUsd <= 0) return null;
        return {
          source: 'raydium',
          bertUsd: state.bertUsd,
          solUsd: state.solUsd,
          bertPerSol: state.solUsd / state.bertUsd,
          ts: Date.now(),
        };
      } catch (e) {
        logger.warn({ err: e }, 'fetchRaydium failed');
        return null;
      }
    },

    fetchJupiter: async (): Promise<PriceSample | null> => {
      try {
        // 1 BERT in → SOL out. Input amount: 10^BERT_DECIMALS (1 whole BERT).
        const inAmount = 10 ** BERT_DECIMALS;
        const url = `https://api.jup.ag/swap/v1/quote?inputMint=${BERT_MINT}&outputMint=${SOL_MINT}&amount=${inAmount}&slippageBps=50`;
        const res = await fetch(url);
        if (!res.ok) return null;
        const data = (await res.json()) as { outAmount: string };
        const solOut = Number(data.outAmount) / 10 ** SOL_DECIMALS; // SOL per 1 BERT

        // Fetch SOL-USD price from Jupiter (SOL→USDC)
        const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
        const solUsdUrl = `https://api.jup.ag/swap/v1/quote?inputMint=${SOL_MINT}&outputMint=${USDC_MINT}&amount=${10 ** SOL_DECIMALS}&slippageBps=50`;
        const solRes = await fetch(solUsdUrl);
        if (!solRes.ok) return null;
        const solData = (await solRes.json()) as { outAmount: string };
        const solUsd = Number(solData.outAmount) / 10 ** 6; // USDC has 6 decimals
        const bertUsd = solOut * solUsd;
        if (!isFinite(bertUsd) || bertUsd <= 0 || !isFinite(solUsd) || solUsd <= 0) return null;
        return {
          source: 'jupiter',
          bertUsd,
          solUsd,
          bertPerSol: solUsd > 0 ? solUsd / bertUsd : 0,
          ts: Date.now(),
        };
      } catch (e) {
        logger.warn({ err: e }, 'fetchJupiter failed');
        return null;
      }
    },

    fetchDexScreener: async (): Promise<PriceSample | null> => {
      try {
        const url = `https://api.dexscreener.com/latest/dex/tokens/${BERT_MINT}`;
        const res = await fetch(url);
        if (!res.ok) return null;
        const data = (await res.json()) as {
          pairs: Array<{
            dexId: string;
            pairAddress: string;
            priceUsd?: string;
            priceNative?: string;
            baseToken?: { address: string };
            quoteToken?: { address: string };
          }>;
        };
        // Always use the highest-volume pool for price discovery (pairs[0] is
        // sorted by volume desc).  Our own pool is too thin to be a reliable
        // price source — using it would poison the oracle.
        let target = data.pairs.length > 0 ? data.pairs[0] : undefined;
        if (!target || !target.priceUsd) return null;
        const bertUsd = Number(target.priceUsd);
        // Derive solUsd from priceNative if available
        let solUsd = 0;
        if (target.priceNative) {
          const priceNative = Number(target.priceNative);
          if (
            target.baseToken?.address === BERT_MINT &&
            target.quoteToken?.address === SOL_MINT &&
            priceNative > 0
          ) {
            // priceNative = SOL per BERT → solUsd = bertUsd / priceNative
            solUsd = bertUsd / priceNative;
          } else if (
            target.baseToken?.address === SOL_MINT &&
            target.quoteToken?.address === BERT_MINT &&
            priceNative > 0
          ) {
            // priceNative = BERT per SOL → solUsd = bertUsd * priceNative
            solUsd = bertUsd * priceNative;
          }
        }
        if (!isFinite(bertUsd) || bertUsd <= 0) return null;
        if (!isFinite(solUsd) || solUsd <= 0) solUsd = 0; // tolerated; oracle will average
        return {
          source: 'dexscreener',
          bertUsd,
          solUsd,
          bertPerSol: solUsd > 0 ? solUsd / bertUsd : 0,
          ts: Date.now(),
        };
      } catch (e) {
        logger.warn({ err: e }, 'fetchDexScreener failed');
        return null;
      }
    },
  };
}
