# Depositor-vault v1 — deployment runbook

**Status:** Draft pending final review. Do not run without reading the entire document.

This bot now holds OTHER PEOPLE'S MONEY. A mistake in this runbook can lock up deposits or, worse, silently lose them. Run each step on a known-quiet hour, with the bot stopped and the DB backed up.

---

## 0. Pre-flight checks

Before touching anything:

- [ ] `systemctl status bert-mm-bot` — confirm current state (stopped or running).
- [ ] `git -C /opt/bert-mm-bot status` — working tree clean on `main`.
- [ ] `cat /var/lib/bert-mm-bot/state.db | sqlite3 -batch -readonly - "SELECT COUNT(*) FROM positions"` — note the pre-deploy snapshot (should be 0 or 1).
- [ ] Copy the current DB: `cp /var/lib/bert-mm-bot/state.db /var/lib/bert-mm-bot/state.db.pre-vault-$(date +%Y%m%d-%H%M)`.
- [ ] Confirm wallet balance: `solana balance 2yHJzBWF2RXAB4PfTadM6xqiK1h83V7yKnEz89GdLqkQ --url https://api.mainnet-beta.solana.com` — minimum 2.0 SOL recommended for a safe launch.
- [ ] Confirm operator Telegram `user_id` (not chat_id if different). On Telegram, message `@userinfobot` to find it. The existing config has `chatIdInfo: "7137489161"` — confirm that's your `user_id`.

## 1. Stop the bot

```bash
sudo systemctl stop bert-mm-bot
```

Wait 30 seconds for the tick loop to finish gracefully. `journalctl -u bert-mm-bot -n 20` should show exit log.

## 2. Generate and install the master key

The vault encrypts every user's deposit-address private key with AES-256-GCM under a single 32-byte master key. If you lose this key, every depositor's key is unrecoverable (and their encrypted deposit keys are useless). Back it up offline (password manager + printed in a safe).

```bash
# Generate the key. Save it to your password manager BEFORE running the next step.
openssl rand -base64 32
```

Create the systemd env file:

```bash
sudo install -o root -g bertmm -m 640 /dev/null /etc/bert-mm-bot/env
sudo tee /etc/bert-mm-bot/env <<EOF
VAULT_MASTER_KEY=<paste_base64_key_here>
EOF
sudo chmod 640 /etc/bert-mm-bot/env
sudo chown root:bertmm /etc/bert-mm-bot/env
```

Verify:

```bash
ls -l /etc/bert-mm-bot/env
# Expected: -rw-r----- 1 root bertmm
```

## 3. Merge and build

```bash
cd /opt/bert-mm-bot
git fetch
git checkout main
git merge --ff-only feature/vault-v1        # or a PR merge commit
pnpm install
pnpm build
```

Check build output:

```bash
ls -la dist/main.js dist/cli/index.js dist/cli/vault-bootstrap.js
```

## 4. Update the config

Edit `/etc/bert-mm-bot/config.yaml`. Append the vault block at the bottom:

```yaml
vault:
  enabled: true
  withdrawalFeeBps: 30              # 0.30% fee, stays in pool
  minDepositUsd: 10
  minWithdrawalUsd: 5
  maxDailyWithdrawalsPerUser: 3
  maxDailyWithdrawalUsdPerUser: 5000
  maxPendingWithdrawals: 50
  depositMinConfirms: 1
  whitelistCooldownHours: 24
  operatorTelegramId: 7137489161    # REPLACE with your Telegram user_id (NOT chat id — see below)
```

**`operatorTelegramId` is a user_id, not a chat_id.** Per N3 fix, the bot matches `msg.from.id` for operator commands. In a private DM these are identical; in a group chat they differ. To find your user_id, DM `@userinfobot`. The existing `cfg.notifier.telegram.chatIdInfo` in your config may be a chat_id (same in DM, different in groups); `operatorTelegramId` is always the user_id. If you mis-configure this and the bot can't find a matching operator, every operator command (`/pausevault`, `/vaultstatus`, …) silently rejects. **If vault is enabled and this field is missing, the bot refuses to start.**

Start cautiously: **leave `enabled: false` on the first boot** after merging. This lets the bot start with new code but no vault logic yet — you can confirm the existing MM behaviour is unaffected before flipping the vault on.

## 5. First boot — new code, vault disabled

```bash
sudo systemctl start bert-mm-bot
```

Watch:

```bash
sudo journalctl -u bert-mm-bot -f
```

