# Depositor Vault — Design Spec

**Date:** 2026-04-17
**Status:** Approved — ready for implementation planning
**Scope:** v1 (`S2` — full v1 including 24h whitelist cooldown, cancel flow, notifications, daily caps, legal disclaimer)

## Purpose

Extend `bert-mm-bot` to accept pooled deposits from multiple users via the existing Telegram bot, and let each depositor self-service their withdrawals. The service is **custodial** (operator holds all keys, including per-depositor deposit-address keypairs); self-service refers to withdrawals, not custody. Depositors hold shares representing a proportional claim on the pool's NAV.

Non-goals for v1: non-custodial / MPC signing, trustless on-chain vault, performance fees, public stats beyond TVL/NAV, NAV history chart, deposit confirmations threshold tuning per-user, multi-asset tracking beyond SOL+BERT.

## Key decisions (from brainstorming)

| # | Topic | Choice |
|---|---|---|
| 1 | Deposit address pattern | Unique bot-generated keypair per user; accepts SOL + BERT; deposits swept to main pool wallet |
| 2 | Existing wallet balance at launch | Operator becomes founding depositor at current NAV (1 share = $1 at launch) |
| 3 | Fee model | 0.3% withdrawal fee stays in pool (raises NAV for remaining depositors) |
| 4 | 2FA | TOTP (Google Authenticator compatible), **always re-prompt** on sensitive actions, no session |
| 5 | Whitelist change | First-set immediate; subsequent change requires 24h cooldown with `/cancelwhitelist` window |
| 6 | Withdrawal timing | Queue behind rebalance mutex; partial LP close if free balance insufficient |
| 7 | Visibility | Own balance/history + aggregate pool stats; public `/stats` shows only TVL and NAV/share |
| 8 | Architecture | Inside existing `bert-mm-bot` process; new `src/vault/` modules |

## Section 1 — Architecture & module layout

Single process, single systemd service, single SQLite DB. New code under `src/vault/`:

```
src/vault/
  depositorStore.ts     DB access for vault tables; all writes wrapped in withTransaction()
  shareMath.ts          Pure: computeNav, sharesForDeposit, amountForShares, applyFee
  totp.ts               TOTP secret gen + otpauth URI + verify (library: otpauth)
  depositWatcher.ts     Polls per-user deposit addresses; sweeps confirmed deposits
  withdrawalExecutor.ts Drains queue under rebalance mutex; partial LP close as needed
  cooldowns.ts          Pending whitelist changes: enqueue, notify, activate, cancel
  navSnapshot.ts        Extracted NAV math (from main.ts:217-246) — single source of truth
  commands.ts           Telegram handlers: /account, /deposit, /balance, /withdraw, /stats,
                        /setwhitelist, /cancelwhitelist, /vaultstatus (operator)
  encryption.ts         AES-256-GCM helpers for TOTP + deposit keypair secrets
```

### Integration edits
- `stateStore.ts`: append `vault_*` tables to `SCHEMA_SQL`; add `withTransaction(fn)` helper (`db.transaction(fn)()`).
- `telegramCommander.ts`: broaden single-`authorizedChatId` auth to per-user registry via `vault_users.telegram_id`. Operator chat retains super-admin rights (existing `/pause`, `/resume`, `/status`). Depositors can only issue vault commands.
- `main.ts`: tick loop gains `depositWatcher.poll()` (no mutex) and `withdrawalExecutor.drain()` (inside rebalance mutex, after rebalance). Extract hourly-report NAV math into `navSnapshot.ts`.
- `rebalancer.ts`: unchanged. Vault is invisible to it; mutex wraps it from `main.ts`.
- `config.ts` + `types.ts`: add `vault` config block.
- New CLI: `vault-bootstrap` (one-time operator setup).

### Concurrency model
Single async tick loop. `Mutex` (`Promise<void>` chain) acquired by:
1. Rebalancer (existing)
2. Withdrawal drainer (new — runs after rebalance in same tick)
3. Deposit watcher sweep step (new — during sweep tx submission)

