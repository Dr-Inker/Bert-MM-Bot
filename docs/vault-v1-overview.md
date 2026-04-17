# Depositor vault v1 — overview

**Status (2026-04-17):** implementation complete on branch `feature/vault-v1`. 243/243 tests pass, build clean, security-reviewed. Awaiting deploy per `docs/deploy-vault-v1.md`.

## What this is

A **custodial depositor vault** bolted onto the existing bert-mm-bot. Friends can send SOL and/or BERT to a personal deposit address, those funds get pooled with the bot's market-making capital, and depositors earn a proportional share of the pool's NAV via a simple `shares × NAV-per-share` accounting model. Self-service withdrawals happen through the existing Telegram bot, gated by TOTP and a 24-hour whitelist cooldown.

## Why pool funds at all

Two reasons:

1. **Market making wants depth.** A $200 canary pool earns proportionally less in fees than a $5k pool, because fee revenue scales with inventory × turnover. Pooling friends-and-family capital lets the strategy run at a size where fees outpace rebalance friction + impermanent loss.
2. **BERT holders want yield on their BERT.** A pure-BERT HODLer can deposit and earn fees without selling. The vault treats SOL and BERT symmetrically — either side is fine.

It's custodial on purpose. The operator (you) holds all private keys including per-user deposit-address keys. This keeps the implementation simple enough to ship solo, trades ergonomics for blast radius. Every depositor signs off on that explicitly in the disclaimer before enrollment.

## How it works, end to end

### Enrollment

```
User:                                Bot:
/account                          →
                                  ← Disclaimer + "reply /accept or /decline"
/accept                           →
                                  ← Base32 TOTP secret + "reply with a 6-digit code"
  [scans secret in Authy]
123456                            →
                                  ← "2FA confirmed"
```

At this point the user has a `vault_users` row with:
- A random Solana Keypair (encrypted with the master key via AES-256-GCM, one IV per user).
- A TOTP secret (also encrypted).
- Role = `depositor`.

### Deposit

```
User sends 0.5 SOL to their unique deposit address
  ↓
depositWatcher polls the address (every tick, 30 s)
  ↓
onInflow detected
  ↓
Oracle preflight — if oracle is unhealthy, defer. Funds stay in deposit address; retry next tick.
  ↓
Build sweep tx: decrypt user's keypair, transfer SOL (minus rent reserve) + BERT to main pool wallet
  ↓
Submit + confirm sweep on-chain (signed by user's deposit key + bot's payer key)
  ↓
Credit: mint `shares = depositUsd / navPerShare` to the user (atomic DB transaction that also writes a NAV snapshot and audit event)
```

The user's share balance goes up; the main pool wallet's SOL/BERT balances go up. The bot's next rebalance tick picks up the new liquidity and deploys it into the Meteora DLMM position.

### Withdrawal

```
User:                                Bot:
/withdraw 50                      →  (= $50 worth)
                                  ← "Reply with a 6-digit code"
123456                            →
                                  ← "Queued — id #42, processing on next tick"

  [next tick]
withdrawalExecutor.drain()
  ↓
For each queued withdrawal:
  - compute shares-to-burn (gross) and net-USD-out (gross − 0.30% fee)
  - if free wallet balance is short, call venueClient.partialClose to free liquidity from the LP
  - submit transfer tx (SOL + BERT) to user's whitelisted address
  - mark withdrawal tx_sig on the row BEFORE committing the burn (double-pay guard)
  - atomic DB transaction: burn shares, write NAV snapshot, write audit
```

The 0.30% fee **stays in the pool**. Remaining holders' NAV-per-share tick up by `feeShares × navPerShare`.

### Whitelist cooldown

First-set of withdrawal address is immediate (still TOTP-gated). Subsequent changes queue for 24 hours before activating; the user can `/cancelwhitelist` at any time before the deadline. This is the primary mitigation against a compromised Telegram session instantly draining a depositor.

## Architecture

