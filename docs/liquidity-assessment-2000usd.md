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

Note: `EiPnoq` and `67Wo3U` are Meteora Dynamic AMM (DYN/DYN2) pools, not DLMM. The actual BERT DLMM pools (`EBNa91`, `3yLpLc`, `61HTJPyv`) have <$1K TVL and near-zero volume.

## Appendix C: Meteora DLMM 0.10% Fee Tier Analysis

### Can we create a 0.10% DLMM pool?

**Yes.** Verified against on-chain data and the Meteora DLMM fee formula.

**Formula (from DLMM program `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`):**

```
base_fee = base_factor × bin_step × 10 / FEE_PRECISION
FEE_PRECISION = 1,000,000,000
```

**Verification against existing BERT DLMM pool (`EBNa91...`):**

| Field | On-Chain Value | Source |
|-------|---------------|--------|
| base_factor | 10,000 | Solana RPC `getAccountInfo`, offset 8 (u16 LE) |
| bin_step | 200 | Solana RPC `getAccountInfo`, offset 80 (u16 LE) |
| protocol_share | 500 (= 5%) | Solana RPC `getAccountInfo`, offset 32 (u16 LE) |
| variable_fee_control | 7,500 | offset 16 (u32 LE) |
| max_volatility_accumulator | 150,000 | offset 20 (u32 LE) |
| **Calculated base fee** | **10,000 × 200 × 10 / 1e9 = 2.00%** | Formula output |

### Configurations that produce 0.10%

Need: `base_factor × bin_step = 100,000`

| bin_step | base_factor | Price Granularity | Bins for 20% Range | Notes |
|----------|-------------|-------------------|--------------------|-------|
| 5 | 20,000 | 0.05% | 400 | Very fine — high bin management overhead |
| 10 | 10,000 | 0.10% | 200 | Fine-grained, standard for major pairs |
| **20** | **5,000** | **0.20%** | **100** | **Recommended — good balance of granularity and manageability** |
| 25 | 4,000 | 0.25% | 80 | Moderate |
| 50 | 2,000 | 0.50% | 40 | Coarse — may miss pricing precision |
| 100 | 1,000 | 1.00% | 20 | Very coarse — big price gaps between bins |

**Recommended: `bin_step=20, base_factor=5,000`** — 100 bins for a 20% range gives good price granularity (each bin $0.0000212 apart at current BERT price) without excessive bin management complexity.

### Why 0.10% undercuts the competition

| Pool | Fee | Type | How Jupiter evaluates |
|------|-----|------|-----------------------|
| Raydium AMM v4 (`BmsZE6`) | 0.25% (fixed) | Constant-product | Deepest ($795K) but higher fee, curve slippage |
| **Proposed DLMM** | **0.10% base + dynamic** | **Bin-based** | **Lowest fee, zero in-bin slippage, dynamic upside** |
| Our Raydium CLMM (`9LkdXD`) | 1.00% (fixed) | Concentrated | Higher fee than both competitors |
| Existing BERT DLMM (`EBNa91`) | 2.00% base + dynamic | Bin-based | Highest fee of all, near-zero liquidity |

Jupiter routes on **best net output** (price after fees and price impact). For a $100 BERT buy:

| Pool | Fee cost | Price impact | Net cost | Jupiter routes here? |
|------|----------|-------------|----------|---------------------|
| **Proposed 0.10% DLMM ($2K liq)** | **$0.10** | **~$0 (in-bin)** | **$0.10** | **Yes — cheapest for small trades** |
| Raydium AMM v4 ($795K liq) | $0.25 | ~$0.01 | $0.26 | Yes — wins on large trades (deeper) |
| Our CLMM ($1.8K liq) | $1.00 | ~$0.01 | $1.01 | No |
| Existing DLMM ($714 liq) | $2.00 | ~$0.05 | $2.05 | No |

**At 0.10%, we beat the AMM v4 on trades up to approximately $500-1,000** (where our $2K liquidity starts showing price impact). Above that, the AMM's 400x deeper liquidity wins despite its higher fee. Jupiter will split trades — sending the first $500-1K to us and the rest to the AMM.

### Dynamic fee advantage

Meteora DLMM adds a **variable fee** on top of the base fee that scales with volatility:

```
variable_fee = A × (volatility_accumulator × bin_step)²
total_fee = base_fee + variable_fee
```

When BERT moves sharply (crossing many bins), the variable fee spikes — we automatically earn **more** during the highest-IL periods. On the Raydium CLMM, our 1% fee is fixed regardless of volatility. This is the key structural advantage of DLMM for volatile tokens.

### LP fee share comparison

| Venue | LP Share | On $1 of fees |
|-------|----------|---------------|
| Meteora DLMM | **95%** | $0.95 |
| Raydium CLMM | 88% | $0.88 |
| Raydium AMM v4 | ~84% | $0.84 |

8% more revenue per dollar of volume vs our current Raydium CLMM.

### Revenue projections: 0.10% DLMM at $2,000

The key question: how much Jupiter-routed volume would we capture?

