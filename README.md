# bert-mm-bot

Autonomous Raydium CLMM market-making bot for the **BERT/SOL** pool on Solana mainnet.

The bot keeps a single concentrated-liquidity position centered on the current price, monitors drift, and rebalances on its own when the position falls out of range — within strict safety limits and with multiple kill-switches.

> **Status:** Implementation complete (tasks 1–17 of the build plan). Pre-canary dry-run rehearsal against the live mainnet pool passed. Awaiting authorization for the canary deploy (~$200, single small position) before scaling to full capital.

---

## What it does

1. **Watches** the BERT/SOL Raydium CLMM pool and pulls a trusted mid price from three independent sources (Raydium quote, Jupiter quote, DexScreener) — at least two must agree within `oracleDivergenceBps` (default 1.5%).
2. **Holds** one concentrated-liquidity position centered on that mid, with a configurable width (default ±10% → `rangeWidthPct: 20`).
3. **Rebalances** when the price has been *sustained* outside the range for `sustainedMinutes` (default 10), subject to:
   - cooldown (`minRebalanceIntervalMin`, default 60)
   - daily cap (`maxRebalancesPerDay`, default 6)
   - drawdown breaker (`maxDrawdownPct` over `drawdownWindowMin`)
   - inventory cap (`maxPositionUsd`)
4. **Collects fees** opportunistically — either on every rebalance or via the `bert-mm collect-fees` operator command.
5. **Halts itself** on any of: oracle disagreement, RPC outage, drawdown trip, low SOL balance, kill-switch file present, or `enabled: false`.

It is intentionally a single-position passive market maker — not a quoting bot, not an arbitrageur, not a directional strategy. The goal is fee capture on a token where the team is the natural LP.

---

## Architecture

```
                ┌──────────────────────────────────┐
                │  main.ts  (poll loop, 30s)       │
                └──────┬───────────────────────────┘
                       │
       ┌───────────────┼────────────────────────────┐
       ▼               ▼                            ▼
  priceOracle     stateStore                  raydiumClient
  (3 sources,    (sqlite: positions,         (raydium-sdk-v2:
  median+        rebalances, pnl,             pool state, open/
  divergence)    daily counters,              close/swap tx
                 degraded flag)               builders, ATA mgmt)
       │               │                            │
       └───────┬───────┴────────────────────────────┘
               ▼
          strategy.ts
          (in-range check, sustained-out detector,
           drawdown breaker, range math)
               │
               ▼
          rebalancer.ts
          (9-step orchestration: check → close → verify
           → swap-to-ratio → open → persist → notify)
               │
               ▼
          txSubmitter (priority fee, retry, confirm)
```

**Tech stack:** TypeScript 5 / Node 22 / pnpm, `@raydium-io/raydium-sdk-v2`, `@solana/web3.js`, `@solana/spl-token`, vitest, pino, zod, better-sqlite3, commander.

**Key files (`src/`):**

| File | Responsibility |
|---|---|
| `main.ts` | Poll loop, dependency wiring, graceful shutdown |
| `config.ts` | YAML config + zod validation |
| `priceFetchers.ts` | Real Raydium/Jupiter/DexScreener fetchers |
| `priceOracle.ts` | 3-source median, divergence and staleness checks |
| `raydiumClient.ts` | All on-chain reads/writes against the CLMM pool |
| `strategy.ts` | Range math, sustained-out detector, drawdown breaker |
| `rebalancer.ts` | The 9-step rebalance orchestration |
| `stateStore.ts` | sqlite persistence (positions, rebalances, pnl, degraded flag) |
| `reconciler.ts` | Startup reconciliation between db and on-chain truth |
| `txSubmitter.ts` | Priority-fee tx submission with retry/confirm |
| `notifier.ts` | Discord/Telegram info + critical channels |
| `cli/` | 9 operator commands (status, pause, emergency-exit, …) |

---

## Safety model

The bot is designed so that *the worst it can do* is hold or rebalance a single position. It cannot send funds anywhere except into the configured pool or back to its own wallet.

**Hard limits enforced in code:**
- `maxPositionUsd` — total notional ceiling per position
- `maxSlippageBps` — refuses swaps worse than this
- `maxDrawdownPct` over `drawdownWindowMin` — trips a degraded flag, halts rebalances
- `minSolBalance` / `hardPauseSolBalance` — won't sign tx if SOL is too low
- `oracleDivergenceBps` — refuses to act if price sources disagree
- `rpcOutageMinutes` — degraded mode after sustained RPC failure

**Three independent kill-switches:**
1. **Soft:** edit config, `enabled: false`
2. **Emergency:** `touch /var/lib/bert-mm-bot/KILLSWITCH` (no SSH/build needed)
3. **Hard:** `systemctl stop bert-mm-bot`

**Dry-run mode:** `dryRun: true` builds and simulates every transaction but never submits. Used for the pre-canary rehearsal.