Deposit watcher polling (read-only) runs outside the mutex.

## Section 2 — Data model

All schemas added to `stateStore.ts`'s `SCHEMA_SQL` via `CREATE TABLE IF NOT EXISTS`. All multi-row writes wrapped in `withTransaction(fn)`.

```sql
CREATE TABLE vault_users (
  telegram_id          INTEGER PRIMARY KEY,
  role                 TEXT NOT NULL CHECK(role IN ('operator','depositor')),
  deposit_address      TEXT NOT NULL UNIQUE,
  deposit_secret_enc   BLOB NOT NULL,     -- AES-GCM encrypted ed25519 secret
  deposit_secret_iv    BLOB NOT NULL,
  totp_secret_enc      BLOB,              -- NULL until enrolled
  totp_secret_iv       BLOB,
  totp_enrolled_at     INTEGER,
  totp_last_used_counter INTEGER,         -- replay-protection (time / 30)
  whitelist_address    TEXT,              -- NULL until first-set
  whitelist_set_at     INTEGER,
  disclaimer_at        INTEGER NOT NULL,
  created_at           INTEGER NOT NULL
);
CREATE INDEX idx_vault_users_deposit ON vault_users(deposit_address);

CREATE TABLE vault_shares (
  telegram_id   INTEGER PRIMARY KEY REFERENCES vault_users(telegram_id),
  shares        REAL NOT NULL            -- current balance (IEEE754 double)
);

CREATE TABLE vault_deposits (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id       INTEGER NOT NULL,
  inbound_tx_sig    TEXT NOT NULL UNIQUE,     -- dedup guard
  sweep_tx_sig      TEXT,
  sol_lamports      INTEGER NOT NULL,
  bert_raw          INTEGER NOT NULL,
  sol_usd           REAL NOT NULL,
  bert_usd          REAL NOT NULL,
  nav_per_share_at  REAL NOT NULL,
  shares_minted     REAL NOT NULL,
  confirmed_at      INTEGER NOT NULL,
  swept_at          INTEGER
);
CREATE INDEX idx_vault_deposits_user ON vault_deposits(telegram_id);

CREATE TABLE vault_withdrawals (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id       INTEGER NOT NULL,
  status            TEXT NOT NULL CHECK(status IN ('queued','processing','completed','failed')),
  destination       TEXT NOT NULL,            -- snapshot of whitelist at enqueue time
  shares_burned     REAL NOT NULL,
  fee_shares        REAL NOT NULL,            -- 0.3% of shares_burned, stays in pool
  nav_per_share_at  REAL,
  sol_lamports_out  INTEGER,
  bert_raw_out      INTEGER,
  tx_sig            TEXT,
  failure_reason    TEXT,
  queued_at         INTEGER NOT NULL,
  processed_at      INTEGER
);
CREATE INDEX idx_vault_withdrawals_status ON vault_withdrawals(status);

CREATE TABLE vault_pending_whitelist_changes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id   INTEGER NOT NULL,
  old_address   TEXT,                         -- NULL on first-set
  new_address   TEXT NOT NULL,
  requested_at  INTEGER NOT NULL,
  activates_at  INTEGER NOT NULL,             -- requested_at + 24h (= requested_at on first-set)
  status        TEXT NOT NULL CHECK(status IN ('pending','activated','cancelled')),
  cancel_reason TEXT
);
CREATE INDEX idx_vault_wl_pending ON vault_pending_whitelist_changes(status, activates_at);

CREATE TABLE vault_nav_snapshots (
  ts               INTEGER PRIMARY KEY,        -- ms epoch
  total_value_usd  REAL NOT NULL,
  total_shares     REAL NOT NULL,
  nav_per_share    REAL NOT NULL,
  source           TEXT NOT NULL               -- 'hourly','deposit','withdrawal','bootstrap'
);

CREATE TABLE vault_audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  telegram_id   INTEGER,                      -- NULL for system events
  event         TEXT NOT NULL,
  details_json  TEXT NOT NULL
);
CREATE INDEX idx_vault_audit_ts ON vault_audit_log(ts);
CREATE INDEX idx_vault_audit_user ON vault_audit_log(telegram_id, ts);
```

