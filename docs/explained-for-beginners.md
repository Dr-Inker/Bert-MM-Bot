# BertMM Vault — Explained for Beginners

A plain-English tour of what this bot is, how it works, and why it's safe (and where it isn't).

> If you already read the code, skim `README.md` instead — this file is for people who have never written a line of code and are not sure what "DLMM" stands for.

---

## 1. What is this thing?

BertMM is a little autonomous program that parks money in a Solana liquidity pool (BERT paired with SOL), tries to earn trading fees from it, and lets you — or anyone you trust — deposit money into the same pool and get a share of the fees.

Think of it as running a tiny currency-exchange booth at an airport, except:

- The "booth" is a piece of software on a server that never sleeps.
- The currencies are **SOL** (Solana's native coin) and **BERT** (a token on Solana).
- Other people can put their SOL or BERT into your booth and get a proportional cut of the fees it earns.
- Nothing leaves the booth without going to a pre-approved wallet address that you set in advance (so even if someone hijacks your phone for a minute, they can't reroute the money to themselves).

The bot is always honest-but-lazy: it only moves money when it absolutely has to (rebalance when the price drifts too far, pay out a withdrawal, collect swept deposits). Everything else, it watches and logs.

---

## 2. Part One: The Market Maker

### What's a market maker?

A market maker is someone who stands ready to both **buy and sell** the same thing at slightly different prices, pocketing the difference (the "spread") as a fee. Real-world example: a currency-exchange booth at an airport buys US dollars from you at $1.00 and sells them to the next person for $1.02 — the 2¢ is their profit.

On a decentralised exchange (DEX) like Meteora, market making is done with a **liquidity pool**: you put in a mix of two tokens (say, SOL and BERT), the pool lets other people swap between those tokens, and every swap pays a small fee that goes to you (proportional to your slice of the pool).

### So this bot does that?

Yes. Specifically, it holds a position in a **Meteora DLMM pool** for the BERT/SOL pair. DLMM is Meteora's version of "concentrated liquidity" — see the next bit.

### Wait, what's "concentrated liquidity"?

In the oldest style of DEX, you put your two tokens in the pool and your money is spread *thinly* across every possible price from $0 to infinity. Most of that price range never gets used, so most of your money is idle.

Concentrated liquidity says: *pick a narrow price range where you think the token will actually trade* (say, BERT/SOL between $0.010 and $0.013). Put all your money in that range. Now you earn fees at ~20× the rate — because instead of your $100 being spread across every price, it's all stacked in the narrow zone where trades actually happen.

The catch: if the price leaves your range, your position is no longer trading and earns zero fees until the price comes back OR you "rebalance" (close the old position and open a new one centred on the current price).

### What does "rebalance" mean in practice?

Four steps:

1. Close the current position → receive whatever SOL + BERT it contains.
2. Look at the live market price.
3. Swap half of what you got so the two sides are roughly balanced.
4. Open a new position centred on the new price, with roughly equal SOL and BERT in it.

The bot does all four automatically whenever the price has been *sustained* outside the current range for 10 minutes (so a one-off price blip doesn't trigger a pointless rebalance). It's capped at a maximum of 6 rebalances per day and has a cooldown of 60 minutes between any two, so it never gets trigger-happy.

### So the bot makes money on fees?

That's the goal. On a token where your team or community is the natural liquidity provider, this beats letting the tokens sit idle. Nobody guarantees it'll always earn more than it costs, though — see the Risks section.

---

## 3. Part Two: The Vault

Running the market maker with just your own money is fine. The vault lets **other people** put their SOL or BERT in too and share the profits (and losses) proportionally.

### Shares, not dollars

When you deposit, the bot doesn't remember "you put in $50 so we owe you $50." It converts your deposit into **shares** at whatever the vault's current price-per-share is.

Think of it like a mutual fund. The vault has a total value (say $1,000) and a total share count (say 1,000 shares) → each share is worth **$1 at that moment**. You deposit $50 → you get 50 shares. Later the vault's total value grows to $1,200 because of fees and price moves → the 1,000 shares are now worth $1.20 each → your 50 shares are worth $60.

This value-per-share is called **NAV per share** (NAV = Net Asset Value). The bot computes it live from:

- SOL sitting in the bot's main wallet × current SOL price in USD
- BERT sitting in the bot's main wallet × current BERT price in USD
- Plus the value of tokens locked inside the open LP position

### What gets deposited, and where?

When you create your vault account, the bot generates a **brand-new Solana address** that belongs only to you. This is *your* deposit address. Whenever you want to put money in, you send SOL or BERT (or both) to that address.

The bot sees the deposit, consolidates it into the main wallet, calculates how much USD that was worth at the moment of arrival, and credits you the equivalent number of shares at the current NAV-per-share.

### What about withdrawals?

Two important rules:

1. You can only withdraw to your **whitelist address**. You set this once (happens instantly the first time). Any later change has a **7-day cooldown** (you request the change today, it activates 7 days from now — you can cancel before then).
2. Every withdrawal requires your **2FA code** (see the security section).

You can withdraw by USD amount (`$50`) or by percentage (`25%`, `100%`). The bot burns the corresponding number of your shares, partial-closes enough of the LP position to cover the payout, sends it to your whitelist address, and logs everything.

**Safety principle:** if the partial-close comes up short (e.g., the market is unusually thin), the bot **refuses** the withdrawal rather than dipping into someone else's share of the pool.

### Fees

- **Trading fees:** Meteora's 0.10% fee on every swap through the pool goes to the liquidity providers (i.e., the vault).
- **Withdrawal fee:** 0.30% of your withdrawn amount. This stays in the vault, benefiting remaining depositors.
- **Gas fees:** small Solana network fees (fractions of a cent) — paid by the bot's main wallet.

---

## 4. Part Three: How You Actually Use It

All interaction happens in Telegram. Open the bot (`@BertMM_bot`) and use the buttons or typed commands.

### First time only: enrol

1. **`/account`** (or tap the Menu button in Telegram's UI and send `/menu`). The bot shows a welcome message.
2. Tap **[🆕 Create account]**. The bot shows the vault disclaimer.
3. Tap **[✅ I accept]**. The bot generates a TOTP secret and displays a QR code.
4. Open Google Authenticator, Authy, 1Password, or any authenticator app you prefer. Scan the QR. You now have a rolling 6-digit code that changes every 30 seconds.
5. Reply to the bot with the current 6-digit code. The bot confirms and shows the main menu.

The QR-code message **self-destructs 5 minutes after it's sent** so your secret doesn't linger in chat history.

### Daily actions

All of these are reachable from `/menu` (or type them directly):

| What | Button / command | Needs 2FA? |
|---|---|---|
| See main menu | `/menu` | No |
| See your balance | `/balance` | Yes |
| Get your deposit address | `/deposit` | Yes |
| Queue a withdrawal | `/withdraw 50%` or tap `[💸 Withdraw]` → pick preset | Yes |
| Set/change whitelist address | `/setwhitelist <address>` or tap `[🎯 Whitelist]` | Yes |
| Cancel pending whitelist change | `/cancelwhitelist` | Yes |
| Vault stats (public) | `/stats` | No |

**2FA shortcut:** after you enter one valid 2FA code, the bot unlocks your account for **5 minutes** — repeat commands during that window don't ask for another code. After 5 minutes, the next command prompts again.

### Making a deposit

1. Tap `[💰 Deposit]` and enter your 2FA code.
2. The bot replies with your personal deposit address (you can tap-to-copy it on mobile).
3. From whatever wallet holds your SOL or BERT (Phantom, Solflare, etc.), send any amount to that address.
4. Within a tick or two (the bot polls every 30 seconds), you'll see your balance update and an audit entry recorded. The SOL/BERT is swept from your deposit address into the main bot wallet.

You can deposit both SOL and BERT in the same transaction or separately; the bot handles either.

### Withdrawing

1. Make sure you've set your whitelist once. Without it, the bot refuses withdrawals (to prevent accidents).
2. Tap `[💸 Withdraw]`, pick a preset (25%/50%/75%/100%) or type a custom USD amount.
3. Confirm with your 2FA code.
4. The bot queues the withdrawal; within a few ticks the partial-close executes and the SOL + BERT arrives at your whitelist address.

---

## 5. Part Four: Safety — Why This Isn't Insane

A lot of thought went into this so you can sleep at night. In rough order of defence:

### Two-factor authentication (TOTP)

Every privileged action (deposit-address reveal, balance check, withdraw, whitelist change) is gated by a fresh 6-digit code generated by your authenticator app. Someone who hijacks your Telegram session momentarily **can't** do anything privileged without also having your authenticator.

### Rate limit

Five failed 2FA attempts within 15 minutes → your account is locked for 15 minutes. Makes brute-forcing the code impractical.

### Whitelist with cooldown

Withdrawals only ever go to your whitelist address. To change it, you request a change → wait **7 days** → it activates (you can cancel any time before then). This means even if an attacker somehow gets past your 2FA, they can't instantly redirect withdrawals to themselves — they'd have to hold access for 7 full days without you noticing.

### Kill switches

The operator (the person running the bot) can pause everything in three ways:

- Set `enabled: false` in the config → bot holds, won't open/close positions.
- Create a file at a known path → same effect.
- `systemctl stop` the whole process.

### Fail-closed invariants

Whenever the bot can't verify something it needs, it **refuses to act** rather than guessing. Examples:
- Price oracles disagree? Hold, don't rebalance.
- RPC (Solana node) timing out? Skip this tick.
- Partial-close came up short of what the withdrawal needs? Refuse the withdrawal.
- Can't verify the master key is present? Disable the vault rather than operate half-broken.

### Audit log

Every material action — each enrolment, each TOTP success or failure, each deposit, each withdrawal, each operator action — is written to a local database with a timestamp. If something looks wrong later, there's a full history to review.

### Encrypted secrets

Per-user keys are encrypted in the database using a master key that lives only on the server (in `/etc/bert-mm-bot/env`). A separate password-manager copy of that master key is kept offline by the operator. Losing the server without the offline copy doesn't compromise user funds — but losing the master key itself is unrecoverable, so it's backed up twice.

### Drawdown breaker

Before every rebalance, the bot simulates closing the position and compares the result to a recent baseline. If the simulated outcome shows a drawdown bigger than `maxDrawdownPct` (default 20%) over a recent window, it refuses to rebalance. This protects against a scenario where the bot keeps rebalancing into a collapsing price.

### Daily caps + inventory cap

- `maxPositionUsd` — no matter how much is deposited, the open position is never larger than this (e.g., $2,200). Excess just sits in the hot wallet until the cap rises.
- `maxRebalancesPerDay` — default 6. Prevents a runaway rebalance loop.
- Per-user daily withdrawal caps: 3 withdrawals per day, capped in USD.

### Server-level

- The server itself is backed up daily by the hosting provider (Hetzner), so a hardware failure or datacentre incident is recoverable.
- A second layer runs locally: `state.db` + config + master key + wallet keyfile are bundled into a tarball every 24 hours and kept for 30 days.

---

## 6. Part Five: What Could Still Go Wrong

Nobody should deposit more than they can afford to lose. Here's the honest list:

### Market risk (the biggest one)

If BERT's price crashes 80%, the vault's value crashes roughly in proportion. Shares don't protect you from BERT going down; they track the vault's value. A position stretches to ±3% price range — outside that, it's 100% in one token (the one that just crashed) until a rebalance or price recovery.

**This isn't a bug.** It's how concentrated liquidity works. If you're not comfortable being long BERT-against-SOL, don't deposit.

### Impermanent loss

Even without BERT crashing, the mechanics of concentrated liquidity mean that if SOL moves a lot relative to BERT, your slice of the pool will have *less* total value than if you'd just held the coins separately. Trading fees are supposed to make up for this; sometimes they do, sometimes they don't.

### Smart-contract risk

Meteora's DLMM program could have a bug that drains pools. Solana's runtime could misbehave. These are outside the bot's control.

### Operator risk

Whoever runs the server holds the master key. If that person is compromised, disappears, or turns rogue, user funds could be at risk. The whitelist + cooldown protect against quick drains but not against patient attackers. Historical audit logs + the 7-day cooldown give you time to yank your funds out if something smells wrong.

### Server loss

If the VPS disk fails AND the Hetzner backup fails AND the local tarball fails AND the offline master-key backup is lost, per-user encrypted deposit keypairs become unrecoverable (the main LP funds are still on-chain though — the operator can recover via emergency tools).

### Network-level

RPC providers (which relay messages to/from Solana) can rate-limit or go down. The bot pauses gracefully, but if the outage is long, trades and rebalances can't happen.

---

## 7. Part Six: Glossary

Terms in alphabetical order:

**API key** — a password-like string used to authenticate with a service (e.g., Helius).

**ATA (Associated Token Account)** — on Solana, a token like BERT doesn't live directly in a wallet; it lives in an ATA *owned by* that wallet. One ATA per (wallet, token) pair. Creating an ATA costs ~0.002 SOL in rent.

**Audit log** — append-only record of actions for traceability.

**BERT** — the SPL token this pool is paired against. Mint: `HgBRWfYxEfvPhtqkaeymCQtHCrKE46qQ43pKe8HCpump`.

**Bin / bin-step** — in Meteora DLMM, price is discretised into "bins". Each bin represents a narrow price interval. `bin_step=10` means each bin covers a 0.10% price step.

**Bin-array rent** — Solana charges a rent-exempt amount for each account on-chain. The DLMM program stores bin arrays in accounts, so a fresh position costs ~0.74 SOL in rent (refunded when closed).

**Bot / service** — the running process that polls the chain, makes decisions, and submits transactions.

**Callback_query** — when you tap a button in Telegram, the bot receives a "callback_query" event. This is how inline keyboards work under the hood.

**CLI** — command-line interface. The operator has tools like `emergency-exit`, `force-rebalance` for manual intervention.

**Cooldown** — waiting period before a change takes effect. Used on whitelist changes to prevent fast-acting attackers.

**Drawdown** — peak-to-trough drop in value.

**Depositor vs operator** — depositor = anyone who puts money in. Operator = the one person running the server with full control.

**DLMM** — Dynamic Liquidity Market Maker, Meteora's concentrated-liquidity design.

**Fail-closed** — design principle: when in doubt, don't act. The opposite of fail-open.

**Hot wallet** — the bot's main Solana wallet that signs every transaction. Private key lives in `/etc/bert-mm-bot/hot-wallet.json`.

**Impermanent loss** — the difference between holding tokens in a liquidity pool vs just holding them directly in a wallet, due to price changes during the deposit.

**Jito** — a Solana MEV-protection service. The bot optionally routes swaps through Jito bundles to avoid sandwiching.

**Kill switch** — any one of several ways to stop the bot from acting. Can be flipped remotely (config file) or with physical server access.

**Liquidity pool** — a smart-contract-managed reserve of two tokens that traders swap against. Pool fees compensate liquidity providers (depositors).

**LP (Liquidity Provider)** — someone with funds in the pool. The bot is an LP.

**Master key** — 32-byte random value (stored as base64) used to encrypt depositor keypairs at rest. Must be backed up offline. Loss = loss of vault.

**Meteora** — the DEX this bot uses. Their DLMM design is what "concentrated liquidity" refers to in this project.

**Mid price** — the "fair" current price, used to decide whether to rebalance. Pulled from 2+ independent sources and checked for agreement.

**NAV (Net Asset Value)** — total USD value of the vault's assets. NAV per share = NAV ÷ total shares outstanding.

**NAV snapshot** — a row in the database recording `(timestamp, total USD, total shares, NAV per share)`. Stored on every material event + every tick.

**Operator** — the human running the bot server. Holds the master key, the hot wallet keyfile, and admin-level Telegram permissions.

**Oracle** — a price source. The bot uses Jupiter + DexScreener and requires at least two to agree within 1.5% before acting.

**Position** — an open allocation in the pool, represented on-chain as a keypair-owned account with state.

**Range / range width** — the span of prices in which a concentrated-liquidity position earns fees. This bot targets ~6% total width centred on mid price.

**Rebalance** — close → rebalance tokens → reopen. Described in §2.

**Rent** — Solana's term for the minimum balance an on-chain account must hold to exist. Rent-exempt = balance above this threshold; refunded when account closes.

**RPC (Remote Procedure Call)** — how the bot talks to Solana. Uses Helius primarily with a public fallback.

**Share** — unit of ownership in the vault. Total shares × NAV per share = total vault value.

**SOL** — Solana's native token. Used for gas fees and as one side of the BERT/SOL pair.

**SPL token** — any token on Solana other than SOL itself. BERT is an SPL token.

**SQLite** — the simple file-based database holding all vault state.

**Sweep** — move funds from a depositor's per-user address into the main bot wallet, where they're available to the LP.

**TOTP (Time-based One-Time Password)** — the 6-digit rolling code from Google Authenticator / Authy / etc. Standard 2FA mechanism.

**TVL (Total Value Locked)** — total USD value currently in the vault.

**Venue** — shorthand for which DEX the bot is trading on. This bot is on Meteora.

**Whitelist** — the one wallet address a depositor is allowed to withdraw to. Set once instantly, later changes have a 7-day cooldown.

---

## 8. Part Seven: "Just tell me what to do"

The minimum-viable path for a new depositor:

1. Message `@BertMM_bot` on Telegram.
2. Send `/menu` → tap `[🆕 Create account]` → tap `[✅ I accept]` → scan QR in your authenticator → reply with the 6-digit code.
3. Tap `[🎯 Whitelist]` → paste the Solana address you want withdrawals to go to → confirm with 2FA. (First-time set is instant.)
4. Tap `[💰 Deposit]` → confirm with 2FA → the bot shows your deposit address → send SOL and/or BERT to it from your usual wallet.
5. Wait a minute. Tap `[📊 Balance]` to see the shares you've been credited.
6. Whenever you want out, tap `[💸 Withdraw]` → pick a preset → confirm with 2FA. Funds arrive at your whitelist address within a few ticks.

Everything else is convenience.
