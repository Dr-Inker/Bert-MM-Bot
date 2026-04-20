# BERT/SOL LP Strategy for a Bottom-Mcap 10-100× Thesis

**Date:** 2026-04-20
**Audience:** Team
**Status:** Strategy design — awaiting team decision on which pattern to implement
**Builds on:** `2026-04-17-mev-jupiter-funding.md`, `canary-report-2026-04-16.md`, `liquidity-assessment-2000usd.md`

---

## 1. Executive Summary

Four points for the team:

1. **The current bot setup is structurally wrong for a 10-100× BERT thesis.** A tight bidirectional MM position sells BERT as price rises. If BERT runs from $0.01 to $1.00 through a concentrated LP range, the position captures roughly the **geometric mean** of the range as effective sell price (~$0.10) — so the LP ends up worth ~10× starting value while a HODLer ends up at 100×. **~90% of upside is converted to IL.** No amount of fee income during the ride recovers that.

2. **The right answer for a bottom-mcap thesis is mostly *don't* LP.** Majority of inventory should be held, not provided. LP has three real reasons to exist here: (a) earning fees during sideways chop, (b) unlocking Jupiter routing via visible depth, (c) programmatically executing a pre-committed buy/sell plan.

3. **Four strategy patterns are viable, and one combination stands out.** The "strangle pattern" — bid-ladder below spot + exit-ladder far above spot, with no LP at current price — captures both upside and accumulation without paying IL on the rally. This replaces the bot's current tight bidirectional MM, not augments it.

4. **Implementation cost on the existing DLMM pool is modest** — roughly 1.5-3.5 SOL in recoverable rent for a full ladder, or ~$10-30 on DAMM v2 if we open a parallel pool. Bot code changes are meaningful but not massive: new position-placement logic + a regime gate + fee-claim instrumentation.

**Decisions needed from the team** (full list at end):
- Which pattern to implement: A (HODL + thin float), B (bid-only), C (exit-only), or B+C (strangle)
- Whether to keep the current tight MM on the DLMM pool in parallel with a thesis-LP position, or retire it
- Whether to stay on DLMM or add a DAMM v2 pool for the thesis-LP leg

---

## 2. The Core Problem

The bot's current MM strategy is a **tight bidirectional position around spot**. It earns fees on small two-way chop. On a large directional move:

- If BERT rips up through the range, the position converts to 100% quote (SOL). The bot has "sold" BERT at every in-range price on the way up.
- If BERT dumps through the range, the position converts to 100% base (BERT). The bot has "bought" BERT at every in-range price on the way down.

This is the correct design for a **stable-mcap** token where you want to profit from mean-reversion around a central price. It is the wrong design for a **bottom-mcap token with asymmetric upside**, because the LP mechanism is effectively executing a TWAP sell on exactly the move you want to hold.

### The IL math

For a Uniswap-v3-style concentrated position (DLMM has identical geometry), if price crosses the full range, the LP ends up 100% in the quote token with an effective average exit price equal to the **geometric mean** of the range's price bounds.

Worked example — BERT at $0.01 today, LP covering [$0.005, $1.00]:
- HODL 1,000 BERT from $0.01 → $1.00 = $1,000 value. **100× return.**
- LP starting at $0.01 with equivalent inventory: price crosses the full range, position converts to quote. Effective sell price ≈ √(0.005 × 1.00) = $0.0707. **7.07× return.**
- **IL = $930 of missed upside per $10 starting position. 93% lost.**

Fee income on the ride up: even at 1,000% APR for 6 months sideways before the rip, cumulative fees are ~5× starting value. The IL bill is 93% of the post-rip upside — orders of magnitude larger than the fee income.

**This is the central fact the rest of this doc is designed around.**

---

## 3. The Four Strategy Patterns

### A. HODL + thin MM float (simplest)

Park 80-90% of BERT inventory in cold storage (or multi-sig). Run the existing bot on the remaining 10-20% float. Accept that the float gets fully converted to SOL on a 100× move — but 80% × 100× = 80× effective return on the HODL portion, which crushes any LP alternative.

- **Pros:** Minimal code change. Preserves most upside. Existing bot keeps running.
- **Cons:** Still loses on the float. Not maximizing use of the pool we control.
- **Good for:** Teams that want the simplest answer and don't mind leaving fee income on the table.

### B. Accumulate-only LP (bid-ladder)

Single-sided **SOL below spot**, wide range (e.g., −80% to −5% from current price). Sellers eat your bid ladder — you accumulate BERT at dip prices. **No ask-side liquidity at all** means no selling on rallies.

