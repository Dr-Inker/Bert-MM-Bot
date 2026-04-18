# Backup

## What's backed up

The systemd unit `bert-mm-bot-backup.service` runs nightly at **03:00 UTC** via `bert-mm-bot-backup.timer`. The script `scripts/backup-state.sh` produces:

`/var/backups/bert-mm-bot/bertmmbot-YYYYMMDD-HHMMSS.tar.gz` (mode 600, owner `bertmm:bertmm`)

Each tarball contains four files:

| Path | Why it matters |
|---|---|
| `state.db` | All vault state: user rows, shares, NAV snapshots, audit log, pending withdrawals, encrypted per-user deposit keypairs. |
| `config.yaml` | RPC keys, pool address, Telegram bot token, vault parameters (caps, cooldowns, operator telegram id). |
| `env` | `VAULT_MASTER_KEY`. Without this, the encrypted per-user keypairs in `state.db` can't be decrypted — depositor funds are unrecoverable. |
| `hot-wallet.json` | The bot's main keypair. Signs all on-chain transactions. Direct control over every pool position and vault-held SOL/BERT. |

Losing `env` alone = losing vault custody (existing depositor funds cannot be routed back to them).
Losing `hot-wallet.json` alone = losing the live LP position.
Losing `state.db` alone = losing share accounting + audit trail (funds recoverable on-chain but share allocations lost).
All three together = total vault loss.

**Rotation:** 30 rolling days kept locally. Older bundles auto-deleted by the script.

## What's NOT yet backed up

1. **Off-site copies.** Every tarball lives on the same VPS. If the disk dies, a datacenter fire happens, or the provider account is compromised, every copy is gone together. Resolution paths:
   - rclone to S3 / Backblaze B2 / Google Drive (needs cloud credentials)
   - SSH-based rsync to a second server (needs destination host + key)
   - Pushed encrypted blobs to a dedicated private GitHub repo (needs PAT + encryption passphrase)

2. **At-rest encryption.** The tarballs are plaintext. Anyone with root on the VPS (including a future attacker) can read `env` + `hot-wallet.json` out of a backup as easily as reading the live file. Resolution: encrypt each tarball with a passphrase or GPG recipient-key before it lands on disk. Passphrase/private key must live off-server (e.g., in the operator's password manager) so a server compromise can't undo the protection.

3. **Source code.** Lives on GitHub (`Dr-Inker/Bert-MM-Bot`), so no special backup needed beyond ensuring the repo is kept private and the PAT hasn't leaked.

## To run a backup on demand

```bash
sudo systemctl start bert-mm-bot-backup.service
sudo ls -la /var/backups/bert-mm-bot/
```

## To restore from a backup

Assuming the VPS is freshly reinstalled, paths recreated, and the repo cloned:

```bash
# 1. Stop the service if it's running
sudo systemctl stop bert-mm-bot || true

# 2. Extract backup to a working dir
mkdir -p /tmp/restore && cd /tmp/restore
sudo tar xzf /path/to/bertmmbot-YYYYMMDD-HHMMSS.tar.gz

# 3. Put each file back
sudo install -m 640 -o root -g bertmm env /etc/bert-mm-bot/env
sudo install -m 600 -o bertmm -g bertmm hot-wallet.json /etc/bert-mm-bot/hot-wallet.json
sudo install -m 640 -o root -g bertmm config.yaml /etc/bert-mm-bot/config.yaml
sudo install -m 644 -o bertmm -g bertmm state.db /var/lib/bert-mm-bot/state.db

# 4. Start back up
sudo systemctl start bert-mm-bot
sudo journalctl -u bert-mm-bot -f
```

## Audit / integrity check

SQLite's `.backup` command (used by the script) produces a consistent snapshot even with the live service writing. The bundle is reproducible:

```bash
sudo tar tzf /var/backups/bert-mm-bot/bertmmbot-*.tar.gz
```

Should always list exactly:
- `./hot-wallet.json`
- `./state.db`
- `./config.yaml`
- `./env`
