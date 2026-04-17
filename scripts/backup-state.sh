#!/bin/bash
set -euo pipefail
BACKUP_DIR=/var/backups/bert-mm-bot
mkdir -p "$BACKUP_DIR"
STAMP=$(date -u +%Y%m%d)
sqlite3 /var/lib/bert-mm-bot/state.db ".backup $BACKUP_DIR/state-$STAMP.db"
# Retain 30 rolling days
find "$BACKUP_DIR" -name 'state-*.db' -mtime +30 -delete