- **Pros:** Zero IL on the upside (no BERT in upper bins = nothing to convert). Automatically accumulates on dips. Earns fees from sellers.
- **Cons:** Requires fresh SOL reserves to fund the bid ladder. No fee income on buy-side flow because there's no ask. If BERT moons to zero, you own zero-value BERT.
- **Good for:** Teams that have SOL to commit and believe BERT is at bottom.

### C. Exit-ladder LP (ask-only, far above spot)

Single-sided **BERT above spot** at the prices you'd be happy to sell (e.g., bins from 5× to 20× current). The market fills your exit ladder at prices *you* pre-committed to.

- **Pros:** Programmatic TWAP exit at known prices. Earns fees on transit through the range if BERT rips. Doesn't block a bigger HODL stack above the ladder.
- **Cons:** If BERT only goes to 3× and back, you didn't sell anything (no fee capture). If BERT goes to 50×, upside above 20× is sacrificed on the ladder tranche.
- **Good for:** Teams that want a disciplined exit plan and are comfortable with "I'd sell half at 5-20× and keep the rest for the moon."

### D. Regime-gated MM (bot code change)

Keep the bidirectional MM running in calm markets, but add a momentum detector. On breakout (e.g., 24h return > +30%, or 1h volume > 3× baseline, or price above N-bin moving average for M minutes), the bot **closes its LP position and holds inventory** — then re-enters MM only after a reversal or consolidation band.

- **Pros:** Dynamic — captures fees in chop, sidesteps IL on rallies.
- **Cons:** Requires new bot code. Regime-detection is hard to calibrate cheaply on a thin-volume pool. False positives close LP unnecessarily; false negatives leave IL on the table.
- **Good for:** Teams willing to invest engineering time for a strategy that adapts to the actual regime.

### Recommended primary — the combination B + C (the "strangle pattern")

The elegant answer combines accumulation and exit-ladder while skipping the immediate spot band:

```
                        ─────── EXIT-LADDER ───────
                       │  BERT-only, 5× to 20× spot │
                       │  sells into rallies at     │
                       │  pre-committed prices      │
                       └────────────────────────────┘

                          (no LP in current band)

                       ┌────────────────────────────┐
                       │  SOL-only, −80% to −5% spot│
                       │  accumulates BERT on dips  │
                       │  at progressively cheaper  │
                       │  prices                    │
                        ─────── BID-LADDER ────────
```

**What this delivers:**
- On a 10-100× rally: exit ladder sells pre-committed tranches; HODL stack above 20× keeps mooning; no IL paid on the spot-to-5× transit.
- On dips: bid ladder accumulates BERT cheaper; if recovery happens, your cost basis on the accumulated portion is far below current price.
- On sideways chop: no LP at current price = no fee income from the chop. This is the explicit trade-off — we accept zero chop-fees in exchange for zero IL on the eventual breakout.

**Why skip the spot band:** LP at current price is exactly where IL is most expensive on any material directional move, and the chop-fee income there is small compared to what we lose on a breakout. The strangle explicitly trades chop-fee yield for breakout-preservation.

---

## 4. Financial Model — Expected Value by Scenario

Assumes $5,000 committed ($2,500 SOL on bid ladder, $2,500 BERT-equivalent on exit ladder). Strangle placement: bid ladder $0.002-$0.0095, exit ladder $0.05-$0.20.

| Scenario | 90-day outcome | Current MM | Strangle (B+C) | HODL (A) |
|----------|---------------|------------|----------------|----------|
| Chop (price stays $0.008-$0.012) | Low volume | +$50 to +$300 fees | ~$0 (no LP at spot) | ~$0 |
| Sell-off to $0.003, recovers to $0.01 | LP buys the dip | +$150 fees, −$600 IL | **+$2,000 (accumulated at discount)** | $0 |
| 5× to $0.05 | Runs through spot | **−$450 IL** (sold into rise) | +$300 exit at $0.05 | +$20,000 |
| 20× to $0.20 | Full rally | **−$2,250 IL** (converted to SOL at $0.03 geomean) | +$5,000 exit + $25 fees | +$95,000 |
| 100× to $1.00 | Moon | **−$3,500 IL** (converted to SOL at $0.07 geomean) | +$5,000 exit (capped at 20×) + HODL uncapped | +$495,000 |

**Key takeaway:** the current MM actively *loses* money on the exact scenarios the thesis is designed for. The strangle pattern protects the upside while providing a disciplined exit schedule.