```
                ┌──────────────────────┐
                │   Telegram (user)    │
                └──────────┬───────────┘
                           │
                ┌──────────▼───────────┐
                │ telegramCommander    │  auth gate: operator|vault|public|enrollment
                └──────────┬───────────┘
                           │
            ┌──────────────┼──────────────┐
            │              │              │
     ┌──────▼────┐  ┌──────▼─────┐  ┌─────▼──────────┐
     │ Enroll    │  │ Commands   │  │ Operator cmds  │
     │ /account  │  │ /deposit   │  │ /pausevault    │
     │ /accept   │  │ /balance   │  │ /vaultstatus   │
     │ /decline  │  │ /withdraw  │  │ /forceprocess  │
     │           │  │ /setwl     │  │ /recreditdep   │
     │           │  │ /cancelwl  │  │ /resettotp     │
     │           │  │ /stats     │  │                │
     └────┬──────┘  └──────┬─────┘  └────┬───────────┘
          │                │             │
          │        ┌───────▼──────────┐  │
          │        │ TotpRateLimiter  │  │  (5/15min lockout)
          │        └──────────────────┘  │
          │                              │
     ┌────▼──────────────────────────────▼──┐
     │          DepositorStore              │  (SQL)
     │  vault_users / vault_shares          │
     │  vault_deposits / vault_withdrawals  │
     │  vault_nav_snapshots                 │
     │  vault_pending_whitelist_changes     │
     │  vault_audit_log                     │
     └───────────────────────────────────────┘

Tick loop (main.ts, every 30 s):
  1. depositWatcher.pollAddress(user) for each user
       → DepositPipeline.onInflow — preflight oracle, build sweep, submit, confirm, credit
  2. MM rebalance (unchanged from pre-vault)
  3. withdrawalExecutor.drain()
       → per queued row: compute split, partialClose if short, executeTransfer, markSent, commit
  4. cooldowns.activateDue({ now })  — flip due whitelist changes
```

All state is in the existing `/var/lib/bert-mm-bot/state.db`. A daily backup (03:00 UTC, 30 rolling days) lives in `systemd/bert-mm-bot-backup.{service,timer}`.

## Safety model

Every sensitive action is gated. The gates compose — you need to pass all of them, and any single failure is fail-closed.

- **TOTP** on `/deposit`, `/balance`, `/withdraw`, `/setwhitelist`, `/cancelwhitelist`. Replay-protected (counter must strictly advance).
- **Rate limit** — 5 TOTP failures in 15 min → 15-minute lockout. Preflighted at command invoke AND at verify; locked users can't pile up pending actions.
- **Whitelist cooldown** — 24 h for address changes (first set immediate).
- **Daily caps** per user — count and USD. Global cap on queue depth.
- **Withdrawal double-pay guard** — tx signature is written to the row BEFORE the share burn commits. If the DB write fails afterwards, the row stays in `processing` with `tx_sig` populated; `/forceprocess` refuses to requeue it. Operator must manually reconcile.
- **Swept-but-not-credited** — oracle health is preflighted BEFORE the sweep. If the rare case still happens (post-sweep DB fail), `/recreditdeposit <sig>` is the break-glass.
- **Operator gating** — `msg.userId === cfg.vault.operatorTelegramId` (NOT chat_id). Bot refuses to start with vault enabled and this missing.
- **Boot preflight** — bot refuses to start with vault enabled if the main wallet's BERT ATA is missing and can't be created.
- **Pause / kill / degraded / drawdown** — all four flags stop withdrawal drain. Pause is operator-controlled (`/pausevault`); the others are automatic.
- **Fee stays in pool** — withdrawal fee accretes to remaining holders via NAV snapshot math; operator does NOT take a cut.

## What's where in the repo

| Area | Primary files |
|---|---|
| Spec | `docs/superpowers/specs/2026-04-17-depositor-vault-design.md` |
| Plan (24 tasks) | `docs/superpowers/plans/2026-04-17-depositor-vault.md` |
| Deploy runbook | `docs/deploy-vault-v1.md` |
| Overview (this doc) | `docs/vault-v1-overview.md` |
| Domain types | `src/vault/types.ts` |
| SQL schema (vault_* tables) | `src/stateStore.ts` SCHEMA_SQL |
| SQL layer | `src/vault/depositorStore.ts` |
| Crypto | `src/vault/encryption.ts`, `src/vault/totp.ts`, `src/vault/rateLimiter.ts` |
| Math | `src/vault/shareMath.ts`, `src/vault/navSnapshot.ts` |
| Enrollment / cooldowns | `src/vault/enrollment.ts`, `src/vault/cooldowns.ts` |
| Deposit pipeline | `src/vault/depositWatcher.ts`, `src/vault/sweeper.ts`, `src/vault/depositPipeline.ts`, `src/vault/creditEngine.ts` |
| Withdrawal pipeline | `src/vault/withdrawalBuilder.ts`, `src/vault/withdrawalExecutor.ts`, partialClose in `src/meteoraClient.ts` |
| Telegram handlers | `src/vault/commands.ts`, `src/vault/operatorCommands.ts`, `src/vault/disclaimer.ts` |
| Audit + flags | `src/vault/audit.ts`, `src/vault/flags.ts` |
| Tick-loop glue | `src/vault/tick.ts`, wiring in `src/main.ts` |
| Boot preflight | `src/vault/preflight.ts` |
| Bootstrap CLI | `src/cli/vault-bootstrap.ts` |
| Backup timer | `systemd/bert-mm-bot-backup.{service,timer}`, `scripts/backup-state.sh` |
| Tests | `tests/vault/*.test.ts` (20 files, 168 tests) |

