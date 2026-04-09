#!/usr/bin/env bash
set -euo pipefail

HEARTBEAT=/var/lib/bert-mm-bot/heartbeat.txt
MAX_AGE_SEC=120

if [[ ! -f "$HEARTBEAT" ]]; then
    echo "CRITICAL: heartbeat missing"
    exit 2
fi

last=$(cat "$HEARTBEAT")
now_ms=$(($(date +%s) * 1000))
age_sec=$(( (now_ms - last) / 1000 ))

if (( age_sec > MAX_AGE_SEC )); then
    echo "CRITICAL: heartbeat stale (${age_sec}s old)"
    exit 2
fi
echo "OK: heartbeat ${age_sec}s old"