**Caveat on the 100× row:** neither the current MM nor the strangle captures the full 100× on the LP-committed tranche. Only inventory held outside the LP (in HODL / cold storage) captures unbounded upside. This is why strategy A (HODL majority, LP minority) is the *implicit baseline* underneath any of B/C/D.

---

## 5. Implementation Cost on BERT/SOL DLMM

The existing pool is `4rkbxnvmXagghqoV59jGZRcRUu94HHHq7axvFz8ERGMh` with `bin_step=10` (0.1% per bin).

### Bin arithmetic

- Each bin is +0.1% from the previous → `price(bin_N) = spot × 1.001^N`
- 100 bins = +10.5%
- 1,000 bins = +2.72×
- 1,400 bins = ~4×
- Full 5× to 20× exit ladder = ~1,387 bins
- SOL bid ladder −80% to −5% = ~1,558 bins

### Rent cost (all recoverable on position close)

| Item | Count | Cost each | Subtotal |
|------|-------|-----------|----------|
| BinArray accounts (70 bins each, pool-shared) | ~40 | ~0.07 SOL | ~2.8 SOL |
| Position accounts (~69 bins each, stackable) | ~40 | ~0.05-0.15 SOL | ~2.0 SOL |
| Creation tx fees + Jito tips | ~40 | ~$0.05 each | ~$2 |
| **Total recoverable rent** | | | **~4.8 SOL (~$700-$900 at current SOL)** |

Important: BinArrays are shared across LPs in the same pool. Our pool currently has ~$137 total liquidity, so **basically no BinArrays exist outside the active bin** — we'd fund most of them. If the pool grows organically, future LPs benefit from our rent without reimbursing us (not a loss, just a note).

### DAMM v2 alternative

DAMM v2 uses continuous AMM math — no discrete bins. Position creation is ~0.022 SOL (90% cheaper than DLMM). A price-range exit ladder on DAMM v2 is structurally simpler: you just pick `[price_low, price_high]` and the AMM handles the rest.

**Trade-off:** DAMM v2 for BERT/SOL doesn't exist yet — we'd be creating a new pool. That bifurcates our liquidity and doesn't help the existing DLMM pool's Jupiter routing. For the thesis-LP legs specifically, DAMM v2 is cheaper and cleaner; for the tight-MM leg that's supposed to bootstrap Jupiter routing on DLMM, we stay on DLMM.

Recommended split:
- **DLMM pool** — keep the existing tight MM (or pause it per the strategy choice below) for Jupiter-routing bootstrap.
- **DAMM v2 pool (new)** — house the strangle ladders for the thesis-LP legs.

Total DAMM v2 rent for both ladders: ~0.044 SOL (~$6-8). Materially cheaper than the DLMM option.

---

## 6. Implications for the Current Bot

The bot's current behavior (close → swap-to-ratio → open, rebalancing on price drift) is *incompatible* with the thesis-LP legs:

- The bot assumes a single tight bidirectional position.
- Rebalancing logic will try to re-center on every price move, which defeats the exit-ladder's pre-committed prices.
- Jito bundle logic is tuned for 3-tx rebalances, not ladder placement.

**Two viable operational models:**

### Model 1 — Bot unchanged, thesis-LP runs separately

- Bot keeps its tight MM on DLMM (unchanged code).
- Thesis-LP ladders placed manually on DAMM v2, one-time deposit, no bot management.
- Multi-sig holds the thesis-LP position NFTs (DAMM v2 positions are NFT-backed — unlike DLMM PDAs — so multi-sig custody is clean).
- Bot hot wallet risk limited to its current tranche ($2K or whatever is deployed).

Pros: zero bot code change. Clean custody separation.
Cons: thesis-LP doesn't auto-compound fees. Manual re-placement if price moves far.

### Model 2 — Bot extended to manage thesis-LP

- Bot learns to place and manage ladder positions alongside the tight MM.
- Regime gate (strategy D) added: bot auto-pauses tight MM and switches to pure HODL mode on breakout.
- Fee claim + re-deposit for thesis-LP runs on a cron.

Pros: fully automated. One system, one operator.
Cons: meaningful engineering work. More attack surface on hot wallet. Bot bug can now affect thesis-LP, not just MM float.

**Recommendation: Model 1 for the initial deployment.** It's lower risk, faster to ship, and defers the bot-refactor decision until after we see the strategy work in practice. If the strangle pattern proves out over a 30-60 day window, revisit Model 2.

---

## 7. Known Gaps and Risks