Within one tick (~30 s) you should see a position-reconcile line or "holding pattern" log. Confirm with `/status` on Telegram. Spend 15 minutes watching that the MM strategy behaves normally.

If anything looks wrong, `sudo systemctl stop bert-mm-bot`, revert to the pre-merge commit, and investigate.

## 6. Bootstrap the vault

Stop the bot first:

```bash
sudo systemctl stop bert-mm-bot
```

Run the bootstrap CLI. `--initial-nav-usd` should be the USD value of the bot's current holdings (free wallet + position value). For a fresh $200 canary pool, use `--initial-nav-usd 200`. The bootstrap:
- Creates a new `operator` user in `vault_users` with a random deposit-address keypair.
- Grants the operator `initialNavUsd` shares (1 share = $1 at launch).
- Writes a `bootstrap` NAV snapshot.
- Creates the BERT ATA for the operator's deposit address.

```bash
cd /opt/bert-mm-bot
sudo -u bertmm bash -c 'source /etc/bert-mm-bot/env && node dist/cli/index.js vault-bootstrap --initial-nav-usd 200'
```

Expected output ends with the operator's deposit address (base58 pubkey). Don't lose it — it's also in `vault_users`.

## 7. Enable the vault and restart

Edit `/etc/bert-mm-bot/config.yaml`, set `vault.enabled: true`.

```bash
sudo systemctl restart bert-mm-bot
```

Watch the logs. First-tick should include "vault enabled, N users" or similar.

## 8. Enroll operator TOTP

From your Telegram client (the operator account):

1. `/account` — bot replies with disclaimer text.
2. `/accept` — bot replies with a Base32 TOTP secret (and, if QR is wired, a QR image).
3. Scan the secret in Google Authenticator / Authy.
4. Send the 6-digit code as a plain text message.
5. Bot replies "2FA confirmed. /deposit /balance /withdraw /setwhitelist /stats".

Audit log should show `disclaimer_accepted` and `totp_enrolled` events. Operator commands `/vaultstatus`, `/pausevault`, `/resumevault` should all work.

## 9. Install the backup timer

```bash
sudo cp /opt/bert-mm-bot/systemd/bert-mm-bot-backup.service /etc/systemd/system/
sudo cp /opt/bert-mm-bot/systemd/bert-mm-bot-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bert-mm-bot-backup.timer
sudo systemctl list-timers bert-mm-bot-backup.timer
```

Daily 03:00 UTC backup of `state.db` to `/var/backups/bert-mm-bot/state-YYYYMMDD.db`, 30 rolling days.

## 10. Smoke-test with a small depositor

Invite a single trusted tester. They should:
1. Send `/account` → `/accept` → enroll TOTP.
2. `/deposit` (with code) → get their unique deposit address.
3. Send 0.01 SOL to that address.
4. Within 1–2 ticks (~60 s) the sweep + credit should land. `/balance` (with code) shows shares.
5. `/setwhitelist <their_own_address>` — immediate for first-set (still TOTP-gated).
6. `/withdraw 1` (i.e. $1 worth). Queued, processed on next drain.

If any step fails, `/pausevault` from operator immediately, inspect logs, debug.

## 11. Announce

When the smoke test is clean, announce on your channels:
- Deposit address reveal flow (users must `/account` first).
- Withdrawal flow (TOTP, 24h whitelist cooldown except first-set).
- 0.30% withdrawal fee.
- Daily caps (3 withdrawals / $5000 per user).

---

## Emergency controls

- **Pause withdrawals:** operator sends `/pausevault`. Drain loop skips; deposits still credit.
- **Resume:** `/resumevault`.
- **Kill bot entirely:** `sudo systemctl stop bert-mm-bot` or `touch /var/lib/bert-mm-bot/KILLSWITCH`.
- **Force-retry failed withdrawal:** `/forceprocess <id>` with the id from `/vaultstatus`. *Refuses* if the row has a populated `tx_sig` — that means funds are already on-chain (see N1/`withdrawal_db_sync_failed`).
- **Re-credit a swept-but-uncredited deposit:** `/recreditdeposit <inboundTxSig>`. Use only when you observe a `deposit_swept` audit event with no subsequent `deposit_credited` for the same inbound sig. Idempotent — safe to run; errors "already credited" if the row exists.
- **Reset a user's lost authenticator:** `/resettotp <telegramUserId>`. Clears their TOTP so they must re-run `/account`. Audit event `totp_reset` attributed to the operator.
- **Lost master key:** catastrophic. No recovery. Every user's deposit keypair becomes unsweepable. BACK THE KEY UP OFFLINE before deploying.

