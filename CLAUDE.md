# BERT MM Bot

## What this is
Autonomous market-making bot for the BERT/SOL pool on Solana mainnet.
Supports two venues via config: **Raydium CLMM** and **Meteora DLMM** (switchable via `venue` field).
Holds a single concentrated-liquidity position centered on mid price, auto-rebalances when price drifts out of range.

## Tech stack
- TypeScript 5, Node 22, pnpm
- @raydium-io/raydium-sdk-v2 (Raydium), @meteora-ag/dlmm (Meteora), @solana/web3.js, @solana/spl-token
- vitest, pino (JSON logger), zod (config validation), better-sqlite3 (state), commander (CLI)
- Systemd service, Telegram notifications

## Key commands
```bash
pnpm install && pnpm build              # Build
pnpm vitest run                          # 65 tests across 9 files
node dist/cli/index.js status            # Current state + position
node dist/cli/index.js emergency-exit    # Close position (interactive)
node dist/cli/index.js rebalance --force # Force rebalance
node dist/cli/index.js clear-degraded    # Clear safety flag
node dist/cli/index.js report --days 7   # PnL + time-in-range
npx tsx scripts/create-meteora-pool.ts --dry-run  # Pool creation script
npx tsx scripts/create-meteora-pool.ts --list-presets  # Show available fee tiers
```

## Deployment status
- **Migrating to Meteora DLMM** — pool created, bot paused pending wallet funding
- Wallet: `2yHJzBWF2RXAB4PfTadM6xqiK1h83V7yKnEz89GdLqkQ` (~1.25 SOL, needs ~0.5-1.0 more)
- Meteora DLMM pool: `4rkbxnvmXagghqoV59jGZRcRUu94HHHq7axvFz8ERGMh` (0.10% base fee, bin_step=10)
- Old Raydium CLMM pool: `9LkdXDXQkWC8RgqMTn2eAnzgFTNjKjJiSq4smpdKLuaH` (1% fee, position closed)
- Config: `/etc/bert-mm-bot/config.yaml` (venue=meteora, maxPositionUsd=200, rangeWidthPct=6)
- Service: `sudo systemctl status bert-mm-bot` (currently stopped)
- Logs: `/var/log/bert-mm-bot/bot.log`
- State DB: `/var/lib/bert-mm-bot/state.db`

## To resume Meteora canary
1. Fund wallet with ~0.5-1.0 SOL (DLMM needs ~0.75 SOL for bin array rent on first position)
2. `sudo systemctl start bert-mm-bot`
3. Bot will auto-open initial position on the 0.10% DLMM pool

## To revert to Raydium
1. Edit `/etc/bert-mm-bot/config.yaml`: set `venue: "raydium"`, `poolAddress: "9LkdXDXQkWC8RgqMTn2eAnzgFTNjKjJiSq4smpdKLuaH"`
2. `sudo systemctl start bert-mm-bot`

## Active service
```bash
sudo systemctl status bert-mm-bot       # MM bot (currently STOPPED — needs SOL funding)
```

## Architecture
```
main.ts (30s poll loop)
  → venueClient.ts (factory: createVenueClient selects Raydium or Meteora based on config)
  → priceOracle (Jupiter + DexScreener, 2-source consensus, divergence check)
  → strategy.ts (in-range check, sustained-out detector)
  → rebalancer.ts (9-step: drawdown check → close → swap 50/50 → open → persist → notify)
  → txSubmitter (priority fee, retry, confirm)
  → stateStore (SQLite: positions, rebalances, degraded flag)
  → notifier (Telegram hourly status + event alerts)
```

### Venue abstraction
- `VenueClient` interface in `venueClient.ts` — generic API for pool interactions
- `RaydiumClientImpl` in `raydiumClient.ts` — Raydium CLMM (tick-based, NFT positions)
- `MeteoraClientImpl` in `meteoraClient.ts` — Meteora DLMM (bin-based, keypair positions)
- Factory `createVenueClient(venue, ...)` does dynamic import based on `config.venue`

