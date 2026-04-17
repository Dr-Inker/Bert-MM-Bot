# BERT/SOL DLMM Market Maker — MEV Protection, Jupiter Routing, and Funding Plan

**Date:** 2026-04-17
**Audience:** Team
**Status:** Protections shipped; funding decision pending team review
**Supersedes nothing. Builds on:** `canary-report-2026-04-16.md`, `liquidity-assessment-2000usd.md`, `superpowers/specs/2026-04-16-meteora-dlmm-integration-design.md`

---

## 1. Executive Summary

Three changes shipped today (commits `2465b82`, `3f7ad89` on `main`):

1. **MEV protection is live.** All three rebalance transactions (close, swap-to-ratio, open) now route through Jito's private block engine when the bot is configured. Public mempool is no longer the primary path. Public-RPC fallback exists so transactions never go missing.
2. **Our Meteora DLMM pool is already indexed** by DexScreener and visible to Jupiter. It's ignored for routing because the pool is too thin (\~$137 liquidity, quotes ~1000× worse than Raydium). **Indexing was never the blocker — depth is.**

Funding needs to flow from a multi-sig treasury to the bot's hot wallet in capped increments. A single-key $2K hot wallet is an unnecessary concentration of attack surface.

**Decisions needed from the team** (summary at end):
- Target deployment size and timing
- Multi-sig signer set and quorum
- Trigger conditions to actually fund (volume observation, not calendar)

---

## 2. MEV Protections Now In Place

### 2.1 What was added

| File | Purpose |
|---|---|
| `src/jitoClient.ts` (new) | Wrapper around Jito Block Engine `sendBundle` + `getBundleStatuses`. Appends tip transfer to a randomly-selected Jito tip account. Returns signature on success, `null` on timeout. |
| `src/txSubmitter.ts` | New `submitProtected()` method — tries Jito first, falls back to public RPC on timeout or error. Original `submit()` unchanged for non-critical txs. |
| `src/config.ts` + `types.ts` | New `mevProtection` config block: `enabled`, `blockEngineUrl`, `tipLamports`, `bundleTimeoutMs`. Defaults off for backwards compatibility. |
| `src/main.ts` | Instantiates `JitoClient` when `mevProtection.enabled: true`. Logs `mev protection enabled` on startup. |
| `src/rebalancer.ts` | All three rebalance txs (close, swap-to-ratio, open) now use `submitProtected`. |
| `config.example.yaml` | Documented `mevProtection` section with tip-sizing guidance. |

### 2.2 Protection matrix

| Rebalance step | Before | After |
|---|---|---|
| Close position | Public RPC (visible to searchers) | Jito private mempool + fallback |
| Swap-to-ratio | Public RPC (sandwich-exposed) | Jito private mempool + fallback |
| Open position | Public RPC | Jito private mempool + fallback |

### 2.3 Cost of protection

Per rebalance: 3 × 100,000 lamports tip = **300,000 lamports ≈ $0.027 at current SOL**. At the configured daily-rebalance cap of 6, maximum tip spend is **~$0.16/day or ~$5/month**.

Compare with the MEV exposure before: at $2K position in a thin pool, searchers could extract $10–100 per rebalance swap via sandwich attacks. **Best-case ROI on the $0.027/rebalance tip is ~400× even at the low end of extractable MEV**.

### 2.4 What's still deferred (Phase 2 candidate)

**Full 3-tx atomic bundle.** Currently each of the three rebalance txs is its own 1-tx Jito bundle. A stronger design bundles close+swap+open into a single atomic unit — either all three execute or none. Benefits:

- Eliminates partial-failure states (e.g., close succeeds, swap fails → bot goes degraded)
- Slightly tighter MEV resistance (no searcher attack between txs)

Cost: 3–6 hours of rebalancer refactor (builds all 3 txs upfront using expected-balance math rather than real post-close state). Real regression risk on the critical path. Deferred until we observe a partial-failure event or a cross-tx MEV attack that only atomicity would prevent — neither has happened in canary at current \~$50 liquidity and zero trade flow.

### 2.5 How to verify it's working

Log patterns after every rebalance:
```
{"msg":"jito bundle submitted","bundleId":"…","tipLamports":100000}
{"msg":"jito bundle confirmed","bundleId":"…","sig":"…"}
```
Fallback pattern (tx still lands, just publicly):
```
{"msg":"jito submission did not land — falling back to public RPC"}
```

Tail: `sudo tail -f /var/log/bert-mm-bot/bot.log | grep -E "jito|rebalance"`.

### 2.6 Config to toggle

