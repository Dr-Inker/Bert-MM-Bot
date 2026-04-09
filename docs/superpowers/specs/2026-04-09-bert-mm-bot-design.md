# BERT Market-Maker Bot — Design Spec

**Date:** 2026-04-09
**Author:** brainstormed with Claude
**Status:** Draft for review
**Pilot scope:** $2,000 project-treasury capital, balanced risk posture

---

## 1. Problem & goal

BERT (`HgBRWfYxEfvPhtqkaeymCQtHCrKE46qQ43pKe8HCpump`) is a Pump.fun-graduated
Solana memecoin whose primary liquidity sits in a Raydium v4 AMM pool
(`BmsZE6TkZYskyS1PatPKRyyazGdxWFxdia4BuvLg9AgY`, ~$682k TVL, ~$26k/day
volume as of 2026-04-09). A project insider wants to **tighten the effective
BERT/SOL spread** seen by Jupiter-routed swaps and **grow organic trade
volume** by providing better pricing at the mid.

### Why a classical CLOB market maker is the wrong tool

BERT has no liquid CLOB (Phoenix/Openbook) market. Jupiter routes memecoin
swaps through AMMs, so spread compression only happens if we **improve the
best AMM quote**. The v4 pool is immovable (burned LP, full-range constant
product), so adding liquidity to it increases depth but does not narrow
spread per unit of capital.

### The actual solution

Provide **concentrated liquidity on a Raydium CLMM pool for BERT/SOL**,
actively managed by a bot that keeps the position centered around spot.

- A Raydium CLMM pool for BERT/SOL **already exists**
  (`9LkdXDXQkWC8RgqMTn2eAnzgFTNjKjJiSq4smpdKLuaH`) with only ~$1.6k TVL. A
  new $2k concentrated position effectively takes over that pool and earns
  ~100% of fees routed to it while in range.
- Jupiter already checks all Raydium pools; the moment the CLMM position
  offers a better price than the v4 pool for a given swap size, Jupiter
  routes through it automatically.
- Concentrated liquidity in a ±20% range around spot gives roughly
  50–500× the capital efficiency of the v4 pool near mid.

### Success criteria for the pilot

1. **Time-in-range ≥ 80%** averaged over any 7-day window.
2. **Positive net return after gas** over any 30-day window once the bot
   has been running ≥7 days. (Not "beat HODL" — concentrated LP has IL;
   the goal is positive fee yield net of rebalance costs.)
3. **Zero unauthorized / unexpected fund movements** from the hot wallet.
4. **Zero incidents requiring treasury top-up** caused by bot bugs (vs
   caused by deliberate capital adds).
5. **Measurable improvement** in BERT/SOL quoted spread on Jupiter for
   swaps ≤ $500 compared to routing through v4 alone.

### Non-goals (explicitly out of scope for the pilot)

- Multi-venue MM (Meteora DLMM, Orca, etc.).
- Inventory-skewed asymmetric ranges.
- Volatility-adaptive range width.
- Fee sweep/auto-compounding policy switching at runtime.
- On-chain circuit breaker program.
- Multi-sig on the hot wallet (deliberate — see §7).
- CI/CD pipeline.
- A UI.

These are deferred to post-pilot iterations and called out where relevant.

---

## 2. Approach selection

Three approaches were considered:

| # | Approach | Decision |
|---|---|---|
| 1 | Manual-friendly CLI only, human rebalances on alert | Rejected — no 24/7 coverage |
| 2 | **Autonomous bot with guardrails** | **Selected** |
| 3 | Full active MM with inventory skew and vol-adaptive range | Deferred — overkill at $2k pilot size, revisit after #2 proves out |

---

## 3. Tech stack

- **Language:** TypeScript (Node.js 22 LTS).
  - Chosen over Python because Raydium's official SDK
    (`@raydium-io/raydium-sdk-v2`) is TypeScript-first. Python community
    libraries lag protocol changes — unacceptable for treasury funds.
- **Package manager:** pnpm.
- **Key libraries:**
  - `@raydium-io/raydium-sdk-v2` — pool and position management.
  - `@solana/web3.js`, `@solana/spl-token` — Solana primitives.
  - `@coral-xyz/anchor` — raw program calls if needed.
  - `pino` — structured JSON logging.
  - `zod` — config schema validation.
  - `dotenv` — env loading.
  - `better-sqlite3` — synchronous SQLite driver.
