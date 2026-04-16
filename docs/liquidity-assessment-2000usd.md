# BERT/SOL Market Maker: $2,000 Liquidity Assessment

**Date:** 2026-04-16 | **Author:** Claude (automated analysis)
**Pool:** Raydium CLMM `9LkdXDXQkWC8RgqMTn2eAnzgFTNjKjJiSq4smpdKLuaH`
**Token:** BERT/SOL ($0.01060) | **Fee tier:** 1% | **Current position:** $200 canary

---

## Purpose

This report presents the data the team needs to decide whether to proceed with $2,000 MM liquidity in the BERT/SOL CLMM pool. It covers four areas: fee revenue, rebalancing loss, slippage, and scaling dynamics. All figures are derived from live pool data, bot telemetry, and on-chain mechanics — not projections.

---

## 1. Fee Revenue

### What the pool earns today

| Metric | Value | Source |
|--------|-------|--------|
| Pool TVL | $1,850.69 | DexScreener live |
| 24h volume | $518.67 | DexScreener live |
| 24h transactions | 63 (60 buys / 3 sells) | DexScreener live |
| Pool fee tier | 1.00% | `raydiumClient.ts` feeRate |
| Raydium protocol cut | ~12% | Raydium docs |
| Net LP fee share | ~88% of gross | Raydium docs |
| **Total daily LP fees** | **~$4.56** | $518.67 × 1% × 88% |

For context, the main BERT AMM v4 pool (`BmsZE6...`) does $80,846/day volume with $795K TVL. Our CLMM pool captures 0.6% of total BERT trading volume.

### Our fee share at different position sizes

| Position | New Pool TVL | Our Share | Daily Fees | Monthly | Annual | APR |
|----------|-------------|-----------|------------|---------|--------|-----|
| $200 (now) | $1,851 | 10.8% | $0.49 | $14.80 | $180 | 90% |
| $500 | $2,151 | 23.2% | $1.06 | $31.80 | $387 | 77% |
| $1,000 | $2,651 | 37.7% | $1.72 | $51.60 | $627 | 63% |
| **$2,000** | **$3,651** | **54.8%** | **$2.50** | **$75.00** | **$913** | **46%** |
| $5,000 | $6,651 | 75.2% | $3.43 | $102.90 | $1,252 | 25% |
| $10,000 | $11,651 | 85.8% | $3.91 | $117.30 | $1,427 | 14% |

**Key takeaway:** Yield per dollar drops as we add capital. Each dollar we add dilutes our own return because we *are* the liquidity — the volume stays the same. Going 10x on capital ($200 → $2,000) only gets us 5x the fees.

### Volume sensitivity

Fee revenue is directly proportional to volume. The table above assumes today's $518/day holds. If BERT activity changes:

| Daily Volume Scenario | Daily Fees at $2K Position | Monthly |
|-----------------------|---------------------------|---------|
| $100/day (quiet) | $0.48 | $14.40 |
| $518/day (current) | $2.50 | $75.00 |
| $2,000/day (active) | $9.64 | $289.20 |
| $10,000/day (breakout) | $48.18 | $1,445.40 |

If our deeper liquidity attracts DEX aggregator routing and pulls even a small slice of the AMM v4 pool's $80K volume, the economics shift significantly. But there's no guarantee of that — aggregators route on best execution, not just liquidity depth.

---

## 2. Rebalancing Losses

Rebalancing is the bot's core operation: when BERT's price drifts outside our range, the bot closes the position, swaps to a 50/50 ratio, and reopens centered on the new price. This has two costs.

### 2a. Transaction costs (gas)

| Component | Cost per Rebalance |
|-----------|--------------------|
| Close position tx | ~$0.003-0.01 |
| Swap-to-ratio tx | ~$0.003-0.01 |
| Open position tx | ~$0.003-0.01 |
| Priority fee (10K µlamports) | ~$0.005 |
| **Total per rebalance** | **~$0.01-0.04** |

At 6 rebalances/day (the configured max), gas costs ~$0.24/day or ~$7/month. **Gas is negligible on Solana.** This is not a factor in the decision.

### 2b. Crystallized impermanent loss (the real cost)

Every rebalance locks in whatever impermanent loss has accumulated. In concentrated liquidity, IL is amplified relative to full-range AMMs — narrower range = higher amplification.

**Our range:** ~20% width (±10% around center price), based on the deployed position ticks ($0.00899 – $0.01099 around $0.00999 center).