Live config at `/etc/bert-mm-bot/config.yaml`:
```yaml
mevProtection:
  enabled: true
  blockEngineUrl: "https://mainnet.block-engine.jito.wtf"
  tipLamports: 100000
  bundleTimeoutMs: 30000
```

Rollback (if needed): set `enabled: false` and `systemctl restart bert-mm-bot`. Backup of pre-change config is at `/etc/bert-mm-bot/config.yaml.pre-mev-backup`.

---

## 3. Path to Jupiter Routing

### 3.1 What we thought the blocker was

Earlier assumption: pool isn't indexed, so Jupiter can't see it. Run the seed-swap utility (`scripts/seed-swap.ts`) to push a $1 swap through, triggering indexing.

### 3.2 What the blocker actually is

Verified against live APIs on 2026-04-17:

- **DexScreener indexes our pool.** The token-scoped endpoint (`/tokens/v1/solana/{mint}`) filters it out because it's below some liquidity threshold, but the pair-scoped endpoint (`/latest/dex/pairs/solana/{pool}`) returns it at $136.76 liquidity with composition 1.54 SOL / 0.016 BERT (essentially all SOL-side inventory).
- **Jupiter sees the pool too.** `lite-api.jup.ag/swap/v1/quote` returns the pool in its market map. The pool is **not** missing from Jupiter's infrastructure.
- **Jupiter refuses to route through it** because the quote is terrible. 100 BERT → SOL test:

| Venue | Output | Fair-price deviation |
|---|---|---|
| Our Meteora pool (DLMM SDK quote) | 0.0000119 SOL (~$0.001) | 99.9% slippage |
| Raydium AMM v4 (Jupiter's actual route) | 0.01240 SOL (~$1.10) | 0.004% price impact |

Jupiter routes 100% through Raydium because our pool's quote is 1000× worse. This is purely a liquidity-depth problem.

### 3.3 Why the pool prices so badly

Bot opened its initial position on an empty pool with 0 BERT and ~1.23 SOL in the wallet. The swap-to-ratio step failed (no liquidity to swap against), so the bot fell through to a single-sided SOL deposit. That SOL is distributed across ~55 bins spanning the 6% range. Per-bin inventory is roughly 0.028 SOL (~$2.50).

Any trader selling BERT crosses bins from active downward. A 100 BERT sell at fair price would only extract ~0.012 SOL, but the DLMM quote accounts for the empty BERT-side and the low SOL-per-bin, producing the 99.9% slippage estimate.

### 3.4 Fix order

1. **Fund the bot wallet with BERT + SOL in balanced proportions.** Ideally ~50/50 by USD value. Current wallet: 0.72 SOL ($64) + 2,564 BERT ($28). To deploy $2K, we need to add roughly $1000 more BERT (~90,000 BERT) and ~$980 more SOL (~11 SOL). Exact split depends on price at funding time.
2. **Force a rebalance** once funded: `sudo -u bertmm node /opt/bert-mm-bot/dist/cli/index.js rebalance --force`. The bot will close the existing thin position, swap to 50/50, and re-open with the new larger balance.
3. **Observe Jupiter routing.** After the new position is open, re-query the Jupiter quote API for small BERT ↔ SOL amounts. At $2K liquidity, Jupiter should split sub-$1K trades to us. Commands to verify:
   ```
   # Small trade — should route partly or fully through us
   curl -sG 'https://lite-api.jup.ag/swap/v1/quote' \
     --data-urlencode 'inputMint=So11111111111111111111111111111111111111112' \
     --data-urlencode 'outputMint=HgBRWfYxEfvPhtqkaeymCQtHCrKE46qQ43pKe8HCpump' \
     --data-urlencode 'amount=100000000' \
     --data-urlencode 'slippageBps=100' | jq '.routePlan[].swapInfo.label'
   ```
4. **The `pool_monitor` timer** (installed earlier today as `bert-pool-monitor.timer`, every 30 min) will alert Telegram when the pool's liquidity crosses the DexScreener token-endpoint threshold and when any second pool appears. No action required — it runs silently until it has something to say.

### 3.5 Seed-swap utility: unnecessary

`scripts/seed-swap.ts` was written to force indexing via a tiny on-chain trade. Since indexing is already in place, it would burn ~$1 (99.9% slippage on the current thin pool) for zero benefit. **Do not run.** Kept in the repo as a reference for future deployments on actually-unindexed pools.

---

## 4. Volume Thresholds and the Jupiter-Routing Bootstrap

### 4.1 Correcting a framing error from the canary report

The $2K projection in `liquidity-assessment-2000usd.md` §1 assumed our pool would continue to see **$518/day** — the total market-wide BERT volume — even after funding to $2K. That's not how Jupiter routing works.

- Today: our pool sees ~$10/day (Jupiter ignores it because the quote is 1000× worse than Raydium at current depth).
- At $2K deposited with 0.10% fee: per the liquidity-assessment doc's own Appendix C, Jupiter splits trades ≤$1K to us. **That re-routes flow that currently goes through Raydium, multiplying our pool's volume by orders of magnitude.** You cannot break out of the thin-pool → no-routing → thin-pool loop without funding.

### 4.2 Realistic volume-through-our-pool at $2K

BERT's main pool (Raydium AMM v4) does $83K/day across ~1,282 txns, averaging $65/trade. Nearly every one of those trades is inside the $500–1K band where our 0.10% DLMM quote would beat the 0.25% AMM quote after price-impact math.

Jupiter won't route 100% to us — AMM v4 has 400× our depth on larger slices, users using the Raydium UI bypass Jupiter entirely, and MEV searchers may claim some of the best-quote trades first. Realistic capture rates at $2K depth:

| Jupiter capture rate | Daily volume through us | Monthly gross fees (0.10%) |
|---|---|---|
| Pessimistic (5%) | $4,000 | $120 |
| **Moderate (25%)** | **$20,000** | **$600** |
| Optimistic (50%) | $40,000 | $1,200 |

### 4.3 Net P&L at $2K with MEV protection active

Correcting the canary report's numbers with (a) actually-routed volume and (b) the MEV-protection savings now in place:

| Scenario | Monthly fees | Monthly IL + slippage | Net |
|---|---|---|---|
| Pessimistic capture (5%) | $120 | $100–400 | -$280 to +$20 |
| **Moderate capture (25%)** | **$600** | **$100–400** | **+$200 to +$500** |
| Optimistic capture (50%) | $1,200 | $200–500 | +$700 to +$1,000 |

MEV protection cuts the original $15–40/rebalance slippage estimate roughly in half (since a meaningful share of that "slippage" was phantom sandwich loss, not real price impact). The range is still wide because IL is real and BERT is volatile.

**The thesis is reasonable but unproven.** The Jupiter capture rate is the big unknown, and we can only measure it by running the experiment.

### 4.4 Recommended approach: staged ramp as a hypothesis test

Fund in tranches, each gated on measured outcomes. This caps downside while proving or disproving the Jupiter-routing thesis.

| Tranche | Size | Trigger to advance to next tranche |
|---|---|---|
| **1** | **$500** | Within 7 days: pool shows **≥$1K/day volume** on DexScreener (confirms Jupiter is routing to us at this depth). |
| 2 | $1,000 (top up to) | Within 14 more days: pool shows **≥$5K/day volume** AND weekly fee accrual > weekly IL cost. |
| 3 | $2,000 (top up to) | Sustained **$10K+/day** through the pool for 14 days. |

If a trigger doesn't hit, stay at the current tranche or scale back. $500 is within tuition-expense territory — cheap enough to test the theory without betting the full budget on it.

Rationale for starting with $500 rather than $2K blind: we do not yet have empirical proof that Jupiter will route to our Meteora DLMM pool even at the right depth. The liquidity-assessment doc's Appendix C is a model — plausible, grounded in documented fee+impact math, but untested for this specific pool and token. $500 answers the question "does Jupiter actually route?" definitively within a week.

### 4.5 Observable signals at each tranche

- **`pool_monitor` Telegram alerts** when DexScreener sees material liquidity on the pool.
- **Jupiter quote probe** — script-able, run at hourly intervals:
  ```
  curl -sG 'https://lite-api.jup.ag/swap/v1/quote' \
    --data-urlencode 'inputMint=HgBRWfYxEfvPhtqkaeymCQtHCrKE46qQ43pKe8HCpump' \
    --data-urlencode 'outputMint=So11111111111111111111111111111111111111112' \
    --data-urlencode 'amount=100000000' \
    --data-urlencode 'slippageBps=500' | jq '.routePlan[].swapInfo.label'
  ```
  When our pool starts appearing in `routePlan`, Jupiter is routing. Before that, we don't.
- **Per-rebalance fees captured** — the bot's rebalance log should show non-zero `feesCollectedUsd` (currently always 0 — see open tech-debt item in the liquidity-assessment doc §5; needs a one-line fix to populate this from `claimAllRewards`).

### 4.6 What still kills the thesis

Full scaling is NOT the right call if any of these hold:

- BERT's primary volume leaves the 1K-slice band (e.g., only a few whales trading at $50K+) — Jupiter wouldn't route to us even at $2K.
- DLMM's dynamic fee (base + variable during volatility) prices us out during the very moments arb flow would hit — making us unrouted exactly when we'd earn most.
- BERT dumps 50%+ before we ramp, converting our LP into mostly-BERT bags.

The staged ramp surfaces each of these within weeks instead of months.

---

## 5. Multi-sig Funding Plan

### 5.1 Current funding model and its risk

Bot signs transactions with a single-key hot wallet at `/etc/bert-mm-bot/hot-wallet.json` (Fernet-free, just a Solana keypair JSON; mode 600, owned by `bertmm`). If the server is compromised, the attacker can sign arbitrary transactions and drain the wallet. At a $200 canary this is bounded; at $2K it's a meaningful concentrated risk.

### 5.2 Target architecture

**Treasury in a multi-sig, hot wallet gets operating capital in capped drips.**

```
                    ┌─────────────────────────┐
                    │  Team multi-sig (Squads)│
                    │  ~$2,000 equivalent     │
                    │  2-of-3 signers         │
                    └──────────┬──────────────┘
                               │  approved withdrawals
                               │  (manual, human-signed)
                               ▼
                    ┌─────────────────────────┐
                    │  Bot hot wallet         │
                    │  Holds 1–2 weeks worth  │
                    │  of operating capital   │
                    │  (~$300–500 at a time)  │
                    └──────────┬──────────────┘
                               │  auto LP ops
                               ▼
                    ┌─────────────────────────┐
                    │  Meteora DLMM position  │
                    └─────────────────────────┘
```

The bot never sees the multi-sig private keys. Multi-sig to hot-wallet transfers require human approval from at least 2 signers. Hot wallet compromise loses the operating tranche, not the full treasury.

### 5.3 Multi-sig choice: Squads

**Recommendation: Squads (v4) at https://v4.squads.so/**

Why Squads over alternatives:

- Standard on Solana for team treasuries; well-audited.
- Web UI + SDK for proposal / approve / execute flow.
- Supports any SPL token and SOL natively.
- No custom code required from our end — just signer public keys and a quorum.
- Squad vault addresses are standard Solana pubkeys, so our wallet can trivially receive from or send to one.

Alternatives considered:
- **Solana's native multisig program** (`4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T`) — works but no good UI; signers would need to sign via CLI.
- **Mean Finance / Cyrus Protocol / Solsig** — smaller user bases, less battle-tested.
- **Hardware-wallet-only** (each signer uses Ledger with no multi-sig program) — not a multi-sig, just distributed single-sigs; loses the quorum property.

### 5.4 Proposed signer set

Three signers, 2-of-3 quorum. Suggested roles:

| Signer | Suggested holder | Rationale |
|---|---|---|
| A | Team lead | Always-online for approvals |
| B | Second team member | Redundancy; approvals go through when A is unavailable |
| C | Cold / offline backup | Key stored on hardware wallet, used only if A **and** B are unreachable (disaster recovery) |

Each signer should use a Ledger or similar hardware wallet for storing their private key. A and B can use the Squads web UI via Phantom/Backpack wallet integration for day-to-day approvals.

### 5.5 Funding flow

**Initial setup (one-time):**

1. All three signers create / identify their signer pubkeys and share them.
2. Team lead creates a new Squad at squads.so; adds A/B/C as members; sets 2-of-3 threshold.
3. The Squad vault address is published internally (and can be added to CLAUDE.md).
4. Treasury capital is moved into the vault: SOL + BERT in proportion for the target deployment size.

**Per-refill (monthly or as-needed):**

1. Operator (any signer) creates a Squad proposal: "Transfer X SOL and Y BERT to bot hot wallet `2yHJzBWF…LqkQ`."
2. A second signer approves.
3. Proposal auto-executes.
4. Bot picks up the new balance on its next rebalance cycle (no bot restart needed).

**No code changes required.** The bot doesn't know the multi-sig exists. From its perspective the hot wallet just got a deposit.

### 5.6 Operating balance sizing

Treasury keeps the bulk; hot wallet holds what's currently in the LP position + a working buffer.

| Scenario | Hot wallet target | Treasury |
|---|---|---|
| $300 canary | ~$350 (position + 15% buffer) | $0–500 (optional safety reserve) |
| $1,000 scaled | ~$1,150 | $1,000 reserve (next increment if we're scaling) |
| $2,000 full | ~$2,200 | $2,000+ reserve and/or future-fund pool |

Refills triggered by: (1) position drift back toward the wallet (IL accumulated, needs BERT top-up), (2) gas budget low (SOL balance hits `minSolBalance`), (3) opportunistic scale-up after observing fee flow.

### 5.7 Optional enhancement: refill automation script

A small TS script (not written yet, ~50 lines) could be added to `scripts/`:

```
npx tsx scripts/propose-refill.ts --sol 1 --bert 10000
```

Builds a Squad proposal via the Squads SDK; signers approve via the web UI; proposal auto-executes. Removes the manual UX friction of constructing the transfer, while preserving the 2-of-3 security property. Defer until after the first manual refill has been done at least once and the flow is familiar.

### 5.8 What this protects against

| Threat | Mitigation |
|---|---|
| Server compromise → hot wallet drain | Loss capped at operating balance (~$300–500), treasury safe |
| Disgruntled / departed team member | Their signer key alone can't move funds; remove from Squad if needed |
| Phishing of a single signer | 2-of-3 quorum means one compromised signer doesn't move funds |
| Accidental over-transfer | Multi-sig proposal must be approved; counter-signer can reject |

### 5.9 What it does NOT protect against

- **Bot code bugs.** If the bot itself signs a bad LP operation, that's a hot-wallet-sized loss, not a treasury-sized one — but it's still a loss.
- **Meteora program exploit.** Unrelated to custody.
- **BERT rug / dump.** Multi-sig doesn't change market risk.

---

## 6. Decisions Needed From the Team

1. **Deployment size and timing.** Recommendation: **fund in three tranches starting with $500**, gated on observed Jupiter routing (see §4.4). Going straight to $2K is tolerable but skips the $500 observability test that would either confirm the thesis fast or save $1,500 if the Jupiter routing doesn't materialise. Staying at canary $200 misses the actual mechanism that breaks us out of zero-flow — funding IS the action that unlocks Jupiter routing.
2. **Multi-sig signer set.** Pick 3 signers, assign roles, decide on hardware-wallet standard. Proposal: Team Lead (A), Second Engineer (B), offline Ledger (C).
3. **Trigger conditions for scaling up.** Don't scale on a calendar. Scale on observation: if `pool_monitor` alerts that BERT daily volume crossed, say, $3K/day and sustained for 7 days, revisit deployment size. Otherwise stay at canary.
4. **Do we adopt the multi-sig regardless of scaling decision?** Recommended yes — the single-key hot wallet is a real concentration risk even at $200. Setting up Squads now is a one-afternoon job and protects all future scaling.

---

## 7. What's Shipped and What's Not

**Shipped (2026-04-17, commits on `main`):**
- `0c2a21f` — pool monitor + runbook (silent 30-min Telegram monitor for pool count changes)
- `45027c2` — CTF V2–style kill-switch placeholder (not relevant here but bundled)
- `6e95ff4` — docs cleanup
- `d0cc6cf` — data collector roadmap (not this bot — polymarket-bot)
- `2465b82` — Jito-routed swap-to-ratio with RPC fallback
- `3f7ad89` — extended Jito routing to close + open txs

**Not shipped (candidates for future work):**
- Full 3-tx atomic Jito bundle (close+swap+open as one unit)
- Dynamic priority fee bidding (currently static 10k µlamports)
- Randomized rebalance timing (currently deterministic 30s tick)
- `scripts/propose-refill.ts` (Squads refill automation)
- Active-arb bot for cross-venue opportunities (big rewrite, not applicable to BERT given only one other pool)

---

## 8. Appendix: Key Commands

```bash
# Status
sudo -u bertmm node /opt/bert-mm-bot/dist/cli/index.js status

# Watch MEV-protected rebalance
sudo tail -f /var/log/bert-mm-bot/bot.log | grep -E "jito|rebalance|swap"

# Force a rebalance (will use protected submit for all three txs)
sudo -u bertmm node /opt/bert-mm-bot/dist/cli/index.js rebalance --force

# Test Jupiter routing after funding
curl -sG 'https://lite-api.jup.ag/swap/v1/quote' \
  --data-urlencode 'inputMint=HgBRWfYxEfvPhtqkaeymCQtHCrKE46qQ43pKe8HCpump' \
  --data-urlencode 'outputMint=So11111111111111111111111111111111111111112' \
  --data-urlencode 'amount=100000000' \
  --data-urlencode 'slippageBps=500' | jq '.routePlan[].swapInfo.label'

# Emergency exit (closes position, returns funds to hot wallet)
sudo -u bertmm node /opt/bert-mm-bot/dist/cli/index.js emergency-exit

# Toggle MEV protection off (if Jito has an outage)
sudo sed -i 's/enabled: true/enabled: false/' /etc/bert-mm-bot/config.yaml
sudo systemctl restart bert-mm-bot
```