- **Runtime:** `systemd` service on a Linux VPS. No Docker for the pilot.
- **Repository location:** new standalone repo at `/opt/bert-mm-bot/`.
- **State location:** `/var/lib/bert-mm-bot/state.db` (SQLite).
- **Log location:** `/var/log/bert-mm-bot/bot.log` (rotated by `logrotate`).
- **Config location:** `/etc/bert-mm-bot/config.yaml` (non-secret).
- **Key location:** `/etc/bert-mm-bot/hot-wallet.json` (`chmod 600`, owned
  by `bertmm` user).

---

## 4. Architecture

One Node process, eight modules with narrow interfaces. The strategy module
is pure (no I/O) so it can be unit-tested exhaustively.

```
┌──────────┐   ┌────────────┐   ┌──────────────────────┐
│  config  │──▶│   main     │──▶│  strategy / brain    │
│  loader  │   │  loop      │   │  (decides actions)   │
└──────────┘   └────────────┘   └──────────┬───────────┘
     │               │                     │
     ▼               ▼                     ▼
┌──────────┐   ┌────────────┐   ┌──────────────────────┐
│  state   │◀──│  price     │   │   raydium client     │
│  store   │   │  oracle    │   │   (pool + position)  │
└──────────┘   └────────────┘   └──────────┬───────────┘
     ▲                                     │
     │                                     ▼
┌────┴─────┐                    ┌──────────────────────┐
│ notifier │◀───────────────────│   tx submitter       │
│(webhook) │                    │ (sign, send, confirm)│
└──────────┘                    └──────────────────────┘
```

### 4.1 Module responsibilities

| Module | Purpose | Side effects |
|---|---|---|
| `config` | Load + validate `config.yaml` + env via `zod`. Fail at boot on bad config. | File read only |
| `raydiumClient` | Only module that talks to Raydium. Exposes: `getPoolState`, `getPosition`, `openPosition`, `closePosition`, `collectFees`, `quotePrice`. | RPC reads + tx construction |
| `priceOracle` | Fetch BERT/SOL mid from 3 sources (Raydium v4 spot, Jupiter quote API, DEXScreener). Return single trusted mid or `null` if sources disagree. | HTTP |
| `strategy` | **Pure.** `decide(state) → HOLD \| REBALANCE \| PAUSE \| ALERT_ONLY`. 100% unit-testable. | None |
| `txSubmitter` | Only module that signs. Sign, send, confirm, retry, priority-fee bump, RPC failover. | Signs and sends tx |
| `stateStore` | SQLite wrapper. Persists position NFT mint, last rebalance time, daily counter, action log, cumulative fees. Crash-recoverable. | SQLite writes |
| `notifier` | Webhook sender (Telegram/Discord). No logic. | HTTP |
| `main` | Orchestrator loop. Every 30s: oracle → state → strategy → (execute?) → state → notify. | Calls all the above |

### 4.2 Main loop cadence

Fixed **30-second polling**. No websocket subscriptions. Rationale: rebalance
decisions are minutes-to-hours, not milliseconds; a polling loop is
dramatically simpler, easier to test, and eliminates event-stream race
conditions.

### 4.3 Module boundary invariants

- Strategy never imports Raydium SDK types. All chain types are wrapped
  into strategy-domain types in `raydiumClient`.
- Only `txSubmitter` has access to the signing keypair.
- Only `notifier` performs user-facing egress.
- `main` has no business logic — it is a pure orchestrator.

---

## 5. Rebalance logic

### 5.1 Position shape

- **Venue:** existing Raydium CLMM pool
  `9LkdXDXQkWC8RgqMTn2eAnzgFTNjKjJiSq4smpdKLuaH`.
- **Fee tier:** to be verified during implementation. If the existing pool's
  fee tier is unsuitable for a volatile memecoin (e.g., 0.01% or 0.05%),
  a new CLMM pool at 0.25% or 1% should be created instead. The spec
  assumes we use the existing pool; adjust at the first implementation
  step if verification shows a bad tier.