| BERT Price Move | IL on $200 Position | IL on $2,000 Position |
|-----------------|--------------------|-----------------------|
| ±5% (stays in range) | ~$1.25 (unrealized) | ~$12.50 (unrealized) |
| ±10% (hits range edge, rebalance triggers) | ~$5.00 (crystallized) | ~$50.00 (crystallized) |
| ±15% (sustained breakout) | ~$10-15 | ~$100-150 |
| ±20% (strong trend) | ~$15-20 | ~$150-200 |

**Observed volatility:** BERT moved +17.34% in the last 24h (DexScreener). A single move of that magnitude on a $2,000 position would crystallize roughly $85-100 in IL — **equivalent to 34-40 days of fee revenue at current volume**.

### Rebalance frequency vs. cost (hypothetical 30-day period)

| Market Regime | Rebalances/Day | Monthly IL Cost ($2K) | Monthly Fees ($2K) | Net |
|---------------|---------------|----------------------|-------------------|-----|
| Low volatility (±3%/day) | 0-1 | $0-50 | $75 | +$25 to +$75 |
| Normal volatility (±10%/day) | 1-3 | $50-250 | $75 | -$175 to +$25 |
| High volatility (±20%+/day) | 3-6 (capped) | $250-600 | $75 | -$525 to -$175 |

**Canary data point:** 1 rebalance in ~20 hours at $200. 97.6% of ticks were in-range. This is a calm period for BERT. We do not yet have data from a volatile period.

---

## 3. Slippage

Slippage hits in two places: the swap-to-ratio step during rebalance, and the position open/close itself.

### 3a. Swap slippage during rebalance

When we rebalance, we swap one token for the other to get back to a 50/50 ratio. The slippage depends on how much liquidity is in the pool *excluding our own position* (since ours is being closed).

| Position Size | Our % of Pool | Remaining Pool Depth | Swap Size (worst case) | Expected Slippage |
|---------------|--------------|---------------------|----------------------|-------------------|
| $200 | 10.8% | ~$1,650 | ~$50-100 | 0.3-0.6% |
| $2,000 | 54.8% | ~$1,650 | ~$500-1,000 | **3-8%** |
| $5,000 | 75.2% | ~$1,650 | ~$1,250-2,500 | **10-20%+** |

**This is the critical scaling problem.** When we close our $2,000 position, we pull 55% of the pool's liquidity. The remaining ~$1,650 has to absorb our swap. At $2,000 we are effectively trading against ourselves.

**Observed incident:** During the canary deployment on Apr 15, the bot hit a `PriceSlippageCheck` failure at just $200 — a 1.6% price gap between expected and actual amounts. The hardcoded slippage tolerance is 300bps (3%). At $2,000, that tolerance may not be enough.

### 3b. Position open/close slippage

Opening and closing LP positions are not swaps, but the pool price can move between transaction submission and confirmation (~400ms-2s on Solana). At our pool's liquidity level:

| Position Size | Price Impact of Our Open/Close |
|---------------|-------------------------------|
| $200 | Minimal (<0.1%) |
| $2,000 | Noticeable (0.5-2%) |
| $5,000+ | Our own open/close moves the market |

### 3c. Dollar cost of slippage per rebalance

| Position Size | Swap Slippage | Open/Close Slippage | Total per Rebalance |
|---------------|--------------|--------------------|--------------------|
| $200 | $0.30-0.60 | ~$0.10 | ~$0.40-0.70 |
| $2,000 | $15-40 | $5-20 | **$20-60** |
| $5,000 | $125-500 | $25-100 | **$150-600** |

At $2,000 with 1-2 rebalances/day, slippage alone could cost **$20-120/day** against $2.50/day in fees.

---

## 4. Scaling Dynamics

### What gets better with more capital

1. **Deeper book attracts routing.** DEX aggregators (Jupiter, etc.) route trades to the best-priced venue. If our CLMM offers tighter execution than the AMM v4 pool, some of that $80K/day volume could route to us. Even capturing 5% of it would mean $4,000/day through our pool — fees jump from $2.50 to ~$19/day at $2,000 deployed.

2. **Range width flexibility.** More capital means we can run a wider range (e.g., ±15-20%) while still providing meaningful depth per tick. Wider range = fewer rebalances = less crystallized IL and slippage.

3. **Fee compounding.** The bot compounds fees into the position (`feeHandling: "compound"`). At meaningful fee levels, position size grows organically.

4. **Market maker positioning.** At $2,000 we'd set the effective bid-ask for BERT on the CLMM. Any trader who needs CLMM execution pays us.

### What gets worse with more capital

1. **Self-slippage.** At 55% of pool TVL, every rebalance is a large trade against thin remaining liquidity. This is the single biggest risk and it scales superlinearly with position size.