### Encryption
AES-256-GCM via Node `crypto`. Master key in `VAULT_MASTER_KEY` env var (systemd-injected, NOT in `config.yaml`). Each record has its own 12-byte IV stored alongside ciphertext. No key rotation in v1; the master key is treated operationally like the wallet keyfile.

### BERT ATA pre-creation
On user enrollment, bot creates the BERT associated-token-account owned by the deposit keypair (rent ~0.002 SOL, paid from main pool wallet). Guarantees BERT can be received without sender-side auto-creation edge cases.

### Numeric precision
- Shares, USD values: `REAL` (IEEE754 double). Safe up to ~1e15 total shares.
- SOL/BERT token amounts: integer base units (lamports, raw).
- Share computations use doubles; precision loss bounded and documented.
- If pool growth ever exceeds safe double range, migrate to fixed-point (not an MVP concern).

## Section 3 — Key flows

### Flow A — TOTP enrollment + account creation
1. User: `/account` (first time).
2. Bot: legal disclaimer (custodial service, operator holds keys, strategy risk, IL risk, no guaranteed returns). Buttons: `Accept` / `Decline`.
3. On `Accept`, single `withTransaction`:
   - Generate ed25519 deposit keypair → encrypt secret.
   - Generate 160-bit TOTP secret → encrypt.
   - Insert `vault_users` (role=`depositor`, whitelist NULL, totp_enrolled_at NULL, disclaimer_at=now).
   - Insert `vault_audit_log` (event=`disclaimer_accepted`).
4. Bot: builds + submits BERT ATA creation tx (owner = deposit address, payer = main pool wallet).
5. Bot: sends TOTP QR PNG (`qrcode` npm lib) + fallback `otpauth://` URI. Instructs user to scan + reply with 6-digit code.
6. User replies with code → `totp.verify()` → on success: UPDATE `totp_enrolled_at=now, totp_last_used_counter=current`; audit-log `totp_enrolled`; reply "Enrolled. Use `/deposit` to see your deposit address."

### Flow B — Deposit (watcher + credit)
Per-tick (outside mutex for polling; inside for writes).
1. For each `vault_users`: `getSignaturesForAddress(deposit_address, limit=10)` since last-checked sig.
2. For each new signature not in `vault_deposits.inbound_tx_sig`:
   - Fetch parsed tx; compute SOL delta to deposit address + BERT SPL transfer delta into its ATA.
   - If delta > 0 AND confirmations ≥ `vault.depositMinConfirms` (default 1):
     - Acquire rebalance mutex.
     - `navSnapshot.compute()` → if null (oracle divergence), skip this tick, retry next.
     - `deposit_usd = sol_in*solUsd + bert_in*bertUsd`; `shares_to_mint = deposit_usd / nav_per_share`.
     - Build + sign sweep tx (SOL via SystemProgram, BERT via SPL token transfer; signer = deposit keypair) → main pool wallet.
     - Submit via `TxSubmitter`; on confirm, single `withTransaction`:
       - INSERT `vault_deposits` (with both `inbound_tx_sig` and `sweep_tx_sig`).
       - UPSERT `vault_shares` (add `shares_to_mint`).
       - INSERT `vault_nav_snapshots` (source=`deposit`).
       - INSERT `vault_audit_log` (event=`deposit_credited`).
     - Release mutex.
     - Telegram notify user: "Deposit confirmed. $XX.XX @ NAV $Z.ZZZZ → +YY.YY shares."

Edge cases:
- Dup sigs: UNIQUE constraint on `inbound_tx_sig`.
- Unsupported tokens: ignored, dust remains (documented behaviour).
- Sweep fails: no DB write → deposit re-seen on next poll → retried. No double credit because the insert is guarded by UNIQUE(inbound_tx_sig) AND happens only after sweep confirmation.

