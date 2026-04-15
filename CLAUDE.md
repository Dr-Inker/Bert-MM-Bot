# BERT MM Bot

## What this is
Autonomous Raydium CLMM market-making bot for the BERT/SOL pool on Solana mainnet.
Holds a single concentrated-liquidity position centered on mid price, auto-rebalances when price drifts out of range.

## Tech stack
- TypeScript 5, Node 22, pnpm
- @raydium-io/raydium-sdk-v2, @solana/web3.js, @solana/spl-token
- vitest, pino (JSON logger), zod (config validation), better-sqlite3 (state), commander (CLI)
- Systemd service, Telegram notifications

## Key commands
```bash
pnpm install && pnpm build              # Build
pnpm vitest run                          # 55 tests across 8 files
node dist/cli/index.js status            # Current state + position
node dist/cli/index.js emergency-exit    # Close position (interactive)
node dist/cli/index.js rebalance --force # Force rebalance
node dist/cli/index.js clear-degraded    # Clear safety flag
node dist/cli/index.js report --days 7   # PnL + time-in-range
```

## Deployment status
- **Canary live** since 2026-04-15 18:01 UTC
- Wallet: `2yHJzBWF2RXAB4PfTadM6xqiK1h83V7yKnEz89GdLqkQ`
- Position NFT: `CKurbLg4wFnq8tBafs7w6DJR5zMHq6Ndu1Li6CDJeTUK`
- Config: `/etc/bert-mm-bot/config.yaml` (maxPositionUsd=200, rangeWidthPct=20)
- Service: `sudo systemctl status bert-mm-bot`
- Logs: `/var/log/bert-mm-bot/bot.log`
- State DB: `/var/lib/bert-mm-bot/state.db`

## Active service
```bash
sudo systemctl status bert-mm-bot       # CLMM market maker (CANARY $200)
```

## Architecture
```
main.ts (30s poll loop)
  → priceOracle (Jupiter + DexScreener, 2-source consensus, divergence check)
  → strategy.ts (in-range check, sustained-out detector)
  → rebalancer.ts (9-step: drawdown check → close → swap 50/50 → open → persist → notify)
  → txSubmitter (priority fee, retry, confirm)
  → stateStore (SQLite: positions, rebalances, degraded flag)
  → notifier (Telegram hourly status + event alerts)
```

## Oracle
- 3 sources: Raydium (currently always null by design), Jupiter (`api.jup.ag/swap/v1/quote`), DexScreener
- Requires 2+ sources agreeing within `oracleDivergenceBps` (150 = 1.5%)
- Returns null (bot holds) if sources diverge or fewer than 2 respond
- `solUsd=0` samples filtered from mean to prevent DexScreener poisoning

## Safety model
- **maxPositionUsd**: hard cap on position size ($200 canary, $2200 full)
- **Drawdown breaker**: fails CLOSED — if simulateClose throws, rebalance is refused
- **Kill switches**: config `enabled: false`, KILLSWITCH file, systemctl stop
- **Initial open guards**: respects kill switch + degraded flag before opening
- **Duplicate position protection**: getPosition RPC failure skips tick (doesn't treat as "no position")
- **SOL floor**: `minSolFloorLamports` reserved for gas on every rebalance
- **Daily cap**: `maxRebalancesPerDay` (6) enforced in both strategy and rebalancer

## Key gotchas
- **RPC keys in config**: `/etc/bert-mm-bot/config.yaml` has Helius + QuikNode API keys and Telegram bot token. File is `root:bertmm 640`.
- **Raydium fetcher always returns null**: `getPoolState()` returns bertUsd=0/solUsd=0 by design. Oracle runs on Jupiter + DexScreener only.
- **`maxSlippageBps` config is dead code**: slippage is hardcoded to `SLIPPAGE_BPS = 100` in raydiumClient.ts.
- **`rpcFallback` is accepted but never used**: no failover logic implemented.
- **`rpcOutageMinutes`, `drawdownWindowMin`, `minSolBalance`, `hardPauseSolBalance`**: validated by schema but never referenced in runtime.
- **Swap-to-ratio operates on full wallet balance**: position cap is correctly enforced, but swap may move more tokens than needed.
- **NFT mint signer**: `buildOpenPositionTx` returns `signers` array from Raydium SDK — these MUST be passed to `sendAndConfirmTransaction` via `extraSigners`.
- **Reconciliation tolerance**: 2% relative (tick-to-USD rounding + solUsd variance between open and restart).

## Notifications
- Telegram bot sends: startup, position open, rebalance, drawdown breaker, hourly status report
- Hourly report includes: price, range, in-range %, rebalances today, bot status
- Notifications are optional in config (bot runs silently without them)

## Canary pass criteria (48h)
- Zero CRITICAL alerts
- Successful HOLD ticks throughout
- Position in-range >= 70% of time
- At least one end-to-end rebalance observed
- Heartbeat check passes

## Scale to full (after canary pass)
1. `node dist/cli/index.js emergency-exit`
2. `sudo systemctl stop bert-mm-bot`
3. Edit config: `maxPositionUsd: 2200`
4. Fund wallet to ~$2K total
5. `sudo systemctl start bert-mm-bot`

## Audit findings (2026-04-15, fixed)
- **C1**: getPosition RPC failure no longer opens duplicate position (skips tick)
- **C2**: Initial position open now checks kill switch + degraded flag
- **C3**: Drawdown breaker fails closed on simulateClose error
- **C4**: solUsd=0 from DexScreener filtered from oracle mean
- **H1**: RPC API key redacted from log output (logs hostname only)