- **Range shape:** symmetric around mid. `L = C × (1 − w)`,
  `U = C × (1 + w)` where `w = rangeWidthPct / 100` (default `w = 0.20`,
  i.e. ±20%).
- **Size:** ~$2,000 total value (~$1,000 BERT + ~$1,000 SOL at deploy).

### 5.2 Decision function

Pure function `strategy.decide(state) → Decision`:

```
REBALANCE if ALL of:
  (1) price has been OUTSIDE [L, U] for ≥ sustainedMinutes consecutive samples
  (2) (now − lastRebalanceAt) ≥ minRebalanceIntervalMin
  (3) rebalancesToday < maxRebalancesPerDay

ALERT_ONLY if (1) true but (2) or (3) blocks
PAUSE if killSwitch or degraded flag set or oracle stale > threshold
HOLD otherwise
```

### 5.3 Rebalance execution sequence

1. **Pre-flight re-check.** Re-query oracle, re-verify conditions. Abort if
   any condition now false.
2. **Simulate close.** Use SDK to simulate `closePosition`; compute
   effective close price. Abort if it deviates from oracle by
   `> maxSlippageBps`.
3. **Close position.** `closePosition(nftMint)`. This also collects all
   accrued fees.
4. **Compute new range.** `newCenter = oracle price`, `newL/newU` from
   `rangeWidthPct`.
5. **Inventory rebalance swap.** Swap on-chain (via Jupiter) to hit the
   BERT:SOL ratio required by the new symmetric range. Small correction
   at rebalance time; keeps the range symmetric and strategy simple.
6. **Open new position.** `openPosition(newL, newU, bertAmt, solAmt)`.
7. **Persist state.** Write new NFT mint, updated counters, rebalance log
   entry with old/new ranges, fees collected, inventory snapshot.
8. **Notify.** Webhook message with human-readable numbers.
9. **On any failure in steps 1–7:** abort the sequence, set `degraded=true`
   in state, send CRITICAL alert, transition to `PAUSE` until manually
   cleared. **Never auto-retry failed rebalances.**

### 5.4 Fee policy

- **Collection:** fees are collected as a side effect of `closePosition()`
  at rebalance time only. No standalone collection transactions in normal
  operation.
- **Handling:** `compound` mode for pilot — collected BERT/SOL rolls into
  the new position. Sweep mode is a future switch, not a runtime choice.
- A manual `bert-mm collect-fees` CLI command exists for one-off
  end-of-month treasury reporting collections; it does not rebalance.

### 5.5 Default parameter table

All parameters live in `config.yaml` and are validated at boot.

| Parameter | Default | Bounds | Purpose |
|---|---|---|---|
| `rangeWidthPct` | 20 | [1, 100] | Half-width of range, % around mid |
| `sustainedMinutes` | 10 | [1, 120] | Consecutive minutes out-of-range before trigger |
| `minRebalanceIntervalMin` | 60 | [5, 1440] | Floor on time between rebalances |
| `maxRebalancesPerDay` | 6 | [1, 48] | Hard daily cap |
| `maxSlippageBps` | 100 | [1, 500] | Abort threshold on close simulation |
| `pollIntervalSec` | 30 | [10, 300] | Main loop cadence |
| `feeCollectionMode` | `on_rebalance` | enum | vs `scheduled` (future) |
| `feeHandling` | `compound` | enum | vs `sweep` (future) |

---

## 6. Guardrails & kill-switches

### 6.1 Threat model

1. Bot bug (loop / wrong range / wrong amount).
2. Bad price data (stale or wrong RPC result).
3. Market gap or flash event.
4. Compromised VPS / stolen key.
5. Operator misconfiguration.
6. Community optics ("stop now" for non-technical reasons).

### 6.2 Automated guardrails