### Flow C — Withdrawal
1. User: `/withdraw 50%` or `/withdraw 0.5 SOL` (units parsed; rejected if no whitelist, shares=0, or caps breached).
2. Bot prompts TOTP; user submits; `totp.verify()` with replay check.
3. Single `withTransaction`: INSERT `vault_withdrawals` (status=`queued`, destination = current whitelist *snapshot*, shares_burned, fee_shares = shares_burned × 0.003); audit-log `withdrawal_queued`.
4. Reply: "Withdrawal queued. Processing ~30s."
5. `withdrawalExecutor.drain()` (inside rebalance mutex after rebalance):
   - SELECT queued rows ORDER BY `queued_at`, serial.
   - For each:
     - UPDATE status=`processing`.
     - `navSnapshot.compute()` → null? mark `failed` (reason=`oracle_unavailable`), leave shares untouched (row stays).
     - Compute: `net_shares = shares_burned − fee_shares`; `usd_owed = net_shares × nav_per_share`.
     - Split `usd_owed` into SOL + BERT **proportional to current pool composition** (free wallet + in-LP): `sol_frac = (free_sol_usd + pos_sol_usd) / total_usd`, etc. Keeps pool ratio stable.
     - Free-balance check. Short on one or both sides? `venueClient.partialClose({needSol, needBert})`:
       - To free SOL: remove liquidity from bins **below** the active bin (quote-side bins hold SOL when BERT is base). Work outward from the active bin (closest bin first) to minimise the range hit.
       - To free BERT: remove liquidity from bins **above** the active bin (base-side bins).
       - Active-bin liquidity is removed last (and only if needed) since it has the highest fee-earning potential going forward.
     - Reserve floor check: withdrawal cannot draw free SOL below `minSolFloorLamports + 10*tipLamports`. If still short after partial close: mark `failed` (reason=`reserves_insufficient`), notify operator.
     - Build transfer tx (SystemProgram.transfer for SOL + SPL token transfer for BERT) → destination; submit via `TxSubmitter`.
     - On confirm, single `withTransaction`: UPDATE `vault_withdrawals` (status=`completed`, tx_sig, sol_lamports_out, bert_raw_out, processed_at, nav_per_share_at); UPDATE `vault_shares` (subtract `shares_burned` — fee portion stays in pool, lifting NAV/share); INSERT `vault_nav_snapshots` (source=`withdrawal`); audit-log `withdrawal_completed`.
     - On failure: UPDATE status=`failed` with reason; `vault_shares` UNTOUCHED; audit-log `withdrawal_failed`; user notified.

### Flow D — Whitelist set / change / cancel
- **First set** (whitelist_address IS NULL):
  - `/setwhitelist <addr>` → TOTP → single `withTransaction`: INSERT `vault_pending_whitelist_changes` (old=NULL, activates_at=now, status=`activated`) for audit trail; UPDATE `vault_users.whitelist_address`; audit-log `whitelist_activated`.
- **Subsequent change**:
  - `/setwhitelist <new_addr>` → TOTP → INSERT `vault_pending_whitelist_changes` (old=current, new, activates_at=now+24h, status=`pending`); audit-log `whitelist_requested`. Reply: "Change will activate at YYYY-MM-DD HH:MM UTC. `/cancelwhitelist` to abort."
  - Cooldown job (per-tick): SELECT `status='pending' AND activates_at <= now`; for each: UPDATE `vault_users.whitelist_address`, mark pending row `activated`, audit-log, notify user.
- **Cancel**:
  - `/cancelwhitelist` → TOTP → find most recent `pending` row for user → UPDATE status=`cancelled`, cancel_reason='user'; audit-log.

