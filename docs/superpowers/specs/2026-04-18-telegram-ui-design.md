# Telegram Depositor UI — Design Spec

**Date:** 2026-04-18
**Branch:** `feature/telegram-ui` (based on `feature/vault-v1`)
**Scope:** Depositor-facing Telegram UX upgrade — inline keyboards instead of raw typed commands.

---

## 1. Goals

- Replace the "remember this command and its argument syntax" friction for depositors with button-driven flows.
- Keep every current behavior: TOTP-gated privileged actions, rate limiting, audit log, cooldowns, whitelist rules.
- Additive only — typed commands continue to work. Buttons are a front-end; no parallel security logic.
- Ship on a dedicated branch so `feature/vault-v1` stays deploy-ready in its current state if needed.

## 2. Non-goals

- Operator commands (`/pause`, `/resume`, `/status`, `/pausevault`, `/resumevault`, `/vaultstatus`, `/forceprocess`, `/recreditdeposit`, `/resettotp`, `/help`) are out of scope. Operators know their commands.
- Telegram Web App (Mini App). Ruled out — hosting, auth handshake, second deploy target. Inline keyboards cover the UX win.
- Multi-language, session-based TOTP unlock, deep-link bootstrapping, per-request QR codes.

## 3. Audience

Vault depositors: users who interact with the bot via Telegram DMs to deposit, view balance, withdraw, and manage their withdrawal whitelist.

## 4. Architecture

```
TelegramCommander
  ├── dispatch(msg)            [existing]  — handles text + commands
  └── dispatchCallback(q)      [NEW]       — handles inline-button taps

CommandHandlers                [existing, unchanged behavior]
  ├── handleAccount, handleDeposit, handleBalance, handleWithdraw, handleSetWhitelist, handleCancelWhitelist, handleStats
  ├── handleAccept, handleDecline
  └── handleMessage(msg)       ← TOTP + free-text replies consumed here

uiKeyboards.ts                 [NEW, pure]
  └── builders returning Telegram InlineKeyboardMarkup JSON

uiCallbacks.ts                 [NEW]
  └── routeCallback(data, ctx) — parses callback_data, calls CommandHandlers methods,
                                  answerCallbackQuery()
```

### Principles

1. **Buttons are a thin front for existing commands.** A button tap routes to the same `handleDeposit/handleBalance/…` method a typed command would invoke. No parallel logic. Security posture inherited from the command handlers: TOTP gating, rate limiter, audit log, cooldowns, preflight checks.
2. **Callbacks are unauthenticated — `callback_data` is user-controllable.** Every handler re-derives state from `DepositorStore` + `pending` map before acting. Acting on a stale or spoofed callback renders the current-state reply; it never mutates on a bad assumption.
3. **Every reply can attach a contextual keyboard.** `ReplyFn` gets an optional `keyboard?: InlineKeyboardMarkup` parameter. Existing replies keep working unchanged (default: no keyboard). Upgraded replies opt in.
4. **Menu button is "free".** BotFather commands already populate Telegram's `☰` menu (registered earlier). A `/menu` convenience command renders the inline button grid; typed commands still land the user in the same button-driven flow.
5. **Single source of truth for state.** Reuse the existing `PendingAction` map in `CommandHandlers`. Button presses that need TOTP set `pending` exactly as typed commands do; the user's next 6-digit reply is consumed by the current `handleMessage`.

## 5. Touched & new files

| File | Status | Responsibility |
|---|---|---|
| `src/vault/uiKeyboards.ts` | **NEW** | Pure builders returning `InlineKeyboardMarkup` JSON. No I/O. |
| `src/vault/uiCallbacks.ts` | **NEW** | Parses `callback_data`, dispatches to `CommandHandlers`, answers the callback query, handles errors. |
| `src/telegramCommander.ts` | **MODIFY** | Widen `allowed_updates` to `["message","callback_query"]`. Add `dispatchCallback()` method. Extend `reply()` with optional `keyboard`. Add `answerCallbackQuery()` helper. |
| `src/vault/commands.ts` | **MODIFY** | Reply sites now optionally attach a contextual keyboard. Behavior unchanged. New `handleMenu()` method. |
| `src/main.ts` | **MODIFY** | `tgCmd.registerVaultCommand('menu', …)`. Wire the `dispatchCallback` route when `vault.uiButtons` flag is on. |
| `src/types.ts` | **MODIFY** | Add `CallbackQuery`, `InlineKeyboardMarkup`, `InlineKeyboardButton` types (thin mirrors of the Telegram API shape). |
| `src/config.ts` | **MODIFY** | Add `vault.uiButtons: boolean` (default `true`). |
| `tests/vault/uiKeyboards.test.ts` | **NEW** | Snapshot-style tests, one per builder + state. |
| `tests/vault/uiCallbacks.test.ts` | **NEW** | Dispatch + auth gate + enrollment-check + error-path tests. |
| `tests/vault/commands.test.ts` | **MODIFY** | Existing tests still pass; add assertions that replies carry keyboards when expected. |
| `tests/telegramCommander.test.ts` | **MODIFY** | Fake Telegram server: simulate `callback_query` in the poll response; assert dispatch + `answerCallbackQuery`. |