## Commands reference

### User commands (TOTP-gated except `/account` and `/accept`/`/decline`)

| Command | Purpose |
|---|---|
| `/account` | Show disclaimer (fresh user) or re-enter enrollment mid-setup, or show help (enrolled) |
| `/accept` | Accept disclaimer; begins TOTP enrollment |
| `/decline` | Abort enrollment |
| `/deposit` | Reveal your unique deposit address (TOTP) |
| `/balance` | Your shares + current USD value (TOTP) |
| `/withdraw <usd>` or `/withdraw N%` | Queue a withdrawal (TOTP) |
| `/setwhitelist <address>` | Set withdrawal destination — first immediate, subsequent 24h delay (TOTP) |
| `/cancelwhitelist` | Cancel the most recent pending whitelist change (TOTP) |

### Public

| Command | Purpose |
|---|---|
| `/stats` | TVL + NAV/share + 24h delta — no auth required |

### Operator (gated on `vault.operatorTelegramId`)

| Command | Purpose |
|---|---|
| `/pausevault` | Halt the withdrawal drain; deposits still credit |
| `/resumevault` | Resume drain |
| `/vaultstatus` | TVL / shares / queued count / pending whitelist / last NAV / last 5 audit events |
| `/forceprocess <id>` | Retry a failed withdrawal — refuses if `tx_sig` is populated (see N1) |
| `/recreditdeposit <inboundTxSig>` | Break-glass: credit a deposit that was swept but not credited |
| `/resettotp <telegramUserId>` | Clear a user's TOTP so they can re-enroll (e.g., lost authenticator) |

## Key config fields

In `/etc/bert-mm-bot/config.yaml`:

```yaml
vault:
  enabled: true
  withdrawalFeeBps: 30              # 0.30% — stays in pool
  minDepositUsd: 10
  minWithdrawalUsd: 5
  maxDailyWithdrawalsPerUser: 3
  maxDailyWithdrawalUsdPerUser: 5000
  maxPendingWithdrawals: 50
  depositMinConfirms: 1
  whitelistCooldownHours: 24
  operatorTelegramId: <your telegram user_id>
```

Plus the env variable `VAULT_MASTER_KEY` (base64-encoded 32 bytes) loaded from `/etc/bert-mm-bot/env` via the systemd `EnvironmentFile=` directive.

## Observability

The hourly Telegram status report (which already exists for the MM bot) is extended with a vault line when `vault.enabled`:

```
Vault: 3 depositors, TVL $1234.56, NAV/share $1.2346 (24h Δ +1.23%), 2 queued
```

The audit log (`vault_audit_log` table) is the source of truth for every sensitive action. Key events to grep for:

- `bootstrap` — one-time init
- `disclaimer_accepted`, `totp_enrolled`, `totp_verify_failed`, `totp_rate_limited`, `totp_reset`
- `deposit_detected`, `deposit_deferred_oracle_unavailable`, `deposit_swept`, `deposit_credited`, `deposit_sweep_failed`, `deposit_recredited`
- `withdrawal_queued`, `withdrawal_completed`, `withdrawal_failed`, `withdrawal_requeued`, `withdrawal_db_sync_failed`
- `whitelist_set`, `whitelist_cancel`, `whitelist_activated`
- `vault_paused`, `vault_resumed`
- `deposit_reveal`, `balance_reveal` (user viewed sensitive data)

## Known v1.1 follow-ups

Captured in full in `docs/deploy-vault-v1.md` under "Known v1.1 follow-up items". Summary: mostly operational polish (rate limiter persistence, observability enrichments, invariant reconciliation) plus a couple of UX rough edges (off-curve destination rejection, fee-share accounting for queued rows against stale NAV). None block v1; all worth tracking before onboarding beyond a trusted cohort.

## Test surface

- 20 files, 168 tests under `tests/vault/`.
- Unit tests for every pure module (share math, NAV, encryption, TOTP, cooldowns, sweeper, withdrawal builder).
- Integration tests for deposit pipeline onInflow, withdrawal executor drain (happy path + 5 failure modes + 2 robustness cases), tick ordering, operator commands, command handlers (28 tests covering all user flows).
- End-to-end test in `tests/vault/integration.test.ts`: bootstrap → enroll → credit → withdraw → share-invariant check.
- Plus the 10 previously-failing `tests/meteoraClient.test.ts` were repaired via `require.cache` preseed.

Full suite: 31 files, 243 tests, all green.
