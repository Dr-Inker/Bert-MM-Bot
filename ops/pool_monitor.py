#!/usr/bin/env python3
"""
BERT pool monitor.

Polls DexScreener for all Solana pools trading the BERT mint. Alerts to
Telegram when:
  - the pool count changes (new pool appeared, or an old one disappeared)
  - a pool with liquidity above NEW_POOL_MIN_LIQ_USD appears that wasn't
    present last run

Runs as a systemd oneshot every ~30min via bert-pool-monitor.timer.

Only depends on the stdlib + PyYAML (already available via the bertmm
user's system python since the bot runs Node, not Python, so no venv
conflict).

State is persisted as JSON at STATE_PATH. If the file is missing or
corrupt, the first run treats the current pool set as the baseline.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import urllib.request
import urllib.error
from pathlib import Path
from typing import Any

import yaml

BERT_MINT = "HgBRWfYxEfvPhtqkaeymCQtHCrKE46qQ43pKe8HCpump"
DEXSCREENER_URL = f"https://api.dexscreener.com/tokens/v1/solana/{BERT_MINT}"
CONFIG_PATH = "/etc/bert-mm-bot/config.yaml"
STATE_PATH = "/var/lib/bert-mm-bot/pool-monitor-state.json"
NEW_POOL_MIN_LIQ_USD = 5_000  # ignore dust pools

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s pool_monitor %(message)s",
)
log = logging.getLogger("pool_monitor")


def load_telegram_creds() -> tuple[str, str] | None:
    try:
        with open(CONFIG_PATH) as f:
            cfg = yaml.safe_load(f) or {}
    except (FileNotFoundError, PermissionError) as e:
        log.warning("cannot read config: %s", e)
        return None
    tg = ((cfg.get("notifier") or {}).get("telegram")) or cfg.get("telegram")
    if not tg:
        return None
    token = tg.get("botToken")
    chat = tg.get("chatIdInfo") or tg.get("chatIdCritical")
    if not token or not chat:
        return None
    return token, str(chat)


def fetch_pools() -> list[dict[str, Any]]:
    req = urllib.request.Request(
        DEXSCREENER_URL,
        headers={"User-Agent": "bert-pool-monitor/1.0"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode())
    # DexScreener returns either a list of pairs or {"pairs": [...]} depending
    # on endpoint — this one returns a bare list.
    if isinstance(data, dict):
        data = data.get("pairs") or []
    summary = []
    for p in data:
        liq = (p.get("liquidity") or {}).get("usd") or 0
        summary.append(
            {
                "dex": p.get("dexId"),
                "pairAddress": p.get("pairAddress"),
                "quote": (p.get("quoteToken") or {}).get("symbol"),
                "priceUsd": p.get("priceUsd"),
                "liquidityUsd": float(liq) if liq else 0.0,
                "volume24h": float(((p.get("volume") or {}).get("h24")) or 0),
            }
        )
    return summary


def load_state() -> dict[str, Any]:
    try:
        return json.loads(Path(STATE_PATH).read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_state(state: dict[str, Any]) -> None:
    Path(STATE_PATH).parent.mkdir(parents=True, exist_ok=True)
    Path(STATE_PATH).write_text(json.dumps(state, indent=2))


def send_telegram(token: str, chat: str, text: str) -> bool:
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    body = json.dumps(
        {"chat_id": chat, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True}
    ).encode()
    req = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status == 200
    except urllib.error.URLError as e:
        log.warning("telegram send failed: %s", e)
        return False


def fmt_pool(p: dict[str, Any]) -> str:
    liq = p["liquidityUsd"]
    vol = p["volume24h"]
    return (
        f"• <b>{p['dex']}</b> Bert/{p['quote']} — "
        f"price=${p['priceUsd']}, liq=${liq:,.0f}, vol24h=${vol:,.0f} "
        f"(<code>{(p['pairAddress'] or '')[:8]}…</code>)"
    )


def main() -> int:
    try:
        pools = fetch_pools()
    except Exception as e:
        log.error("DexScreener fetch failed: %s", e)
        return 1

    state = load_state()
    prev_addrs = set(state.get("pool_addresses") or [])
    current_addrs = {p["pairAddress"] for p in pools if p["pairAddress"]}

    new_addrs = current_addrs - prev_addrs
    gone_addrs = prev_addrs - current_addrs

    # First run: seed state silently unless there are multiple pools already.
    if not state:
        save_state({"pool_addresses": sorted(current_addrs), "last_pools": pools})
        log.info("seeded baseline with %d pool(s)", len(pools))
        if len(pools) > 1:
            creds = load_telegram_creds()
            if creds:
                msg = (
                    f"🟡 <b>BERT pool monitor initialised</b>\n"
                    f"Found {len(pools)} pools at first run (expected 1):\n"
                    + "\n".join(fmt_pool(p) for p in pools)
                )
                send_telegram(*creds, msg)
        return 0

    if not new_addrs and not gone_addrs:
        log.info("no change: %d pool(s) tracked", len(current_addrs))
        save_state({"pool_addresses": sorted(current_addrs), "last_pools": pools})
        return 0

    creds = load_telegram_creds()
    msg_parts = ["🔔 <b>BERT pool change detected</b>"]

    if new_addrs:
        new_pools = [p for p in pools if p["pairAddress"] in new_addrs]
        notable = [p for p in new_pools if p["liquidityUsd"] >= NEW_POOL_MIN_LIQ_USD]
        if notable:
            msg_parts.append(f"\n<b>New pool(s)</b> (liq ≥ ${NEW_POOL_MIN_LIQ_USD:,}):")
            for p in notable:
                msg_parts.append(fmt_pool(p))
        dust = [p for p in new_pools if p["liquidityUsd"] < NEW_POOL_MIN_LIQ_USD]
        if dust:
            msg_parts.append(f"\n<i>{len(dust)} dust pool(s) below threshold — ignored</i>")

    if gone_addrs:
        prev_pools = state.get("last_pools") or []
        gone = [p for p in prev_pools if p.get("pairAddress") in gone_addrs]
        if gone:
            msg_parts.append("\n<b>Pool(s) gone</b>:")
            for p in gone:
                msg_parts.append(fmt_pool(p))

    if len(current_addrs) > 1:
        msg_parts.append(
            f"\n⚠️ BERT now trades on <b>{len(current_addrs)}</b> pools — "
            f"arb/market-making opportunity may exist."
        )

    msg = "\n".join(msg_parts)
    log.info("change detected: +%d new, -%d gone", len(new_addrs), len(gone_addrs))

    if creds:
        send_telegram(*creds, msg)
    else:
        log.warning("no telegram creds — printing alert to stdout instead")
        print(msg)

    save_state({"pool_addresses": sorted(current_addrs), "last_pools": pools})
    return 0


if __name__ == "__main__":
    sys.exit(main())