**Not touched:** `depositorStore`, `enrollment`, `cooldowns`, `withdrawalExecutor`, `totp`, `rateLimiter`, `audit`, `encryption`, `shareMath`, `preflight`, any operator command, any MM loop code.

**No new npm deps.** Builders return plain objects; Telegram API already reached via `fetch`.

## 6. `callback_data` schema

Each value ≤ 32 chars (well under Telegram's 64-byte limit). Opaque namespace; parser is a flat `switch`.

```
nav:home                              Main menu
nav:settings                          Settings submenu

act:deposit                           /deposit flow (primes TOTP)
act:balance                           /balance flow (primes TOTP)
act:stats                             /stats (public, no TOTP)

wd:p25 | wd:p50 | wd:p75 | wd:p100    Withdrawal preset
wd:custom                             Switch to custom-USD entry

wl:set                                Start /setwhitelist flow
wl:cancel                             Start /cancelwhitelist flow

enr:accept                            Accept disclaimer
enr:decline                           Decline disclaimer

cancel                                Abort any pending action (clears the `pending` entry,
                                      renders main menu)
```

Unknown values → silent `answerCallbackQuery` + log at `warn` with `{userId, data}`. No user-visible message.

## 7. User flows

### 7.1 First-time enrollment — replaces typed `/account /accept /decline`

```
/menu (or any command while not enrolled)
↓
"👋 Welcome to BertMM Vault. You need to create an account first."
[🆕 Create account]  [📈 Stats]

tap [Create account]
↓
<disclaimer text — same copy as today>
[✅ I accept]  [❌ Decline]

tap [I accept]
↓
"🔐 Set up 2FA: scan this QR in Google Auth or Authy
 <QR image — reuses existing `qrcode` dep, sent via photoBase64>
 or enter secret manually: XXXXXXXX

 Reply with the 6-digit code when ready."

user types 123456
↓
"✅ Account ready."
[💰 Deposit]  [📊 Balance]  [📈 Stats]  [🏠 Menu]
```

### 7.2 Deposit — replaces `/deposit`

```
tap [💰 Deposit] or type /deposit
↓
"Reply with your current 6-digit 2FA code to reveal your deposit address."
[❌ Cancel]

user types 123456
↓
"Your deposit address:
 2yHJ…LqkQ

 Send SOL and/or BERT. Funds are swept + credited after the next tick."
[📊 Balance]  [🏠 Menu]
```

### 7.3 Balance + Withdraw

```
tap [📊 Balance]
↓
"Reply with 6-digit code…"

user types 123456
↓
"50.12 shares — approx $100.50
 NAV/share: $2.00"
[💸 Withdraw]  [💰 Deposit more]  [🏠 Menu]

tap [💸 Withdraw]
↓
"How much to withdraw?"
[25%] [50%]
[75%] [100%]
[💲 Custom USD amount]
[❌ Cancel]

tap [50%]
↓
"Withdraw 50% ≈ $50.25 to your whitelisted address ABC…XYZ?
 Reply with 6-digit code to confirm."
[❌ Cancel]

user types 123456
↓
"✅ Withdrawal queued."
[📊 Balance]  [🏠 Menu]
```

"Custom USD" is a two-step flow:

1. Tap `[💲 Custom USD amount]` → callback sets `pending = { kind: 'withdraw_amount_entry' }` → bot prompts `"Reply with a USD amount (e.g., 25)"`. New `PendingAction` variant.
2. User replies with `50` → `handleMessage` routes on `withdraw_amount_entry`, parses/validates the USD amount, then transitions `pending` to the existing `{ kind: 'withdraw', amountUsd: 50 }` and prompts for the TOTP code — exactly as if they'd typed `/withdraw 50` originally.

TOTP then flows through the same `respondWithdraw` path. Zero new code in the withdrawal-execution layer.

### 7.4 Set whitelist — replaces `/setwhitelist <addr>`

Button drives the prompt; the Solana address still has to be pasted (no button can substitute a 44-char base58 string, but Telegram's paste UX is decent):

```
Settings → tap [🎯 Set withdrawal address]
↓
"Paste the Solana address you want withdrawals sent to.
 (Must be a regular wallet, not a program account.)"
[❌ Cancel]

user pastes <addr>
↓
"Set ABC…XYZ as your withdrawal address?
 Reply with 6-digit code.
 (First-time: instant. Later changes: 7-day cooldown.)"
[❌ Cancel]

user types 123456
↓
"✅ Whitelist updated."
[🏠 Menu]
```

### 7.5 Main menu — `/menu` or `☰`

```
"🏦 BertMM Vault"
[💰 Deposit]   [📊 Balance]
[💸 Withdraw]  [⚙️ Settings]
[📈 Stats]
```

### 7.6 Stats (public, no TOTP)

```
tap [📈 Stats] or type /stats
↓
"Vault TVL: $12,450.00
 NAV/share: $2.00
 Total shares: 6,225.00"
[🏠 Menu]  (if enrolled — omitted for non-enrolled users)
```

### 7.7 Contextual tail

Every *terminal* reply (successful action complete) gets `[🏠 Menu]` plus 1–2 relevant next-actions (e.g., `[📊 Balance]` after Deposit, `[💸 Withdraw]` after Balance). Error replies (rate-limited, invalid TOTP) get `[🔙 Try again]` + `[🏠 Menu]`.

Intermediate replies (waiting on TOTP or address paste) get `[❌ Cancel]` only — preserves the "this is a pending action" shape.

## 8. Error handling

| Scenario | Behavior |
|---|---|
| Callback arrives, user not enrolled | Same guard as typed command: `"Please enroll first."` + welcome keyboard. |
| Rate-limited user | `rejectIfLocked` fires → reply with remaining time + `[🏠 Menu]`. |
| Unknown `callback_data` | Silent `answerCallbackQuery`; log at `warn`. No user-visible message. |
| Handler throws | Log error, reply `"Something went wrong — try again."` + `[🏠 Menu]`, `answerCallbackQuery`. Never leaves a hung spinner. |
| Telegram API down during `answerCallbackQuery` | Log warn and continue. Spinner auto-clears client-side after 15s. |
| Stale button press (old message, state has changed) | Handlers re-derive state; render current-state reply; no corruption. |
| Two rapid taps on the same button | Both callbacks set the same `pending`; idempotent. The next TOTP reply consumes pending; the second tap becomes a no-op. |
| Config flag `vault.uiButtons` off | `allowed_updates` stays `["message"]`; `dispatchCallback` never registered. Old behavior preserved exactly. |

## 9. Testing strategy

- **`tests/vault/uiKeyboards.test.ts`** — snapshot-style: each builder produces the exact JSON expected for each state (unenrolled, enrolled, locked, mid-withdraw, etc.). Pure functions → fast, deterministic.
- **`tests/vault/uiCallbacks.test.ts`** — mock `CommandHandlers`, assert each `callback_data` routes to the right method with the right args. Auth gate tests: unenrolled user pressing `act:deposit` → welcome flow (not deposit). Rate-limited user → lockout reply. Unknown callback → silent dismiss + log.
- **`tests/vault/commands.test.ts`** (extended) — every existing reply-assertion gets an added check that the reply carries the expected keyboard shape when enrollment state calls for it. Existing behavior assertions unchanged.
- **`tests/telegramCommander.test.ts`** (extended) — fake Telegram server: simulate `callback_query` in the poll response; assert `dispatchCallback` is invoked exactly once, `answerCallbackQuery` called exactly once per query.

Target: all 243 existing tests still pass + ~30 new tests, runtime still under 10s.

No integration test against the live Telegram server — we rely on the existing fetch-mocking pattern used in `telegramCommander.test.ts`.

## 10. Deployment

1. Branch `feature/telegram-ui` already created from `feature/vault-v1`.
2. Implement via the phased plan (this spec → `writing-plans` → execution).
3. Merge `feature/telegram-ui` into `feature/vault-v1` (or into `main` after vault-v1 lands — operator chooses at deploy time).
4. Config: `vault.uiButtons: true` added to `/etc/bert-mm-bot/config.yaml` (or left off the file and defaults `true`).
5. No new secrets, no schema migration, no RPC change. Restart is sufficient.
6. Rollback: set `vault.uiButtons: false` and restart. Typed commands keep working, callbacks become no-op.

## 11. Open risks & mitigations

| Risk | Mitigation |
|---|---|
| Callback spam / abuse | Rate limiter covers the privileged paths already. Non-TOTP callbacks (`nav:*`, `act:stats`) are cheap read-only work; no new attack surface. |
| Button emoji rendering differences across Telegram clients | Use well-supported emoji only (verified on iOS, Android, Desktop before ship). |
| `callback_data` overflow on future additions | Schema reserves namespaces; longest current value is 10 chars. Budget document added to `uiKeyboards.ts` header comment. |
| Telegram's 15s `answerCallbackQuery` timeout for long operations | Always answer immediately (empty text), then do work in the follow-up reply. Covered in the pattern for every handler. |
| Desync between BotFather command list and button-driven flows | Button flows call the same handlers as typed commands; behavior identical. Command list registered once, stays valid. |

## 12. Acceptance criteria

- `pnpm vitest run` → 243 prior + ≈30 new tests green.
- `pnpm build` clean, `pnpm tsc --noEmit` clean.
- Typed commands (`/account`, `/deposit`, `/balance`, `/withdraw 50%`, `/setwhitelist …`, `/cancelwhitelist`, `/stats`) behave identically to pre-change.
- `/menu` command surfaces the main inline keyboard for enrolled users, the welcome keyboard for non-enrolled.
- Every depositor flow in §7 works end-to-end against a fake Telegram transport.
- Rollback: `vault.uiButtons: false` restores pre-change behavior exactly.