### Meteora DLMM specifics
- **ESM workaround**: `meteoraClient.ts` uses `createRequire` to load `@meteora-ag/dlmm` via CJS (the ESM entry fails on `@coral-xyz/anchor` directory imports)
- **Position ID**: DLMM positions use a generated Keypair pubkey (stored in the `nftMint` field for backwards compat with stateStore)
- **Bin arrays**: First position open costs ~0.37 SOL × 2 = 0.74 SOL in rent (refundable on close)
- **Range width**: bin_step=10 means each bin = 0.10% price step. Max ~70 bins per position = ~7% range max
- **Empty pool seeding**: Rebalancer catches swap-to-ratio failure on initial open (no liquidity to swap against) and deposits available balances directly
- **DexScreener**: Fetcher searches by pool address across all DEXes, falls back to highest-volume pool for the token

## Oracle
- 3 sources: Raydium/Meteora (currently always null by design), Jupiter (`api.jup.ag/swap/v1/quote`), DexScreener
- Requires 2+ sources agreeing within `oracleDivergenceBps` (150 = 1.5%)
- Returns null (bot holds) if sources diverge or fewer than 2 respond
- `solUsd=0` samples filtered from mean to prevent DexScreener poisoning

## Safety model
- **maxPositionUsd**: hard cap on position size ($200 canary, $2200 full)
- **Drawdown breaker**: fails CLOSED — if simulateClose throws, rebalance is refused
- **Kill switches**: config `enabled: false`, KILLSWITCH file, systemctl stop
- **Initial open guards**: respects kill switch + degraded flag before opening
- **Duplicate position protection**: getPosition RPC failure skips tick (doesn't treat as "no position")
- **SOL floor**: `minSolFloorLamports` reserved for gas on every rebalance (default 0.1 SOL — needs increase for DLMM bin array rent)
- **Daily cap**: `maxRebalancesPerDay` (6) enforced in both strategy and rebalancer

## Key gotchas
- **RPC keys in config**: `/etc/bert-mm-bot/config.yaml` has Helius + QuikNode API keys and Telegram bot token. File is `root:bertmm 640`.
- **`maxSlippageBps` config is dead code**: slippage is hardcoded to `SLIPPAGE_BPS = 300` in both raydiumClient.ts and meteoraClient.ts.
- **`rpcFallback` is accepted but never used**: no failover logic implemented.
- **`rpcOutageMinutes`, `drawdownWindowMin`, `minSolBalance`, `hardPauseSolBalance`**: validated by schema but never referenced in runtime.
- **DLMM bin array rent**: First position on a new pool costs ~0.74 SOL in bin array rent. Refundable when position is closed. Budget SOL accordingly.
- **DLMM max bins per position**: ~70 bins. With bin_step=10 (0.10% per bin), max range is ~7%. Config `rangeWidthPct` must not exceed this.
- **`feesCollectedUsd` always records 0**: field exists in rebalance_log but is never populated. Fee tracking is a known gap.
- **Reconciliation tolerance**: 2% relative (tick-to-USD rounding + solUsd variance between open and restart).

## Notifications
- Telegram bot sends: startup, position open, rebalance, drawdown breaker, hourly status report
- Hourly report includes: price, range, in-range %, rebalances today, bot status
- Notifications are optional in config (bot runs silently without them)

## Audit findings (fixed)
- **C1**: getPosition RPC failure no longer opens duplicate position (skips tick)
- **C2**: Initial position open now checks kill switch + degraded flag
- **C3**: Drawdown breaker fails closed on simulateClose error
- **C4**: solUsd=0 from DexScreener filtered from oracle mean
- **H1**: RPC API key redacted from log output (logs hostname only)

## Reports
- `docs/liquidity-assessment-2000usd.md` — Fee/IL/slippage analysis for $2K deployment
- `docs/canary-report-2026-04-16.md` — Raydium CLMM canary results
- `docs/superpowers/specs/2026-04-16-meteora-dlmm-integration-design.md` — DLMM migration spec
