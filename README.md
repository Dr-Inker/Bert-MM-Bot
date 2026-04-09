# bert-mm-bot

Autonomous Raydium CLMM position manager for BERT/SOL.
See `docs/superpowers/specs/2026-04-09-bert-mm-bot-design.md` for full design.

## Quick start

1. Install: `pnpm install && pnpm build`
2. Create hot wallet: `solana-keygen new -o /etc/bert-mm-bot/hot-wallet.json`
   `chown bertmm:bertmm /etc/bert-mm-bot/hot-wallet.json && chmod 600 /etc/bert-mm-bot/hot-wallet.json`
3. Fund from treasury multi-sig (~$1000 BERT + ~$1000 SOL).
4. Copy `config.example.yaml` → `/etc/bert-mm-bot/config.yaml`, fill in RPC and webhook URLs.
5. Install systemd unit: `cp systemd/bert-mm-bot.service /etc/systemd/system/`
6. `systemctl daemon-reload && systemctl enable --now bert-mm-bot`
7. Watch logs: `journalctl -u bert-mm-bot -f`

## Operator commands

```bash
bert-mm status              # show current state
bert-mm pause               # soft pause (edits config.enabled)
bert-mm resume              # unpause
bert-mm collect-fees        # collect fees without rebalancing
bert-mm emergency-exit      # close position to cash (interactive)
bert-mm rebalance --force   # rebalance now, bypass cooldowns only
bert-mm report --days 7     # print N-day report
bert-mm clear-degraded      # clear safety flag after a trip
bert-mm reconcile           # re-run startup reconciliation
```

## Kill-switches (all three work)

1. Soft: edit `/etc/bert-mm-bot/config.yaml`, set `enabled: false`.
2. Emergency: `touch /var/lib/bert-mm-bot/KILLSWITCH`.
3. Hard: `systemctl stop bert-mm-bot`.

## Key compromise response

Run immediately from any host with the keyfile:

```bash
RPC_URL=<rpc> KEYFILE=/etc/bert-mm-bot/hot-wallet.json \
  tsx scripts/rescue-tx.ts <SAFE_TREASURY_ADDRESS>
```

Then rotate keys, redeploy, refund.

## Tuning

Primary health metric: **time in range** (daily report).
- \> 90%: range well-sized or slightly wide
- 70-90%: healthy
- < 70%: range too tight; widen `rangeWidthPct` by 5 and restart
- ~100% for a week: may be too wide; consider tightening by 5

## Capital changes

Always: stop → transfer → restart. Never mid-flight.

1. Update `maxPositionUsd` in config.
2. `bert-mm emergency-exit`
3. `systemctl stop bert-mm-bot`
4. Treasury multi-sig signs transfer to hot wallet.
5. `systemctl start bert-mm-bot`