Material gaps from existing memory:

- **`feesCollectedUsd` field in rebalance log always records 0** (flagged in `2026-04-17-mev-jupiter-funding.md` §Unresolved). Needs one-line fix before we can measure actual fee capture. Blocks any empirical validation of whether the ladders earn enough to care about.
- **Jupiter routing still blocked by depth** on DLMM. Thesis-LP on DAMM v2 doesn't help this — it fragments liquidity. If Jupiter routing matters for bot P&L, we need to fund the DLMM pool in parallel to the thesis work.
- **BERT-to-zero risk is real.** None of these patterns help if the token permanently dies. Strategy A (majority HODL in cold storage) is the only defense against that — and we're implicitly running it regardless of which LP pattern we pick.
- **Meteora DAMM v2 pool creation cost and SDK flow** should be validated end-to-end on devnet before mainnet deposit. The `@meteora-ag/damm-v2-sdk` TypeScript package is the integration point.

Strategy-specific risks:

- **Strangle bid ladder gets eaten in a terminal dump.** If BERT dumps 80%+ and doesn't recover, the bid ladder accumulates at $0.002-$0.0095 prices that may represent fair value for a dead token. Same risk as any DCA buy-the-dip plan — the dip is permanent.
- **Exit ladder doesn't trigger below 5×.** If BERT rallies to 3× and back, we collect no exit-ladder fees. The ladder is specifically a 5-20× exit plan; anything below 5× is treated as "still in bottom regime."
- **Pool-level liquidity events.** If a whale enters the DLMM pool with $100K+ between now and a rally, our thesis-LP exit ladder competes with theirs for the sell side. Fee share dilutes. No good hedge for this beyond placing the ladder first.

---

## 8. Decisions Needed From the Team

Six concrete questions. None require deep analysis — they're judgment calls on where the team wants to stand.

1. **Which strategy pattern?**
   - (A) HODL + thin MM float
   - (B) Accumulate-only bid ladder
   - (C) Exit-only ask ladder
   - **(B+C) Strangle — the recommended primary**
   - (D) Regime-gated MM (separately, as an add-on)

2. **What's the HODL split?** Of total BERT inventory, how much goes into cold storage / multi-sig untouched vs committed to thesis-LP legs? Suggested default: 70% HODL, 30% LP-deployed.

3. **DLMM vs DAMM v2 for thesis-LP?** Recommended: DAMM v2 for the ladders (cheaper, NFT custody), DLMM keeps its current tight MM for Jupiter-routing bootstrap.

4. **Operational model — Model 1 or Model 2?** Recommended: Model 1 (bot unchanged, thesis-LP separate) for initial deployment.

5. **Ladder price ranges — confirm or adjust the defaults?**
   - Bid ladder: $0.002 to $0.0095 (range −80% to −5% from current $0.01)
   - Exit ladder: $0.05 to $0.20 (5× to 20× from current $0.01)
   - If the team has different target zones, say so now — the ladder is a pre-commitment.

6. **Funding source for the bid ladder.** SOL required to populate the bid ladder is new capital, not recyclable from existing holdings. How much SOL is the team willing to commit? Suggested sizing: $1K-$5K for an initial test.

---

## Appendix — Build Checklist if B+C Is Approved

If the team approves the strangle pattern, rough ordered build plan:

1. Create BERT/SOL DAMM v2 pool on mainnet (~0.022 SOL). Use `@meteora-ag/damm-v2-sdk`.
2. Transfer thesis-LP inventory to multi-sig custody (BERT for exit ladder + SOL for bid ladder).
3. Deposit bid ladder position from multi-sig — single-sided SOL, price range $0.002-$0.0095.
4. Deposit exit ladder position from multi-sig — single-sided BERT, price range $0.05-$0.20.
5. Record both position NFT addresses in team ops log. Pin to pinned Telegram message.
6. Set up 1-hour cron to log position fee accrual (read-only, no claim — we'll claim on close).
7. Set up Telegram alert when either ladder's fee-accrued-USD crosses $50 threshold (meaningful activity signal).
8. Document the manual close procedure in `docs/ops/close-thesis-lp-position.md` — who signs, what the multi-sig transaction looks like, how proceeds are distributed.
9. Fix `feesCollectedUsd` instrumentation in the existing bot (one-line change) so we can measure the tight-MM leg's performance in parallel.
10. 30-day review: evaluate whether the ladder prices need adjustment and whether to extend to Model 2 automation.

Estimated engineering time: **2-4 days** for Model 1 end-to-end.