| # | Guardrail | Threat | Behavior |
|---|---|---|---|
| 1 | Daily rebalance cap (`maxRebalancesPerDay = 6`) | 1, 3 | After cap, `ALERT_ONLY` until UTC midnight |
| 2 | Minimum rebalance interval (`60 min`) | 1, 3 | Strategy cannot fire faster than floor |
| 3 | Oracle cross-check (`oracleDivergenceBps = 150`) | 2 | Oracle returns `null` if sources disagree; strategy returns `HOLD` |
| 4 | Oracle staleness (`oracleStaleMinutes = 15`) | 2 | `PAUSE` + CRITICAL alert |
| 5 | Pre-flight slippage abort (`maxSlippageBps = 100`) | 2, 3 | Abort rebalance, WARN alert |
| 6 | Drawdown breaker (`maxDrawdownPct = 15` over `drawdownWindowMin = 30`) | 1, 2, 3 | Sets `degraded=true`, `PAUSE` + CRITICAL. Cleared manually via `bert-mm clear-degraded` (§8.7) |
| 7 | Inventory sanity (`maxPositionUsd = 2200`, 5% headroom over $2k) | 1, 5 | Refuse to open position >105% of configured size |
| 8 | RPC failover + outage pause (`rpcOutageMinutes = 5`) | 2, 4 | Two independent paid RPCs; pause if both fail |
| 9 | Zod config schema | 5 | Refuse to boot on invalid config |
| 10 | Startup reconciliation | 1, 5 | On boot, on-chain position must match SQLite state; refuse to proceed otherwise |
| 11 | Hot-wallet SOL floor (`minSolBalance = 0.1`, hard pause at `0.03`) | Ops | Alert + pause when gas reserves low |

### 6.3 Kill-switches (all three must work; defense in depth)

| Level | Mechanism | Use case | Reaction time |
|---|---|---|---|
| **Soft** | Edit `config.yaml`, set `enabled: false` | Planned pauses | ≤ one poll cycle (~30s) |
| **Emergency** | `touch /var/lib/bert-mm-bot/KILLSWITCH` | Urgent, no config edit | ≤ one poll cycle |
| **Hard** | `systemctl stop bert-mm-bot` | Process distrust | Immediate (in-flight tx still lands) |

### 6.4 `PAUSE` semantics

`PAUSE` **does not close the position**. It freezes decisions only.
Position stays in place, fees continue to accrue. Closing on panic is
frequently wrong.

### 6.5 `emergency-exit`

Explicit CLI command. **Never automatic.** Prompts for operator
confirmation, logs the OS user, sends CRITICAL alert, closes the position
to cash in the hot wallet. One code path for "sell everything"; tested
and auditable.

### 6.6 Explicitly not built for the pilot

- Multi-sig on the hot wallet (would block autonomous signing).
- On-chain enforcement program.
- Wash-trade manipulation detection.
- Automated position resize.

Revisit when `maxPositionUsd ≥ $25,000`.

---

## 7. Wallet topology & key management

### 7.1 Three wallets, three roles

```
Treasury multi-sig (existing, untouched)
  │   manual top-ups (human signs each transfer)
  ▼
Hot wallet (bot, ~$2k cap)
  │   fees compound in place OR (future) swept manually
  ▼
Fee sink (optional, cold, receive-only) — unused in pilot
```

### 7.2 Hot wallet properties

- Fresh keypair created on the VPS:
  `solana-keygen new -o /etc/bert-mm-bot/hot-wallet.json`
- Ownership: `chown bertmm:bertmm`, permissions: `chmod 600`.
- Path configurable via env var, **never hardcoded**.
- Funded manually from the project treasury multi-sig.
- Sized at ~$2,000. `maxPositionUsd = 2200` cap means extra funds
  (accidental or deliberate) cannot be auto-deployed by the bot.
