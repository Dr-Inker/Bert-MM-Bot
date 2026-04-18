#!/bin/bash
# Full bot backup: state.db + config + env (master key) + hot-wallet.json.
# Runs from the bert-mm-bot-backup.service systemd unit as user `bertmm`.
# Output: /var/backups/bert-mm-bot/bertmmbot-YYYYMMDD-HHMMSS.tar.gz (mode 600).
# Rotation: 30 rolling days.
#
# NOTE: backups are LOCAL-ONLY and UNENCRYPTED. If the VPS is lost or
# compromised, these go with it. Off-site push + at-rest encryption are
# the next steps (see docs/backup-offsite.md once set up).

set -euo pipefail

BACKUP_DIR=/var/backups/bert-mm-bot
SRC_STATE=/var/lib/bert-mm-bot/state.db
SRC_CONFIG=/etc/bert-mm-bot/config.yaml
SRC_ENV=/etc/bert-mm-bot/env
SRC_WALLET=/etc/bert-mm-bot/hot-wallet.json

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

STAMP=$(date -u +%Y%m%d-%H%M%S)
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# 1. SQLite live-safe snapshot (sqlite's .backup is consistent even while
#    the main service is writing).
sqlite3 "$SRC_STATE" ".backup $TMPDIR/state.db"

# 2. Copy secret + config files. bertmm has read access: env is 640
#    root:bertmm, hot-wallet.json is 600 bertmm:bertmm, config is 640
#    root:bertmm. Tighten mode on copies (tar preserves it).
cp "$SRC_CONFIG" "$TMPDIR/config.yaml"
[ -r "$SRC_ENV" ] && cp "$SRC_ENV" "$TMPDIR/env" || true
cp "$SRC_WALLET" "$TMPDIR/hot-wallet.json"
chmod 600 "$TMPDIR"/*

# 3. Bundle. Owner-only readable.
OUT="$BACKUP_DIR/bertmmbot-$STAMP.tar.gz"
tar czf "$OUT" -C "$TMPDIR" .
chmod 600 "$OUT"

# 4. Rotate. Keep 30 days of daily bundles.
find "$BACKUP_DIR" -name 'bertmmbot-*.tar.gz' -mtime +30 -delete
# Legacy cleanup: old state-*.db files from the previous script.
find "$BACKUP_DIR" -name 'state-*.db' -mtime +30 -delete

echo "backup: $OUT ($(stat -c '%s' "$OUT") bytes)"