### Flow E — Founding-depositor bootstrap
One-time CLI: `node dist/cli/index.js vault-bootstrap`.
1. Guard: fails if any `vault_users` row exists.
2. Compute current NAV: `free_sol*solUsd + free_bert*bertUsd + position.totalValueUsd + uncollectedFeesUsd`.
3. Set `initial_nav_per_share = 1.00` → `initial_shares = total_usd`.
4. Single `withTransaction`:
   - INSERT `vault_users` (operator's telegram_id, role=`operator`, deposit keypair generated/encrypted, whitelist NULL, TOTP NULL — enrolled via `/account`).
   - INSERT `vault_shares` (shares=`initial_shares`).
   - INSERT synthetic `vault_deposits` (source=`bootstrap`, inbound_tx_sig=`bootstrap:<ts>`).
   - INSERT `vault_nav_snapshots` (source=`bootstrap`).
   - Audit-log `bootstrap`.
5. Print summary. Vault is live.

## Section 4 — Safety, concurrency & operator controls

### Concurrency
- Single `Mutex` in `main.ts`. Acquired by rebalancer, withdrawal drainer, deposit sweep.
- Serial FIFO withdrawal queue; one withdrawal processed at a time.
- Telegram commands processed via `await` chain — serialized per bot.

### Oracle-failure posture
- `navSnapshot.compute()` returns `null` when < 2 oracle sources agree within `oracleDivergenceBps`.
- On null NAV: deposits don't credit; queued withdrawals don't process. Neither state is "lost"; both retried next tick.

### Degraded / kill-switch
- `state.isDegraded()`: withdrawals pause (queue fills), deposits continue.
- Killswitch file: both deposits and withdrawals pause.
- `/pausevault` (operator): both pause.

### Reserve floors
`reserveSol = minSolFloorLamports + 10*tipLamports` (~0.11 SOL). Withdrawal cannot breach this after partial close. If short: mark `failed` (reason=`reserves_insufficient`).

### Caps & dust (new config fields)
- `vault.minDepositUsd` (default 10) — below this, credit + warn.
- `vault.minWithdrawalUsd` (default 5) — reject at enqueue.
- `vault.maxDailyWithdrawalsPerUser` (default 3).
- `vault.maxDailyWithdrawalUsdPerUser` (default 5000).
- `vault.maxPendingWithdrawals` (default 50) — global queue cap.
- `vault.depositMinConfirms` (default 1).
- `vault.withdrawalFeeBps` (default 30 = 0.3%).
- `vault.whitelistCooldownHours` (default 24).

### TOTP replay protection
`vault_users.totp_last_used_counter`: reject any verification with counter ≤ last used.

### Operator controls (role=`operator` only)
- `/pausevault` / `/resumevault` — toggle `vault_paused` flag.
- `/vaultstatus` — TVL, shares, queued withdrawals, pending whitelist changes, last NAV, any failures.
- `/forceprocess <withdrawal_id>` — retry a failed withdrawal (audited).
- **No** `/forcewithdraw-to-arbitrary-address` in v1. Manual out-of-band transfers + accounting adjustment if truly needed.

### Audit trail
`vault_audit_log` written in the same `withTransaction` as the state change it describes. Audit and reality can't diverge.

### Backup
- Systemd timer `bert-mm-bot-backup.timer` daily at 03:00 UTC: `sqlite3 state.db ".backup /var/backups/bert-mm-bot/state-$(date +%Y%m%d).db"`, 30-day rolling retention.
- **Runbook recovery note:** on-chain deposit/withdrawal history is authoritative. TOTP secrets and deposit keypair secrets are NOT reconstructible — depositors would need to re-enroll if DB is lost without backup. Share balances reconstructible from on-chain events.

### Failure-mode matrix

| Failure | Deposits | Withdrawals | User impact |
|---|---|---|---|
| Oracle divergent | paused (retry) | paused (stay queued) | Delay, no loss |
| `isDegraded()` | continue | paused | Withdrawal delay; operator alerted |
| Kill-switch file | paused | paused | Full freeze |
| `/pausevault` | paused | paused | Full freeze |
| RPC outage > 5 min | paused | paused | Retry when RPC back |
| Sweep tx fails | no credit until retry succeeds | — | Delay only |
| Withdrawal tx fails | — | `failed`, shares preserved | User can retry; operator notified |
| Reserves insufficient after partial close | — | `failed` (reserves_insufficient) | User notified; operator override required |

## Section 5 — Testing & rollout

### Tests

**Unit** (`tests/vault/*.test.ts`):
- `shareMath.test.ts` — 1:1 bootstrap, NAV-scaled deposits, 0.3% fee, dust precision, round-trip (deposit→withdraw same shares at same NAV returns same USD minus fee).
- `totp.test.ts` — secret gen, URI format, valid code accepted, expired code rejected, replay rejected, ±1-step tolerance.
- `encryption.test.ts` — AES-GCM round-trip, wrong-key failure, IV uniqueness over 10k encryptions.
- `cooldowns.test.ts` — first-set immediate; subsequent 24h; cancel during pending; cancel after activation is no-op.
- `depositorStore.test.ts` — transaction atomicity under simulated failure; dup `inbound_tx_sig` rejected; audit rows written in same tx.

**Integration** (`tests/vault/integration.test.ts`):
- In-memory SQLite; mocked RPC/Jupiter/DexScreener.
- Simulated tick loop: deposit → share mint → withdrawal queue → drain → share burn.
- Invariant checks after each step: `Σ shares_minted − Σ shares_burned = Σ vault_shares.shares`; NAV/share monotonically non-decreasing when only withdrawal fees added.
- Oracle-null path: deposit seen, null NAV, nothing written, next tick succeeds.
- Degraded path: withdrawal queued, degraded set, drain exits early, user notified.

**Manual E2E** (documented checklist):
- Devnet: bootstrap, enroll TOTP, `/account`, `/deposit` with 0.1 devnet SOL, see credited shares, `/setwhitelist`, `/withdraw 50%`, confirm funds arrive at whitelist.
- Mainnet $20 canary: repeat E2E with tiny amounts; monitor slippage + timing.

**Non-goals**: fuzz testing, load testing, chaos testing RPC (single-digit depositors expected; existing retry behaviour sufficient).

### Rollout

**Stage 0 — merge & deploy.** Feature behind `vault.enabled=false`. Tests pass. Backup timer live.

**Stage 1 — operator bootstrap (day 0).**
- `vault.enabled=true`. Run `vault-bootstrap` CLI.
- Operator `/account`, enrolls TOTP, sets whitelist to own wallet, tests `/deposit` with ~$5, confirms credit; `/withdraw 100%`, confirms return; redeposit.
- 24h observation.

**Stage 2 — one trusted depositor (day 1–7).**
- Invite one trusted person. Full `/start` → accept → enroll → deposit ≤ $50.
- Week-long soak. Fix any bug surfaced; exercise every sensitive path at least once.

**Stage 3 — open gates (day 7+).**
- Public documentation: bot username, disclaimer link, `/stats` command link.
- Consider raising per-user caps.
- Monitor NAV stability, queue latency, oracle divergences.

### Kill criteria (any halts rollout)
- Share-math invariant violated (sum mismatch in audit check).
- Withdrawal delivers wrong amount.
- Oracle disagreement > 5% of ticks for 1+ hour.
- NAV/share drops > 5% in one tick (blocks new deposits pending review — not auto-refund).

### Observability additions
- New log fields: `vault_event`, `vault_user_id`, `shares_delta`, `nav_per_share`.
- Hourly report extended: "Vault: N depositors, TVL $X, NAV/share $Y (24h Δ Z%), Q queued".
- Operator alerts: TOTP failures > 5/hour (brute-force indicator), withdrawal failed, audit-log write failed, NAV oracle divergent > 10 ticks in a row.
- `/stats` (public, no TOTP): TVL, NAV/share, 24h NAV Δ%. No per-user data, no depositor count.

## Open items / future work (post-v1)

- Performance fee with high-water mark (share-class accounting).
- Public NAV history chart.
- Signed statements / monthly reports per depositor.
- Key rotation procedure for `VAULT_MASTER_KEY`.
- Multi-venue vault (if bot moves beyond Meteora DLMM).
- Eventual migration to on-chain vault program (trustless custody).