- Minimum SOL balance alerting (§6.2 #11).
- Encrypted backup of the keyfile is stored in a second location the
  operator controls (GPG-encrypted to an offline key). Without this,
  disk loss → irrecoverable position.

### 7.3 Capital flow — initial deploy

1. Treasury multi-sig signs transfer: ~$1,000 BERT + ~$1,000 SOL →
   hot wallet address.
2. Operator verifies transfer on-chain.
3. `systemctl start bert-mm-bot`.
4. Bot: validates config → loads keypair → checks balances ≤
   `maxPositionUsd` → reads empty state → opens initial position at
   current oracle price → persists NFT mint → notifies.

### 7.4 Capital flow — top-up (post-pilot)

Capital changes are always **stop → transfer → restart**; never mid-flight.

1. Update `maxPositionUsd` in `config.yaml`.
2. `systemctl stop bert-mm-bot` (or soft-pause via kill file).
3. `bert-mm emergency-exit` to collapse position to cash.
4. Treasury signs additional transfer to hot wallet.
5. `systemctl start bert-mm-bot` — fresh position at new size on next tick.

### 7.5 Recovery paths

| Incident | Response | Loss bound |
|---|---|---|
| VPS compromised, key stolen | Pre-drafted rescue tx sends hot-wallet contents to safe address; operator races attacker | ≤ `maxPositionUsd` |
| VPS disk dies | Restore encrypted keyfile backup on new VPS; reconcile against on-chain position via SQLite backup | 0 if backups intact |
| Bot misbehaves, key safe | Kill-switches from §6.3 | 0 |
| Bad oracle, directional | Drawdown breaker §6.2 #6 | ≤ 15% of position |

### 7.6 Why no hardware wallet / KMS / remote signer for the pilot

- Hardware wallets cannot sign autonomously — defeats the bot.
- KMS remote signing adds infra, latency, cost, and a new attack surface
  (KMS credentials) for no meaningful benefit at $2k.
- Custody APIs (Turnkey, Fireblocks) are institutional-tier and cost more
  than the pilot earns.

**Explicit revisit trigger:** when `maxPositionUsd ≥ $25,000`, replace
plain keyfile with a remote signer (KMS or Turnkey).

### 7.7 VPS hardening (minimum bar)

- Dedicated `bertmm` user; no sudo; `/usr/sbin/nologin`.
- SSH: key-only, non-default port, fail2ban.
- Unattended security upgrades.
- Firewall: inbound SSH only (ideally IP-allowlisted); all outbound allowed.
- Keyfile `chmod 600`, owned by `bertmm`.
- Secrets delivered via systemd `EnvironmentFile=` (also `chmod 600`).
- No `.env` files in the repo.
- Full-disk encryption at rest.

### 7.8 Publishing the hot wallet address

**Recommendation:** publish the hot wallet address in project channels
with a disclaimer explaining its purpose. Benefits (trust, turning
"mystery project wallet movements" into "that's just the published MM
wallet") outweigh the mild MEV/front-running concern at $2k scale.
**Operator decides** at deploy time; not a technical decision.

---

## 8. Observability & operations

### 8.1 Alerting (webhook)

Configurable: Telegram and/or Discord. Three severities:

- **INFO** — routine: start/stop, rebalance, daily report.
- **WARN** — self-recovered anomaly: slippage abort, oracle divergence,
  RPC fallback, out-of-range but cooldown active.
- **CRITICAL** — bot stopped itself or needs a human: `PAUSE` engaged,
  drawdown tripped, reconciliation failed, kill file detected.

CRITICAL is routed to a **separate channel** from INFO/WARN to prevent
alert fatigue muting genuine emergencies.

### 8.2 Message format

All messages are plain text, no required emoji. Every rebalance message
includes: timestamp, old range, new range, price move, fees collected,
post-rebalance inventory, `rebalance N/max today`.

### 8.3 Daily report (00:00 UTC)

- Position value + % change vs yesterday and since deploy
- Fees collected today + daily yield %
- Rebalances today / max
- **Time in range** (primary health metric; targets in §1)
- BERT 24h price move
- WARN / CRITICAL alert counts
- Overall status

### 8.4 Logs

- JSON via `pino` at `/var/log/bert-mm-bot/bot.log`.
- `logrotate` daily, compressed, retain 30 days.
- One log line per tick plus event lines.

### 8.5 State

- SQLite at `/var/lib/bert-mm-bot/state.db`.
- Tables: `position_state` (current NFT, range, opened_at),
  `rebalance_log` (every rebalance with full before/after),
  `daily_counters` (UTC-day buckets),
  `fee_collections`,
  `alert_log`,
  `operator_actions` (CLI-initiated actions with OS user).
- Backups: hourly rsync to a second host or encrypted bucket.

### 8.6 Heartbeat & liveness

- Bot writes `heartbeat.txt` timestamp every successful tick.
- Separate 5-minute cron checks heartbeat age; alerts if `> 2 min` stale.
- systemd `Restart=always`, `RestartSec=10`. Startup reconciliation
  catches inconsistent restart state.

### 8.7 Operator CLI (`bert-mm`)

| Command | Effect | Moves money? |
|---|---|---|
| `bert-mm status` | Show position, range, inventory, counters, oracle health | No |
| `bert-mm pause` | Set `enabled: false` | No |
| `bert-mm resume` | Set `enabled: true` | No |
| `bert-mm collect-fees` | Collect fees without rebalancing | Yes (tiny) |
| `bert-mm emergency-exit` | Close position to cash, with confirm prompt | **Yes** |
| `bert-mm rebalance --force` | Rebalance now, bypass cooldowns but not safety gates | **Yes** |
| `bert-mm report --days N` | Print a report to stdout | No |
| `bert-mm clear-degraded` | Clear the `degraded` flag set by drawdown breaker or failed rebalance; resumes normal decisions | No |
| `bert-mm reconcile` | Re-run startup reconciliation and, if the operator confirms, overwrite SQLite state from on-chain truth | No |

Every money-moving command logs to `operator_actions` with OS user.
`clear-degraded` and `reconcile` also log to `operator_actions` because
they transition the bot out of a safety state, even though they do not
move money themselves.

### 8.8 Deployment

- systemd unit `bert-mm-bot.service`; user `bertmm`.
- Upgrade flow: `git pull && pnpm install && pnpm build && systemctl restart bert-mm-bot`.
- No CI/CD for the pilot. Manual deploys with eyes on the logs.

---

## 9. Testing strategy

- **Unit tests (Jest or Vitest):** exhaustive coverage of `strategy.decide`.
  Every trigger combination, every guardrail edge, every state transition.
- **Unit tests:** `priceOracle` divergence logic with mocked sources.
- **Unit tests:** `config` schema validation (valid + invalid fixtures).
- **Unit tests:** `stateStore` CRUD + reconciliation logic.
- **Integration tests:** `raydiumClient` against Solana devnet with a
  devnet SPL token pair where possible; otherwise recorded fixtures.
- **Dry-run mode:** `DRY_RUN=true` env flag causes `txSubmitter` to log
  what it would submit without signing or broadcasting. Used for
  end-to-end rehearsal on mainnet before the real deploy.
- **Canary deploy:** first mainnet run uses `maxPositionUsd = 200` (one
  tenth of target) for 48 hours, to validate the whole pipeline with
  bounded loss exposure, before scaling to the $2k target.

---

## 10. Operational runbook (to be expanded during implementation)

Required runbook entries before go-live:

1. How to deploy the bot from a clean VPS.
2. How to fund the hot wallet from treasury multi-sig.
3. How to read the daily report and what action each status implies.
4. How to pause via each of the three kill-switches.
5. How to perform `emergency-exit` and where the cash lands.
6. How to rotate the hot wallet (generate new key, drain old, redeploy).
7. Pre-drafted rescue transaction for a key-compromise scenario.
8. How to tune `rangeWidthPct` based on observed time-in-range.

---

## 11. Open questions & deferred decisions

| # | Item | When to resolve |
|---|---|---|
| Q1 | Verify fee tier of existing Raydium CLMM pool `9LkdXDXQkWC8RgqMTn2eAnzgFTNjKjJiSq4smpdKLuaH`. If unsuitable (too low for volatility), create a new CLMM pool at 0.25% or 1% instead. | First step of implementation |
| Q2 | Choose RPC providers (Helius + ?) and obtain API keys. | Before deploy |
| Q3 | Choose VPS provider / reuse existing box (where do the other bots run?) | Before deploy |
| Q4 | Decide Telegram vs Discord vs both for alerting; create channels. | Before deploy |
| Q5 | Decide whether to publish the hot wallet address publicly. | At deploy time (operator call) |
| Q6 | After 30 days: review time-in-range; retune `rangeWidthPct` if needed. | Post-pilot |
| Q7 | After pilot: decide whether to expand to Meteora DLMM as a second venue. | Post-pilot |
| Q8 | At `maxPositionUsd ≥ $25k`: migrate key management to a remote signer. | Future capital bump |

---

## 12. Change log

- 2026-04-09 — Initial draft from brainstorming session.