## Observability

- Hourly Telegram report includes: TVL, NAV/share (24h Δ), depositor count, queued withdrawal count.
- Audit log tail: `sudo sqlite3 /var/lib/bert-mm-bot/state.db "SELECT datetime(ts/1000, 'unixepoch'), event, telegram_id, details_json FROM vault_audit_log ORDER BY ts DESC LIMIT 20"`.
- Live journal: `journalctl -u bert-mm-bot -f | grep -iE 'vault|deposit|withdrawal'`.
- **Alerts to watch for:**
  - `totp_rate_limited` — brute-force attempt.
  - `deposit_deferred_oracle_unavailable` — oracle flaky; funds safe (in deposit address, NOT swept yet); retries automatically when oracle recovers.
  - `deposit_sweep_failed` — sweep submit failed for non-oracle reason (RPC, build error). Check logs.
  - `withdrawal_db_sync_failed` — **critical.** On-chain transfer landed but DB write failed. Funds are out; shares still intact. Manual reconciliation required. The row stays in `'processing'` status with `tx_sig` populated. Verify on-chain that the tx confirmed, then directly update the DB (or implement `/reconcilewithdrawal` as v1.1 follow-up).
  - `withdrawal_failed` with reason `reserves_insufficient` — pool needs more liquidity freed; check `/vaultstatus` queued count.

## Periodic invariant check (recommended)

Add to your regular ops routine (cron or weekly manual):

```sql
-- Should be close to zero (rounding only)
SELECT
  (SELECT IFNULL(SUM(shares_minted), 0) FROM vault_deposits) +
  (SELECT initial_nav_usd FROM vault_audit_log
   WHERE event = 'bootstrap' ORDER BY ts ASC LIMIT 1) -
  (SELECT IFNULL(SUM(shares_burned), 0) FROM vault_withdrawals WHERE status = 'completed') -
  (SELECT total_shares FROM vault_nav_snapshots ORDER BY ts DESC LIMIT 1) AS share_delta;
```

More importantly, out-of-band: compare `main_wallet_sol + main_wallet_bert_usd + position_value_usd` against `total_shares * nav_per_share` from the latest snapshot. Divergence > 1% suggests an accounting issue (N18 follow-up) — investigate.

## Daily-driving the vault

- Drain runs every tick (30 s) — users typically see withdrawals land within 1–2 minutes.
- Deposits: first-time users pay ATA rent (~0.002 SOL) out of their inbound SOL; the sweep accounts for this.
- NAV drift: the `withdrawalFeeBps` fee accretes to remaining holders. Bot fees (Meteora LP fees) do too, via the rebalancer's fee-compound logic.
- Keep wallet ≥ 1.0 SOL at all times: deposit-address rent, withdrawal SOL payouts, Meteora bin array rent all come from it.
- **Preflight** on every startup: bot creates the main wallet's BERT ATA if missing (N9). If this fails, the bot refuses to start with vault enabled — inspect the error and fund/create the ATA manually before retrying.

## Known v1.1 follow-up items

These are tracked gaps that do NOT block the v1 deploy but should be addressed in the next iteration, especially before accepting depositors beyond a trusted cohort:

- **N4**: `totpEnrolledAt=0` sentinel should become a proper `totp_status` enum column.
- **N7**: daily USD cap uses stale NAV for queued rows — align with fresh NAV at drain.
- **N8**: cooldown `cancelPending` only cancels the latest; auto-cancel prior pending on new request.
- **N10**: destination ATA rent (~0.002 SOL per first-time withdrawal) is paid from the pool — either deduct from user payout or document.
- **N11**: reject off-curve destinations in `/setwhitelist` (or require operator approval).
- **N12**: persist rate-limiter state across bot restarts.
- **N13**: `/reconcilewithdrawal <id>` — verify on-chain tx_sig before allowing requeue of `withdrawal_db_sync_failed` rows.
- **N14**: zero `secretBuf` after encrypt/decrypt in `enrollment.ts` and `commands.ts` (defense-in-depth).
- **N15**: Telegram session-hijack mitigation — warn in disclaimer; optional operator approval for large withdrawals.
- **N18**: periodic on-chain ↔ share-accounting invariant check with alert.
- **N19**: add `locked_users`, `failed_withdrawals_24h`, `sweep_failures_24h` to hourly report.
- **N21**: Telegram alert on `totp_rate_limited` and `deposit_sweep_failed` events.
- **N22**: `/forceprocess` dry-run option showing what would happen.

Track in your issue system before shipping wider.