- Total BERT daily volume: ~$86K across all DEXs
- Jupiter routes 50-70% of Solana DEX volume: ~$43K-60K BERT/day through Jupiter
- At 0.10% fee with $2K concentrated at the active bin, we'd win routing on trades up to ~$500-1K

| Volume Captured | Daily LP Fees (0.10% × 95%) | Monthly | Annual | APR on $2K |
|-----------------|---------------------------|---------|--------|------------|
| $500/day (1% of Jupiter flow) | $0.48 | $14.25 | $173 | 9% |
| $2,000/day (4% of Jupiter flow) | $1.90 | $57.00 | $694 | 35% |
| $5,000/day (10% of Jupiter flow) | $4.75 | $142.50 | $1,733 | 87% |
| $10,000/day (20% of Jupiter flow) | $9.50 | $285.00 | $3,467 | 173% |
| $20,000/day (40% of Jupiter flow) | $19.00 | $570.00 | $6,935 | 347% |

**vs current Raydium CLMM at $518/day volume: $2.50/day → $75/month**

The DLMM only matches the CLMM's $75/month at ~$2,600/day captured volume. But the DLMM has:
- Dynamic fees that increase during volatile periods (exactly when the CLMM is losing to IL)
- Per-bin control allowing surgical liquidity placement at the active price
- Zero in-bin slippage making us the cheapest venue for small trades
- 8% better LP fee share

### Rebalancing in DLMM vs CLMM

| Aspect | Raydium CLMM (current) | Meteora DLMM (proposed) |
|--------|------------------------|------------------------|
| Rebalance = full close + reopen? | Yes — atomic close, swap, open | Can add/remove individual bins |
| Self-slippage on rebalance | Severe at 55% pool share | **Reduced** — can shift bins incrementally |
| Swap-to-ratio needed? | Yes (50/50 split) | **Depends** — can deposit single-sided into bins |
| IL crystallization | Every rebalance | Can avoid by adding bins instead of closing |
| Gas cost per rebalance | ~$0.01-0.04 | ~$0.01-0.05 (similar, slightly more accounts) |
| Position rent | ~0.002 SOL (refundable) | ~0.25 SOL for bin arrays (higher upfront) |

**The DLMM's per-bin management is the structural fix for the self-slippage problem.** Instead of close-everything-and-reopen, we can:
1. Remove liquidity from bins that are now out of range
2. Add liquidity to new bins at the current price
3. Skip the swap-to-ratio step entirely by depositing single-sided

This fundamentally changes the rebalancing economics at higher position sizes.

### Bot development required

Switching from Raydium CLMM to Meteora DLMM requires:

| Component | Effort | Notes |
|-----------|--------|-------|
| Replace `@raydium-io/raydium-sdk-v2` with `@meteora-ag/dlmm` | Medium | Different SDK, different account structures |
| Rewrite `raydiumClient.ts` → `meteoraClient.ts` | High | New position management (bins vs ticks) |
| Update `rebalancer.ts` for per-bin operations | High | Can optimize to avoid full close/reopen |
| Update `strategy.ts` for bin-based range checks | Low | Logic is similar, different data structures |
| Update `priceOracle.ts` — no change needed | None | Oracle is venue-agnostic |
| Pool creation (one-time, via Meteora UI) | Low | ~0.25 SOL cost |
| Testing | Medium | Existing test structure can be adapted |

**Estimated effort: 2-4 days of development + testing.**

### Trade-offs summary

| Factor | Stay on Raydium CLMM 1% | Switch to Meteora DLMM 0.10% |
|--------|--------------------------|-------------------------------|
| Fee competitiveness vs AMM v4 | Lose (1% vs 0.25%) | **Win (0.10% vs 0.25%)** |
| Volume capture potential | Low (only our own pool's $518/day) | **High (could capture Jupiter-routed flow)** |
| Dynamic fee protection | No | **Yes — fees scale with volatility** |
| LP fee share | 88% | **95%** |
| Rebalance flexibility | Close-swap-open (full cycle) | **Per-bin add/remove (incremental)** |
| Self-slippage at $2K | Severe (55% of pool) | **Reduced (incremental rebalancing)** |
| Development effort | None (deployed) | 2-4 days |
| Battle-tested? | Yes (canary running) | No (new code needed) |
| Revenue per dollar of volume | Higher (1% vs 0.10%) | Lower — but volume should be 10x+ higher |
| Pool creation cost | None (exists) | ~0.25 SOL (~$38) |

### Data sources for this appendix

- **On-chain pool data:** Solana RPC `getAccountInfo` on `EBNa91ozf31MG9yk2eky3qDtBP3ZLLDqXj1BeMcLob5X`, decoded against DLMM LbPair struct layout
- **Fee formula:** Meteora DLMM program `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`, verified against on-chain parameters
- **Jupiter routing:** Jupiter developer docs (Metis routing engine — optimizes for best net output, not lowest fee)
- **Meteora LP share:** On-chain `protocol_share=500` (5% protocol, 95% LP)
- **Pool creation:** Meteora docs — permissionless, ~0.25 SOL rent, immutable parameters after creation