**Key compromise response:** `scripts/rescue-tx.ts <SAFE_DEST>` sweeps all SOL and BERT from the hot wallet to a destination of choice in a single transaction. Run from any host with the keyfile.

---

## Build status

| Phase | Status |
|---|---|
| Tasks 1–12: config, oracle, strategy, state, reconciler, notifier, txSubmitter, main loop, tests | ✅ Done |
| Task 13: Raydium SDK integration (read + write) | ✅ Done |
| Task 14: Operator CLI (9 commands) | ✅ Done |
| Task 15: systemd unit, logrotate, heartbeat alerting | ✅ Done |
| Task 16: rescue-tx key-compromise script | ✅ Done |
| Task 17: Operator runbook | ✅ Done |
| **Pre-canary rehearsal against live mainnet pool** | ✅ Passed |
| Task 18: Canary deploy ($200, 24h observation) | ⏸ Awaiting auth |

**Test suite:** 55 passing across 8 files (`pnpm vitest run`).

**Notable bug caught in rehearsal:** the `_usdToTick` helper had its mintA/mintB price-direction formula inverted in both branches. Caught by the dry-run rehearsal (it produced ticks ~185k off from the pool's current tick) and fixed in commit `dd9856b`. This bug would have caused the canary's first `openPosition` call to fail. The rehearsal earned its keep.

---

## Quick start

### Build

```bash
pnpm install
pnpm build
pnpm vitest run        # 55 tests should pass
```

### Configure

```bash
cp config.example.yaml /etc/bert-mm-bot/config.yaml
# fill in: rpcPrimary, rpcFallback, notifier webhooks, keyfilePath
```

Required config values are validated by zod at startup — missing or malformed fields fail loud.

### Wallet

```bash
solana-keygen new -o /etc/bert-mm-bot/hot-wallet.json
chown bertmm:bertmm /etc/bert-mm-bot/hot-wallet.json
chmod 600 /etc/bert-mm-bot/hot-wallet.json
```

Then fund from your treasury (~$1000 SOL + ~$1000 BERT to start).

### Run

```bash
cp systemd/bert-mm-bot.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now bert-mm-bot
journalctl -u bert-mm-bot -f
```

---

## Operator commands

```bash
bert-mm status              # current state, position, pnl, degraded?
bert-mm pause               # soft pause (sets enabled: false)
bert-mm resume              # unpause
bert-mm collect-fees        # collect fees without rebalancing
bert-mm emergency-exit      # close position to cash (interactive)
bert-mm rebalance --force   # rebalance now, bypass cooldowns
bert-mm report --days 7     # N-day pnl + time-in-range report
bert-mm clear-degraded      # clear safety flag after a trip
bert-mm reconcile           # re-run startup reconciliation
```

---

## Tuning

Primary health metric: **time in range** (daily report).

| Time in range | Action |
|---|---|
| > 90% | Range well-sized or slightly wide |
| 70–90% | Healthy, leave alone |
| < 70% | Range too tight; widen `rangeWidthPct` by 5 and restart |
| ~100% for a week | May be too wide; consider tightening by 5 |

**Capital changes** are always: `emergency-exit` → `systemctl stop` → treasury transfer → `systemctl start`. Never mid-flight.

---

## How it was built

This bot was built end-to-end using the [superpowers](https://github.com/anthropics/skills) subagent-driven-development workflow:

- **Brainstorming** → design spec at `docs/superpowers/specs/2026-04-09-bert-mm-bot-design.md` (520 lines)
- **Plan** → 18-task implementation plan at `docs/superpowers/plans/2026-04-09-bert-mm-bot.md` (2537 lines)
- **Execution** → fresh subagent per task, two-stage review (spec compliance, then code quality), TDD throughout

The full design spec and implementation plan are committed alongside the code so the team can see exactly *what* was built, *why*, and *how* every requirement maps to a task and a commit.

---

## Known limitations / next steps

- **Canary not yet run.** All write paths have been exercised in dry-run rehearsal against the real mainnet pool, but no real funds have been deployed yet. The canary is task 18: $200 single position, 24h observation, then scale.
- **Single pool only.** Architecture is generic but config + reconciler assume one pool per process. Multi-pool would mean multiple systemd units today.
- **No web UI.** Operator interface is CLI + Discord notifications only, by design.
- **Fee compounding is simple.** Collected fees are added to the next rebalance's inventory; there is no separate accounting.

---

## Repository layout

```
src/                        TypeScript sources (see Architecture table)
tests/                      vitest unit tests (55 tests, 8 files)
scripts/
  rescue-tx.ts              key-compromise sweep
  rehearsal.ts              pre-canary dry-run against live pool
  inspect-pool.ts           pool state inspector utility
systemd/bert-mm-bot.service systemd unit
ops/
  logrotate.conf            log rotation
  heartbeat-check.sh        cron-driven liveness alert
config.example.yaml         annotated config template
docs/superpowers/
  specs/...-design.md       full design document
  plans/...-bert-mm-bot.md  18-task implementation plan
```

---

## License

Internal — not for redistribution.