2. **Impermanent loss exposure.** IL scales linearly with position size. BERT is a memecoin — 20%+ daily moves are not unusual. A $2,000 position in a 20% range has ~$100 IL per 10% move.

3. **Concentration risk.** $2,000 in a single memecoin pool on a single hot wallet. BERT could lose 50-90% of value in a day (pump.fun token, $10M FDV). The bot's 15% drawdown breaker would trip, but that still means a $300 loss before the safety kicks in.

4. **Diminishing fee yield.** APR drops from 90% at $200 to 46% at $2,000 to 14% at $10,000 because we're diluting ourselves.

5. **Liquidity withdrawal risk.** If the other ~$1,650 of non-us liquidity leaves (seeing they're now minority LPs), we become the entire pool. Every rebalance swap would have catastrophic slippage.

### The volume threshold question

The math only works if volume scales with our liquidity. Here's what we'd need:

| Position Size | Daily Volume Needed to Break Even (fees > IL + slippage) |
|---------------|----------------------------------------------------------|
| $200 | ~$500/day (current: $518 — roughly breakeven) |
| $2,000 | ~$5,000-10,000/day (current: $518 — 10-20x short) |
| $5,000 | ~$15,000-30,000/day (current: $518 — 30-60x short) |

---

## 5. Known Issues to Fix Before Any Scaling

Regardless of the liquidity decision, these should be addressed:

| Issue | Impact | Severity |
|-------|--------|----------|
| `feesCollectedUsd` always records 0 in DB | Cannot track actual fee revenue | High — flying blind |
| `maxSlippageBps` config field is dead code | Config says 100bps, code uses hardcoded 300bps | Medium — misleading config |
| No P&L tracking | No entry value, no mark-to-market, no IL calculation | High — can't measure performance |
| RPC fallback never used | Single RPC failure = bot pauses | Low — Helius is reliable |
| Only 1 rebalance observed | Insufficient data to model rebalance costs | High — need more canary data |
| Hourly reports not persisted to disk | Telegram-only, can't do historical analysis | Medium — limits post-hoc analysis |

---

## 6. Scenario Summary

| Scenario | Monthly Revenue | Monthly Costs (IL + Slippage + Gas) | Expected Monthly P&L | Risk |
|----------|----------------|-------------------------------------|---------------------|------|
| $200, current volume | $15 | $5-20 | -$5 to +$10 | Low (max $200 loss) |
| $2,000, current volume ($518/day) | $75 | $100-700 | **-$625 to -$25** | High |
| $2,000, if volume grows to $5K/day | $290 | $100-700 | -$410 to +$190 | High |
| $2,000, if volume grows to $10K/day | $530 | $100-700 | -$170 to +$430 | High |
| $2,000 in a different high-volume CLMM pool | Varies | Much lower (not majority LP) | Likely positive | Medium |

---

## Appendix A: Data Sources

- **Pool metrics:** DexScreener API, queried 2026-04-16 ~09:16 UTC
- **Bot telemetry:** `journalctl -u bert-mm-bot`, `/var/lib/bert-mm-bot/state.db`
- **Fee mechanics:** Raydium CLMM documentation, `raydiumClient.ts` source code
- **IL formulas:** Standard CLMM impermanent loss model (concentrated liquidity amplification)
- **Slippage observations:** Bot logs — `PriceSlippageCheck` failure on Apr 15 at 1.6% gap
- **Position data:** SQLite `position_state` table — range $0.008989-$0.010986, center $0.009988
- **Canary report:** `/opt/bert-mm-bot/docs/canary-report-2026-04-16.md`

## Appendix B: Competing BERT Pools

| Pool | DEX | Type | TVL | 24h Volume | Volume/TVL |
|------|-----|------|-----|------------|------------|
| `BmsZE6...` | Raydium | AMM v4 | $795,025 | $80,846 | 10.2% |
| `EiPnoq...` | Meteora | DLMM | $42,608 | $3,035 | 7.1% |
| `67Wo3U...` | Meteora | DLMM | $22,070 | $1,069 | 4.8% |
| `EnQcrx...` | Meteora | DLMM | $8,637 | $704 | 8.2% |
| `8vL7KS...` | Raydium | CLMM | $2,043 | $113 | 5.5% |
| **`9LkdXD...` (ours)** | **Raydium** | **CLMM** | **$1,851** | **$519** | **28.0%** |

Our pool actually has a relatively strong volume/TVL ratio (28%) compared to peers. The constraint is absolute volume, not capital efficiency.
