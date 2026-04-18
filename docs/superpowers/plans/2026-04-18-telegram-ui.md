# Telegram Depositor UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add inline-keyboard button UI to the vault's depositor-facing Telegram flows (enrollment, deposit, balance, withdraw, whitelist, stats), layered on top of the existing typed commands. Reuse all existing security/auth/audit logic unchanged.

**Architecture:** Buttons are a thin front-end. Each `callback_data` value routes to the same `CommandHandlers` method a typed command would invoke. New modules: `uiKeyboards.ts` (pure builders) and `uiCallbacks.ts` (router). `TelegramCommander` gains `dispatchCallback()` + an optional `keyboard`/`photoBase64` on `reply()`.

**Tech Stack:** TypeScript 5, vitest, existing `otpauth` and `qrcode` deps (already in `package.json` on `feature/vault-v1`). No new npm packages.

**Branch:** `feature/telegram-ui` (worktree at `/opt/bert-mm-bot/.worktrees/telegram-ui`), based off `feature/vault-v1`.

**Source spec:** `docs/superpowers/specs/2026-04-18-telegram-ui-design.md`

---

## Task 1: Add Telegram API types + `vault.uiButtons` config flag

**Files:**
- Modify: `src/types.ts` (append types)
- Modify: `src/config.ts:46-57` (extend `VaultConfigSchema`)
- Test: `tests/config.test.ts` (add a describe block)

- [ ] **Step 1: Write the failing test**

Append to `tests/config.test.ts`:

```typescript
describe('vault.uiButtons flag', () => {
  it('defaults to true when vault present but flag omitted', () => {
    const yaml = baseYamlWithVault({ uiButtonsOmit: true });
    const cfg = loadConfig(yaml);
    expect(cfg.vault?.uiButtons).toBe(true);
  });
  it('honors explicit false', () => {
    const yaml = baseYamlWithVault({ uiButtons: false });
    const cfg = loadConfig(yaml);
    expect(cfg.vault?.uiButtons).toBe(false);
  });
});
```

(Reuse the existing `baseYamlWithVault` helper pattern from the test file; extend it to support the new params if it doesn't already.)

- [ ] **Step 2: Run test, verify failure**

Run: `pnpm vitest run tests/config.test.ts`
Expected: the new `it` cases fail because `uiButtons` is not on `VaultConfigSchema`.

- [ ] **Step 3: Add `uiButtons` to `VaultConfigSchema` in `src/config.ts`**

Edit lines 46-57 so the schema becomes:

```typescript
const VaultConfigSchema = z.object({
  enabled: z.boolean(),
  withdrawalFeeBps: z.number().int().min(0).max(1000),
  minDepositUsd: z.number().positive(),
  minWithdrawalUsd: z.number().positive(),
  maxDailyWithdrawalsPerUser: z.number().int().positive(),
  maxDailyWithdrawalUsdPerUser: z.number().positive(),
  maxPendingWithdrawals: z.number().int().positive(),
  depositMinConfirms: z.number().int().nonnegative(),
  whitelistCooldownHours: z.number().int().positive(),
  operatorTelegramId: z.number().int(),
  uiButtons: z.boolean().default(true),
});
```

- [ ] **Step 4: Add Telegram API types to `src/types.ts`**

Append (at the bottom of the file):

```typescript
// ─── Telegram inline-button types (mirror of Telegram Bot API shapes) ────
export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export type InlineKeyboardMarkup = {
  inline_keyboard: InlineKeyboardButton[][];
};

export interface CallbackQuery {
  id: string;
  from: { id: number };
  message?: {
    message_id: number;
    chat: { id: number };
  };
  data?: string;
}
```

- [ ] **Step 5: Also propagate `uiButtons` through `BotConfig` type**

If `BotConfig` in `src/types.ts` inlines the vault shape, add `uiButtons: boolean` to the `vault` shape there. If it's derived from the zod schema via `z.infer`, no change needed.

- [ ] **Step 6: Run the vault config test suite, verify pass**

Run: `pnpm vitest run tests/config.test.ts`
Expected: PASS. All prior config tests still pass.

- [ ] **Step 7: tsc clean**

Run: `pnpm tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
cd /opt/bert-mm-bot/.worktrees/telegram-ui
git add src/types.ts src/config.ts tests/config.test.ts
git commit -m "feat(ui): add Telegram inline-button types + vault.uiButtons config flag

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `uiKeyboards.ts` part 1 — welcome, main menu, cancel

**Files:**
- Create: `src/vault/uiKeyboards.ts`
- Test: `tests/vault/uiKeyboards.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/vault/uiKeyboards.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  welcomeKeyboard,
  mainMenuKeyboard,
  cancelKeyboard,
} from '../../src/vault/uiKeyboards.js';

describe('uiKeyboards — core', () => {
  it('welcomeKeyboard has [Create account] and [Stats] on one row', () => {
    const kb = welcomeKeyboard();
    expect(kb.inline_keyboard.length).toBe(1);
    expect(kb.inline_keyboard[0].map(b => b.callback_data)).toEqual([
      'nav:create_account',
      'act:stats',
    ]);
    expect(kb.inline_keyboard[0][0].text).toMatch(/Create account/i);
  });

  it('mainMenuKeyboard has Deposit, Balance, Withdraw, Settings, Stats in 3 rows', () => {
    const kb = mainMenuKeyboard();
    expect(kb.inline_keyboard.length).toBe(3);
    const flat = kb.inline_keyboard.flat().map(b => b.callback_data);
    expect(flat).toEqual([
      'act:deposit',  'act:balance',
      'act:withdraw', 'nav:settings',
      'act:stats',
    ]);
  });

  it('cancelKeyboard has single Cancel button with callback_data=cancel', () => {
    const kb = cancelKeyboard();
    expect(kb.inline_keyboard).toEqual([[{ text: expect.stringMatching(/Cancel/i), callback_data: 'cancel' }]]);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `pnpm vitest run tests/vault/uiKeyboards.test.ts`
Expected: FAIL with "Cannot find module '.../uiKeyboards.js'".

- [ ] **Step 3: Implement `src/vault/uiKeyboards.ts`**

Create the file:

```typescript
import type { InlineKeyboardMarkup } from '../types.js';

// Callback-data budget: ≤ 32 chars per value (Telegram limit is 64 bytes).
// Namespaces (see spec §6):
//   nav:<dest>  act:<name>  wd:<preset>  wl:<op>  enr:<step>  cancel

export function welcomeKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: '🆕 Create account', callback_data: 'nav:create_account' },
      { text: '📈 Stats',           callback_data: 'act:stats' },
    ]],
  };
}

export function mainMenuKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '💰 Deposit',  callback_data: 'act:deposit' },
        { text: '📊 Balance',  callback_data: 'act:balance' },
      ],
      [
        { text: '💸 Withdraw', callback_data: 'act:withdraw' },
        { text: '⚙️ Settings', callback_data: 'nav:settings' },
      ],
      [
        { text: '📈 Stats',    callback_data: 'act:stats' },
      ],
    ],
  };
}

export function cancelKeyboard(): InlineKeyboardMarkup {
  return { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel' }]] };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm vitest run tests/vault/uiKeyboards.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/vault/uiKeyboards.ts tests/vault/uiKeyboards.test.ts
git commit -m "feat(ui): keyboard builders — welcome, main menu, cancel

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `uiKeyboards.ts` part 2 — disclaimer, settings, withdraw, contextual tails

**Files:**
- Modify: `src/vault/uiKeyboards.ts`
- Modify: `tests/vault/uiKeyboards.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/vault/uiKeyboards.test.ts`:

```typescript
import {
  disclaimerKeyboard,
  settingsKeyboard,
  withdrawAmountKeyboard,
  postDepositKeyboard,
  postBalanceKeyboard,
  postActionKeyboard,
  errorKeyboard,
} from '../../src/vault/uiKeyboards.js';

describe('uiKeyboards — flow', () => {
  it('disclaimerKeyboard has [I accept] and [Decline]', () => {
    const kb = disclaimerKeyboard();
    const data = kb.inline_keyboard.flat().map(b => b.callback_data);
    expect(data).toEqual(['enr:accept', 'enr:decline']);
  });

  it('settingsKeyboard has Set Whitelist, Cancel Whitelist, Menu', () => {
    const kb = settingsKeyboard();
    const data = kb.inline_keyboard.flat().map(b => b.callback_data);
    expect(data).toEqual(['wl:set', 'wl:cancel', 'nav:home']);
  });

  it('withdrawAmountKeyboard has 25/50/75/100/custom/cancel', () => {
    const kb = withdrawAmountKeyboard();
    const data = kb.inline_keyboard.flat().map(b => b.callback_data);
    expect(data).toEqual(['wd:p25','wd:p50','wd:p75','wd:p100','wd:custom','cancel']);
  });

  it('postDepositKeyboard offers Balance + Home', () => {
    expect(postDepositKeyboard().inline_keyboard.flat().map(b => b.callback_data))
      .toEqual(['act:balance', 'nav:home']);
  });

  it('postBalanceKeyboard offers Withdraw, Deposit more, Home', () => {
    expect(postBalanceKeyboard().inline_keyboard.flat().map(b => b.callback_data))
      .toEqual(['act:withdraw', 'act:deposit', 'nav:home']);
  });

  it('postActionKeyboard is just Home', () => {
    expect(postActionKeyboard().inline_keyboard.flat().map(b => b.callback_data))
      .toEqual(['nav:home']);
  });

  it('errorKeyboard offers Try again + Home when retryable', () => {
    expect(errorKeyboard({ retryCallback: 'act:balance' }).inline_keyboard.flat().map(b => b.callback_data))
      .toEqual(['act:balance', 'nav:home']);
  });

  it('errorKeyboard without retryCallback is just Home', () => {
    expect(errorKeyboard().inline_keyboard.flat().map(b => b.callback_data))
      .toEqual(['nav:home']);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `pnpm vitest run tests/vault/uiKeyboards.test.ts`
Expected: FAIL (new functions not exported).

- [ ] **Step 3: Extend `src/vault/uiKeyboards.ts`**

Append:

```typescript
export function disclaimerKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: '✅ I accept',  callback_data: 'enr:accept' },
      { text: '❌ Decline',   callback_data: 'enr:decline' },
    ]],
  };
}

export function settingsKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: '🎯 Set withdrawal address',    callback_data: 'wl:set' }],
      [{ text: '🚫 Cancel pending whitelist', callback_data: 'wl:cancel' }],
      [{ text: '🏠 Menu',                     callback_data: 'nav:home' }],
    ],
  };
}

export function withdrawAmountKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '25%',  callback_data: 'wd:p25' },
        { text: '50%',  callback_data: 'wd:p50' },
      ],
      [
        { text: '75%',  callback_data: 'wd:p75' },
        { text: '100%', callback_data: 'wd:p100' },
      ],
      [{ text: '💲 Custom USD',  callback_data: 'wd:custom' }],
      [{ text: '❌ Cancel',      callback_data: 'cancel' }],
    ],
  };
}

export function postDepositKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: '📊 Balance', callback_data: 'act:balance' },
      { text: '🏠 Menu',    callback_data: 'nav:home' },
    ]],
  };
}

export function postBalanceKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: '💸 Withdraw',     callback_data: 'act:withdraw' },
      { text: '💰 Deposit more', callback_data: 'act:deposit' },
      { text: '🏠 Menu',         callback_data: 'nav:home' },
    ]],
  };
}

export function postActionKeyboard(): InlineKeyboardMarkup {
  return { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'nav:home' }]] };
}

export function errorKeyboard(opts: { retryCallback?: string } = {}): InlineKeyboardMarkup {
  const row: InlineKeyboardButton[] = [];
  if (opts.retryCallback) row.push({ text: '🔙 Try again', callback_data: opts.retryCallback });
  row.push({ text: '🏠 Menu', callback_data: 'nav:home' });
  return { inline_keyboard: [row] };
}
```

Import `InlineKeyboardButton` at the top of the file (alongside `InlineKeyboardMarkup`).

- [ ] **Step 4: Run, verify pass**

Run: `pnpm vitest run tests/vault/uiKeyboards.test.ts`
Expected: PASS (11 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/vault/uiKeyboards.ts tests/vault/uiKeyboards.test.ts
git commit -m "feat(ui): keyboard builders — disclaimer, settings, withdraw, tails

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `TelegramCommander.reply()` — optional keyboard + photoBase64

**Files:**
- Modify: `src/telegramCommander.ts:150-161` (the existing `reply` method)
- Test: `tests/telegramCommander.test.ts` (new describe block)

- [ ] **Step 1: Write the failing test**

Append to `tests/telegramCommander.test.ts`:

```typescript
describe('TelegramCommander.reply — extras', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  it('passes reply_markup when keyboard is provided', async () => {
    const tg = new TelegramCommander({ botToken: 't', operatorUserId: 1, depositorStore: fakeStore() });
    await tg.reply(42, 'hi', { keyboard: { inline_keyboard: [[{ text: 'x', callback_data: 'nav:home' }]] } });
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.chat_id).toBe(42);
    expect(body.text).toBe('hi');
    expect(body.reply_markup).toEqual({ inline_keyboard: [[{ text: 'x', callback_data: 'nav:home' }]] });
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/sendMessage$/);
  });

  it('uses sendPhoto when photoBase64 provided', async () => {
    const tg = new TelegramCommander({ botToken: 't', operatorUserId: 1, depositorStore: fakeStore() });
    await tg.reply(42, 'caption', { photoBase64: 'aGVsbG8=' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/sendPhoto$/);
  });

  it('no extras → sendMessage with just chat_id + text (unchanged)', async () => {
    const tg = new TelegramCommander({ botToken: 't', operatorUserId: 1, depositorStore: fakeStore() });
    await tg.reply(42, 'hi');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ chat_id: 42, text: 'hi' });
  });
});
```

(If `tests/telegramCommander.test.ts` doesn't yet exist, create it with a minimal top-of-file import block: `import { TelegramCommander } from '../src/telegramCommander.js'; import { describe, it, expect, vi, beforeEach } from 'vitest';` and a `fakeStore()` helper: `function fakeStore() { return { getUser: () => null } as any; }`.)

- [ ] **Step 2: Run, verify failure**

Run: `pnpm vitest run tests/telegramCommander.test.ts`
Expected: FAIL — `reply` does not accept extras, or `sendPhoto` branch missing.

- [ ] **Step 3: Extend `reply()` in `src/telegramCommander.ts`**

Replace lines 150-161 with:

```typescript
/** Send a reply to the given chat. Public so handlers registered from main.ts can use it.
 *  Optionally attaches an inline keyboard (reply_markup) and/or sends as a photo caption.
 *  When photoBase64 is provided, the Bot API endpoint switches from sendMessage to sendPhoto. */
async reply(
  chatId: number,
  text: string,
  extras?: { keyboard?: InlineKeyboardMarkup; photoBase64?: string },
): Promise<void> {
  const keyboard = extras?.keyboard;
  const photoBase64 = extras?.photoBase64;
  try {
    if (photoBase64) {
      // Telegram sendPhoto expects multipart; for simplicity we upload as a
      // base64 data-URL on the `photo` field which Telegram accepts via the
      // InputFile.fromBuffer equivalent — but simplest: use sendPhoto with a
      // multipart form containing the raw bytes.
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append('caption', text);
      const bytes = Buffer.from(photoBase64, 'base64');
      form.append('photo', new Blob([bytes]), 'qr.png');
      if (keyboard) form.append('reply_markup', JSON.stringify(keyboard));
      await fetch(`https://api.telegram.org/bot${this.botToken}/sendPhoto`, {
        method: 'POST',
        body: form,
      });
    } else {
      const body: Record<string, unknown> = { chat_id: chatId, text };
      if (keyboard) body.reply_markup = keyboard;
      await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    }
  } catch (e) {
    logger.warn({ err: e }, 'telegram commander reply failed');
  }
}
```

Add import at the top of the file: `import type { InlineKeyboardMarkup } from './types.js';`.

- [ ] **Step 4: Run, verify pass**

Run: `pnpm vitest run tests/telegramCommander.test.ts`
Expected: 3 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/telegramCommander.ts tests/telegramCommander.test.ts
git commit -m "feat(ui): reply() accepts optional keyboard + photoBase64

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `TelegramCommander.answerCallbackQuery()`

**Files:**
- Modify: `src/telegramCommander.ts`
- Modify: `tests/telegramCommander.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/telegramCommander.test.ts`:

```typescript
describe('TelegramCommander.answerCallbackQuery', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  it('POSTs to /answerCallbackQuery with the query id', async () => {
    const tg = new TelegramCommander({ botToken: 't', operatorUserId: 1, depositorStore: fakeStore() });
    await tg.answerCallbackQuery('abc123');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/answerCallbackQuery$/);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.callback_query_id).toBe('abc123');
  });

  it('swallows errors silently', async () => {
    const tg = new TelegramCommander({ botToken: 't', operatorUserId: 1, depositorStore: fakeStore() });
    fetchMock.mockRejectedValueOnce(new Error('network'));
    await expect(tg.answerCallbackQuery('x')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `pnpm vitest run tests/telegramCommander.test.ts -t answerCallbackQuery`
Expected: FAIL — method missing.

- [ ] **Step 3: Add `answerCallbackQuery` to `src/telegramCommander.ts`**

Insert (just after `reply()`):

```typescript
/** Dismiss the loading spinner on a callback_query. Must be called within
 *  15 seconds or Telegram marks the query as stale client-side. Errors are
 *  logged and swallowed — the spinner clears itself after 15s regardless. */
async answerCallbackQuery(queryId: string, text?: string): Promise<void> {
  try {
    const body: Record<string, unknown> = { callback_query_id: queryId };
    if (text) body.text = text;
    await fetch(`https://api.telegram.org/bot${this.botToken}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    logger.warn({ err: e, queryId }, 'telegram answerCallbackQuery failed');
  }
}
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm vitest run tests/telegramCommander.test.ts -t answerCallbackQuery`
Expected: 2 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/telegramCommander.ts tests/telegramCommander.test.ts
git commit -m "feat(ui): answerCallbackQuery helper on TelegramCommander

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `TelegramCommander.dispatchCallback()` + widen `allowed_updates`

**Files:**
- Modify: `src/telegramCommander.ts` (add callback route registration + poll update)
- Modify: `tests/telegramCommander.test.ts`

- [ ] **Step 1: Write the failing tests**

Append:

```typescript
describe('TelegramCommander.dispatchCallback', () => {
  it('calls registered callback router with parsed query, then answers', async () => {
    const answers: string[] = [];
    const fetchMock = vi.fn(async (url: string, init: any) => {
      if (url.endsWith('/answerCallbackQuery')) {
        answers.push(JSON.parse(init.body).callback_query_id);
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const tg = new TelegramCommander({ botToken: 't', operatorUserId: 1, depositorStore: fakeStore() });
    const seen: any[] = [];
    tg.setCallbackRouter(async (q) => { seen.push(q); });
    await tg.dispatchCallback({
      id: 'q1',
      from: { id: 7 },
      message: { message_id: 10, chat: { id: 42 } },
      data: 'nav:home',
    });
    expect(seen).toEqual([{ id: 'q1', userId: 7, chatId: 42, data: 'nav:home' }]);
    expect(answers).toEqual(['q1']);
  });

  it('unknown data still answers the query but logs at warn', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const tg = new TelegramCommander({ botToken: 't', operatorUserId: 1, depositorStore: fakeStore() });
    // no router registered → dispatchCallback should still call answerCallbackQuery
    await tg.dispatchCallback({
      id: 'q2', from: { id: 7 }, message: { message_id: 1, chat: { id: 42 } }, data: 'xxx',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/answerCallbackQuery$/),
      expect.anything(),
    );
  });
});

describe('TelegramCommander — allowed_updates widening', () => {
  it('includes callback_query in getUpdates URL when setCallbackRouter has been called', async () => {
    const captured: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      captured.push(url);
      return { ok: true, json: async () => ({ ok: true, result: [] }) };
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const tg = new TelegramCommander({ botToken: 't', operatorUserId: 1, depositorStore: fakeStore() });
    tg.setCallbackRouter(async () => {});
    tg.start();
    // give the poll loop one tick
    await new Promise((r) => setTimeout(r, 50));
    tg.stop();
    expect(captured[0]).toMatch(/allowed_updates=%5B%22message%22%2C%22callback_query%22%5D/);
  });

  it('only ["message"] when no callback router registered', async () => {
    const captured: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      captured.push(url);
      return { ok: true, json: async () => ({ ok: true, result: [] }) };
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const tg = new TelegramCommander({ botToken: 't', operatorUserId: 1, depositorStore: fakeStore() });
    tg.start();
    await new Promise((r) => setTimeout(r, 50));
    tg.stop();
    expect(captured[0]).toMatch(/allowed_updates=%5B%22message%22%5D/);
    expect(captured[0]).not.toMatch(/callback_query/);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `pnpm vitest run tests/telegramCommander.test.ts`
Expected: FAIL — `setCallbackRouter` / `dispatchCallback` missing.

- [ ] **Step 3: Extend `src/telegramCommander.ts`**

Add a new typed shape (top of file, near `IncomingMessage`):

```typescript
export interface ParsedCallback {
  id: string;
  userId: number;
  chatId: number;
  data: string;
}

export type CallbackRouter = (q: ParsedCallback) => Promise<void>;
```

Add fields + setter inside the class:

```typescript
private callbackRouter: CallbackRouter | null = null;

setCallbackRouter(fn: CallbackRouter): void {
  this.callbackRouter = fn;
}
```

Add `dispatchCallback`:

```typescript
async dispatchCallback(cb: {
  id: string;
  from: { id: number };
  message?: { message_id: number; chat: { id: number } };
  data?: string;
}): Promise<void> {
  try {
    if (!cb.message || !cb.data) {
      await this.answerCallbackQuery(cb.id);
      return;
    }
    const parsed: ParsedCallback = {
      id: cb.id,
      userId: cb.from.id,
      chatId: cb.message.chat.id,
      data: cb.data,
    };
    if (this.callbackRouter) {
      await this.callbackRouter(parsed);
    } else {
      logger.warn({ data: cb.data, userId: cb.from.id }, 'callback_query received but no router registered');
    }
  } catch (e) {
    logger.error({ err: e }, 'dispatchCallback failed');
  } finally {
    await this.answerCallbackQuery(cb.id);
  }
}
```

Widen `allowed_updates` in `pollLoop()`:

```typescript
const allowed = this.callbackRouter
  ? '%5B%22message%22%2C%22callback_query%22%5D'   // URL-encoded ["message","callback_query"]
  : '%5B%22message%22%5D';                          // URL-encoded ["message"]
const url = `https://api.telegram.org/bot${this.botToken}/getUpdates?offset=${this.offset}&timeout=${POLL_TIMEOUT_S}&allowed_updates=${allowed}`;
```

Also inside the update loop, handle callback_query updates (alongside messages):

```typescript
for (const update of data.result) {
  this.offset = update.update_id + 1;
  if ((update as any).callback_query) {
    await this.dispatchCallback((update as any).callback_query);
    continue;
  }
  const msg = update.message;
  if (!msg?.text) continue;
  // … existing message dispatch path …
}
```

Widen the `data.result` shape to include `callback_query`:

```typescript
const data = (await res.json()) as {
  ok: boolean;
  result: Array<{
    update_id: number;
    message?: { message_id: number; chat: { id: number }; from?: { id: number }; text?: string };
    callback_query?: { id: string; from: { id: number }; message?: { message_id: number; chat: { id: number } }; data?: string };
  }>;
};
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm vitest run tests/telegramCommander.test.ts`
Expected: all commander tests PASS. (If any preexisting commander test fails due to the new shape, update it to match.)

- [ ] **Step 5: Commit**

```bash
git add src/telegramCommander.ts tests/telegramCommander.test.ts
git commit -m "feat(ui): dispatchCallback + conditional allowed_updates widening

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: `CommandHandlers` — add `withdraw_amount_entry` PendingAction variant

**Files:**
- Modify: `src/vault/commands.ts:53-61` (the `PendingAction` union)
- Modify: `src/vault/commands.ts:244-290` (the `handleMessage` switch)
- Modify: `tests/vault/commands.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/vault/commands.test.ts`:

```typescript
describe('CommandHandlers — withdraw_amount_entry', () => {
  it('reply with a valid USD number transitions pending to { withdraw, amountUsd } and prompts TOTP', async () => {
    const h = buildHarness();
    try {
      await enrollFully(h, 7);
      // simulate the button-tap side effect: mark pending as amount-entry
      h.handlers['pending'].set(7, { kind: 'withdraw_amount_entry' } as any);
      // user must have a whitelist for withdraw to progress
      h.store.setWhitelist({ telegramId: 7, address: 'ABC'.repeat(15), now: 1, cooldownActive: false });
      h.navProvider.totalUsd = 100;
      h.navProvider.totalShares = 50;
      h.store.creditShares({ telegramId: 7, netShares: 25, event: 'deposit_credit', navSnapshotId: 1, inboundTxSig: null });

      await h.handlers.handleMessage({ chatId: 5, userId: 7, text: '25' });

      const p = h.handlers.pendingFor(7);
      expect(p?.kind).toBe('withdraw');
      expect((p as any).amountUsd).toBeCloseTo(25, 2);
      const lastText = h.reply.mock.calls[h.reply.mock.calls.length - 1][1];
      expect(lastText).toMatch(/6-digit code/i);
    } finally {
      h.state.close();
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  it('reply with non-number clears pending and emits "invalid amount"', async () => {
    const h = buildHarness();
    try {
      await enrollFully(h, 7);
      h.handlers['pending'].set(7, { kind: 'withdraw_amount_entry' } as any);
      await h.handlers.handleMessage({ chatId: 5, userId: 7, text: 'banana' });
      expect(h.handlers.pendingFor(7)).toBeUndefined();
      const lastText = h.reply.mock.calls[h.reply.mock.calls.length - 1][1];
      expect(lastText).toMatch(/invalid/i);
    } finally {
      h.state.close();
      rmSync(h.dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `pnpm vitest run tests/vault/commands.test.ts -t withdraw_amount_entry`
Expected: FAIL — new variant isn't in the union, switch never handles it.

- [ ] **Step 3: Extend the `PendingAction` union in `src/vault/commands.ts`**

Replace lines 53-61 with:

```typescript
export type PendingAction =
  | { kind: 'disclaimer' }
  | { kind: 'totp_setup_confirm' }
  | { kind: 'deposit_reveal' }
  | { kind: 'balance_reveal' }
  | { kind: 'withdraw_amount_entry' }              // NEW: awaiting free-text USD amount
  | { kind: 'withdraw'; amountUsd: number }
  | { kind: 'setwhitelist_first'; address: string }
  | { kind: 'setwhitelist_change'; address: string }
  | { kind: 'cancelwhitelist' };
```

- [ ] **Step 4: Add a new case in the `handleMessage` switch (after the existing `withdraw` case, around line 275)**

```typescript
case 'withdraw_amount_entry':
  await this.respondWithdrawAmountEntry(msg);
  return;
```

- [ ] **Step 5: Implement `respondWithdrawAmountEntry`**

Add this private method inside `CommandHandlers` (place it near `respondWithdraw`, which lives lower in the file):

```typescript
private async respondWithdrawAmountEntry(
  msg: { chatId: number; userId: number; text: string },
): Promise<void> {
  this.pending.delete(msg.userId);
  const n = Number(msg.text.trim());
  if (!Number.isFinite(n) || n <= 0) {
    await this.deps.reply(msg.chatId, 'Invalid amount. Start again via /withdraw.');
    return;
  }
  const user = this.deps.store.getUser(msg.userId);
  if (!user?.whitelistAddress) {
    await this.deps.reply(msg.chatId, 'Set a withdrawal destination first via /setwhitelist.');
    return;
  }
  const nav = await this.deps.getNav();
  if (!nav) {
    await this.deps.reply(msg.chatId, 'NAV unavailable — try again shortly.');
    return;
  }
  const navPerShare = computeNavPerShare({ totalUsd: nav.totalUsd, totalShares: nav.totalShares });
  const shares = this.deps.store.getShares(msg.userId);
  const userUsd = usdForShares({ netShares: shares, navPerShare });
  if (n < this.deps.config.minWithdrawalUsd) {
    await this.deps.reply(msg.chatId, `Amount below minimum ($${this.deps.config.minWithdrawalUsd.toFixed(2)}).`);
    return;
  }
  if (n > userUsd + 1e-6) {
    await this.deps.reply(msg.chatId, `Amount exceeds your balance ($${userUsd.toFixed(2)}).`);
    return;
  }
  this.pending.set(msg.userId, { kind: 'withdraw', amountUsd: n });
  await this.deps.reply(
    msg.chatId,
    `Withdraw $${n.toFixed(2)} to ${user.whitelistAddress.slice(0, 6)}…${user.whitelistAddress.slice(-4)}?\nReply with your 6-digit 2FA code to confirm.`,
  );
}
```

- [ ] **Step 6: Run, verify pass**

Run: `pnpm vitest run tests/vault/commands.test.ts -t withdraw_amount_entry`
Expected: 2 PASS. All other commands tests still PASS.

Run full: `pnpm vitest run tests/vault/commands.test.ts`

- [ ] **Step 7: tsc clean**

Run: `pnpm tsc --noEmit`

- [ ] **Step 8: Commit**

```bash
git add src/vault/commands.ts tests/vault/commands.test.ts
git commit -m "feat(ui): PendingAction.withdraw_amount_entry + handler for USD reply

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: `CommandHandlers.handleMenu()`

**Files:**
- Modify: `src/vault/commands.ts` (add `handleMenu` method)
- Modify: `tests/vault/commands.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/vault/commands.test.ts`:

```typescript
describe('CommandHandlers — /menu', () => {
  it('unenrolled user gets welcome text + welcomeKeyboard', async () => {
    const h = buildHarness();
    try {
      await h.handlers.handleMenu({ chatId: 5, userId: 7 });
      const [chatId, text, extras] = h.reply.mock.calls[0];
      expect(chatId).toBe(5);
      expect(text).toMatch(/Welcome/i);
      expect(extras?.keyboard?.inline_keyboard?.[0]?.[0]?.callback_data).toBe('nav:create_account');
    } finally { h.state.close(); rmSync(h.dir, { recursive: true, force: true }); }
  });

  it('enrolled user gets main menu keyboard', async () => {
    const h = buildHarness();
    try {
      await enrollFully(h, 7);
      await h.handlers.handleMenu({ chatId: 5, userId: 7 });
      const [, , extras] = h.reply.mock.calls[h.reply.mock.calls.length - 1];
      const flat = extras?.keyboard?.inline_keyboard?.flat().map((b: any) => b.callback_data) ?? [];
      expect(flat).toContain('act:deposit');
      expect(flat).toContain('act:withdraw');
      expect(flat).toContain('nav:settings');
    } finally { h.state.close(); rmSync(h.dir, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run, verify failure**

Expected: FAIL — `handleMenu` missing.

- [ ] **Step 3: Implement `handleMenu`**

Add to `src/vault/commands.ts` (adjacent to `handleStats`):

```typescript
// ── /menu ─────────────────────────────────────────────────────────────
async handleMenu(msg: { chatId: number; userId: number }): Promise<void> {
  const user = this.deps.store.getUser(msg.userId);
  if (!user || user.totpEnrolledAt === null) {
    await this.deps.reply(
      msg.chatId,
      '👋 Welcome to BertMM Vault. You need to create an account first.',
      { keyboard: welcomeKeyboard() },
    );
    return;
  }
  await this.deps.reply(msg.chatId, '🏦 BertMM Vault', { keyboard: mainMenuKeyboard() });
}
```

Import the builders at the top of the file:

```typescript
import { welcomeKeyboard, mainMenuKeyboard } from './uiKeyboards.js';
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm vitest run tests/vault/commands.test.ts -t "/menu"`
Expected: 2 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/vault/commands.ts tests/vault/commands.test.ts
git commit -m "feat(ui): CommandHandlers.handleMenu — welcome vs main menu

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Attach contextual keyboards to existing reply sites

**Files:**
- Modify: `src/vault/commands.ts` (multiple reply sites — see subsections)
- Modify: `tests/vault/commands.test.ts`

**Scope:** Every terminal reply gains a keyboard. Every mid-flow reply (awaiting TOTP / awaiting address / awaiting USD) gains `cancelKeyboard()`. The enrollment QR reply uses `photoBase64`.

### 9a: Enrollment flow keyboards

- [ ] **Step 1: Write the failing test**

```typescript
describe('CommandHandlers — enrollment keyboards', () => {
  it('handleAccount (new user) attaches disclaimer keyboard', async () => {
    const h = buildHarness();
    try {
      await h.handlers.handleAccount({ chatId: 5, userId: 7 });
      const [, , extras] = h.reply.mock.calls[0];
      const flat = extras?.keyboard?.inline_keyboard?.flat().map((b: any) => b.callback_data) ?? [];
      expect(flat).toEqual(['enr:accept', 'enr:decline']);
    } finally { h.state.close(); rmSync(h.dir, { recursive: true, force: true }); }
  });

  it('handleAccept sends QR image (photoBase64) + cancel keyboard', async () => {
    const h = buildHarness();
    try {
      h.handlers['pending'].set(7, { kind: 'disclaimer' } as any);
      await h.handlers.handleAccept({ chatId: 5, userId: 7 });
      const call = h.reply.mock.calls.find(([, , e]: any[]) => e?.photoBase64);
      expect(call).toBeTruthy();
      const [, caption, extras] = call!;
      expect(caption).toMatch(/scan this QR/i);
      expect(extras.photoBase64).toMatch(/^[A-Za-z0-9+/]+=*$/);
      const flat = extras?.keyboard?.inline_keyboard?.flat().map((b: any) => b.callback_data) ?? [];
      expect(flat).toEqual(['cancel']);
    } finally { h.state.close(); rmSync(h.dir, { recursive: true, force: true }); }
  });

  it('post-enrollment confirmation reply attaches main menu keyboard', async () => {
    const h = buildHarness();
    try {
      await h.enrollment.accept({ telegramId: 7, now: 100 });
      const { secretBase32 } = await h.enrollment.beginTotpEnrollment({ telegramId: 7 });
      h.handlers['pending'].set(7, { kind: 'totp_setup_confirm' } as any);
      const { TOTP } = await import('otpauth');
      const code = new TOTP({ secret: secretBase32 }).generate();
      const restore = advancePastNextTotpStep();
      try {
        await h.handlers.handleMessage({ chatId: 5, userId: 7, text: code });
      } finally { restore(); }
      const last = h.reply.mock.calls[h.reply.mock.calls.length - 1];
      const extras = last[2];
      const flat = extras?.keyboard?.inline_keyboard?.flat().map((b: any) => b.callback_data) ?? [];
      expect(flat).toContain('act:deposit');
      expect(flat).toContain('act:balance');
    } finally { h.state.close(); rmSync(h.dir, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run, verify failure**

- [ ] **Step 3: Update `handleAccount` (around line 156)**

Change the disclaimer reply:

```typescript
await this.deps.reply(msg.chatId, DISCLAIMER_TEXT, { keyboard: disclaimerKeyboard() });
```

The TOTP-setup-restart reply (around line 168) becomes a QR image:

```typescript
import QRCode from 'qrcode';
// …
const dataUrl = await QRCode.toDataURL(`otpauth://totp/BertMMVault:${msg.userId}?secret=${secretBase32}&issuer=BertMMVault`);
const photoBase64 = dataUrl.replace(/^data:image\/png;base64,/, '');
await this.deps.reply(
  msg.chatId,
  `🔐 Scan this QR in Google Auth or Authy.\nOr enter secret manually: ${secretBase32}\n\nReply with the 6-digit code.`,
  { photoBase64, keyboard: cancelKeyboard() },
);
```

The fully-enrolled branch (around line 177) becomes:

```typescript
await this.deps.reply(
  msg.chatId,
  'Account ready.',
  { keyboard: mainMenuKeyboard() },
);
```

- [ ] **Step 4: Update `handleAccept` (around line 196) the same way**

Replace the trailing reply with the QR-image + cancel keyboard variant (same shape as Step 3).

- [ ] **Step 5: Update `respondTotpSetupConfirm` success branch (around line 305)**

```typescript
await this.deps.reply(
  msg.chatId,
  '✅ Account ready.',
  { keyboard: mainMenuKeyboard() },
);
```

For failure branches (locked / max failures / retry), attach `errorKeyboard({ retryCallback: 'nav:create_account' })` (locked + max) or simply `cancelKeyboard()` (retry).

- [ ] **Step 6: Add imports at top of `commands.ts`**

```typescript
import QRCode from 'qrcode';
import { disclaimerKeyboard, cancelKeyboard, mainMenuKeyboard, errorKeyboard, welcomeKeyboard } from './uiKeyboards.js';
```

- [ ] **Step 7: Run, verify pass**

Run: `pnpm vitest run tests/vault/commands.test.ts`
Expected: new enrollment-keyboard tests PASS; all existing tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/vault/commands.ts tests/vault/commands.test.ts
git commit -m "feat(ui): enrollment flow keyboards + QR image on TOTP setup

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### 9b: Deposit, balance, stats keyboards

- [ ] **Step 1: Write the failing tests**

```typescript
describe('CommandHandlers — deposit/balance/stats keyboards', () => {
  // Harness setup + full enrollment, then:
  it('handleDeposit prompt uses cancelKeyboard; reveal uses postDepositKeyboard', async () => {
    const h = buildHarness();
    try {
      const secret = await enrollFully(h, 7);
      await h.handlers.handleDeposit({ chatId: 5, userId: 7 });
      let last = h.reply.mock.calls[h.reply.mock.calls.length - 1];
      expect(last[2]?.keyboard?.inline_keyboard?.[0]?.[0]?.callback_data).toBe('cancel');
      const code = await totpCodeFor(secret);
      const restore = advancePastNextTotpStep();
      try { await h.handlers.handleMessage({ chatId: 5, userId: 7, text: code }); }
      finally { restore(); }
      last = h.reply.mock.calls[h.reply.mock.calls.length - 1];
      const flat = last[2]?.keyboard?.inline_keyboard?.flat().map((b: any) => b.callback_data) ?? [];
      expect(flat).toEqual(['act:balance', 'nav:home']);
    } finally { h.state.close(); rmSync(h.dir, { recursive: true, force: true }); }
  });

  it('handleBalance reveal uses postBalanceKeyboard', async () => {
    const h = buildHarness();
    try {
      const secret = await enrollFully(h, 7);
      h.navProvider.totalUsd = 100; h.navProvider.totalShares = 50;
      h.store.creditShares({ telegramId: 7, netShares: 25, event: 'deposit_credit', navSnapshotId: 1, inboundTxSig: null });
      await h.handlers.handleBalance({ chatId: 5, userId: 7 });
      const code = await totpCodeFor(secret);
      const restore = advancePastNextTotpStep();
      try { await h.handlers.handleMessage({ chatId: 5, userId: 7, text: code }); }
      finally { restore(); }
      const last = h.reply.mock.calls[h.reply.mock.calls.length - 1];
      const flat = last[2]?.keyboard?.inline_keyboard?.flat().map((b: any) => b.callback_data) ?? [];
      expect(flat).toEqual(['act:withdraw', 'act:deposit', 'nav:home']);
    } finally { h.state.close(); rmSync(h.dir, { recursive: true, force: true }); }
  });

  it('handleStats reply includes [🏠 Menu] when user enrolled', async () => {
    const h = buildHarness();
    try {
      await enrollFully(h, 7);
      h.navProvider.totalUsd = 100; h.navProvider.totalShares = 50;
      await h.handlers.handleStats({ chatId: 5 });
      const last = h.reply.mock.calls[h.reply.mock.calls.length - 1];
      const flat = last[2]?.keyboard?.inline_keyboard?.flat().map((b: any) => b.callback_data) ?? [];
      expect(flat).toEqual(['nav:home']);
    } finally { h.state.close(); rmSync(h.dir, { recursive: true, force: true }); }
  });

  it('handleStats reply has no keyboard for non-enrolled user', async () => {
    const h = buildHarness();
    try {
      h.navProvider.totalUsd = 100; h.navProvider.totalShares = 50;
      await h.handlers.handleStats({ chatId: 5 });
      const last = h.reply.mock.calls[h.reply.mock.calls.length - 1];
      expect(last[2]?.keyboard).toBeUndefined();
    } finally { h.state.close(); rmSync(h.dir, { recursive: true, force: true }); }
  });
});
```

Note: `handleStats` has no `userId` today — the "enrolled?" check has to be added by passing `userId?: number` as an optional field on the message. Extend the handler signature to `handleStats(msg: { chatId: number; userId?: number })` and, when `userId` is supplied, look up the store and attach `postActionKeyboard()` only if enrolled. `/stats` typed-command path continues to pass `userId`; pure public callers can omit it. Update the signature AND the call sites in Task 11's `/stats` route.

- [ ] **Step 2: Update the reply sites**

- `handleDeposit` prompt → `{ keyboard: cancelKeyboard() }`
- `respondDepositReveal` success reply → `{ keyboard: postDepositKeyboard() }`; failure → `{ keyboard: errorKeyboard({ retryCallback: 'act:deposit' }) }`
- `handleBalance` prompt → `cancelKeyboard()`
- `respondBalanceReveal` success → `postBalanceKeyboard()`; failure → `errorKeyboard({ retryCallback: 'act:balance' })`
- `handleStats` reply → `{ keyboard: postActionKeyboard() }` if user enrolled, no keyboard otherwise

Add imports as needed (`postDepositKeyboard`, `postBalanceKeyboard`, `postActionKeyboard`).

- [ ] **Step 3: Run, verify pass**

- [ ] **Step 4: Commit**

```bash
git add src/vault/commands.ts tests/vault/commands.test.ts
git commit -m "feat(ui): deposit/balance/stats flow keyboards

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### 9c: Withdraw + whitelist keyboards

- [ ] **Step 1: Write the failing tests**

Append to `tests/vault/commands.test.ts`:

```typescript
describe('CommandHandlers — withdraw/whitelist keyboards', () => {
  it('handleWithdraw with no arg shows amount picker + sets pending=withdraw_amount_entry', async () => {
    const h = buildHarness();
    try {
      await enrollFully(h, 7);
      h.store.setWhitelist({ telegramId: 7, address: 'A'.repeat(44), now: 1, cooldownActive: false });
      await h.handlers.handleWithdraw({ chatId: 5, userId: 7, text: '/withdraw' });
      const last = h.reply.mock.calls[h.reply.mock.calls.length - 1];
      expect(last[1]).toMatch(/how much/i);
      const flat = last[2]?.keyboard?.inline_keyboard?.flat().map((b: any) => b.callback_data) ?? [];
      expect(flat).toContain('wd:p50');
      expect(flat).toContain('wd:custom');
      expect(h.handlers.pendingFor(7)?.kind).toBe('withdraw_amount_entry');
    } finally { h.state.close(); rmSync(h.dir, { recursive: true, force: true }); }
  });

  it('handleWithdraw <amount> prompt uses cancelKeyboard', async () => {
    const h = buildHarness();
    try {
      await enrollFully(h, 7);
      h.store.setWhitelist({ telegramId: 7, address: 'A'.repeat(44), now: 1, cooldownActive: false });
      h.navProvider.totalUsd = 100; h.navProvider.totalShares = 50;
      h.store.creditShares({ telegramId: 7, netShares: 25, event: 'deposit_credit', navSnapshotId: 1, inboundTxSig: null });
      await h.handlers.handleWithdraw({ chatId: 5, userId: 7, text: '/withdraw 50%' });
      const last = h.reply.mock.calls[h.reply.mock.calls.length - 1];
      const flat = last[2]?.keyboard?.inline_keyboard?.flat().map((b: any) => b.callback_data) ?? [];
      expect(flat).toEqual(['cancel']);
    } finally { h.state.close(); rmSync(h.dir, { recursive: true, force: true }); }
  });

  it('handleSetWhitelist prompt uses cancelKeyboard', async () => {
    const h = buildHarness();
    try {
      await enrollFully(h, 7);
      await h.handlers.handleSetWhitelist({ chatId: 5, userId: 7, text: '/setwhitelist' });
      const last = h.reply.mock.calls[h.reply.mock.calls.length - 1];
      const flat = last[2]?.keyboard?.inline_keyboard?.flat().map((b: any) => b.callback_data) ?? [];
      expect(flat).toEqual(['cancel']);
    } finally { h.state.close(); rmSync(h.dir, { recursive: true, force: true }); }
  });

  it('handleCancelWhitelist prompt uses cancelKeyboard', async () => {
    const h = buildHarness();
    try {
      await enrollFully(h, 7);
      h.store.setWhitelist({ telegramId: 7, address: 'A'.repeat(44), now: 1, cooldownActive: false });
      await h.handlers.handleCancelWhitelist({ chatId: 5, userId: 7 });
      const last = h.reply.mock.calls[h.reply.mock.calls.length - 1];
      const flat = last[2]?.keyboard?.inline_keyboard?.flat().map((b: any) => b.callback_data) ?? [];
      expect(flat).toEqual(['cancel']);
    } finally { h.state.close(); rmSync(h.dir, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Update `handleWithdraw`**

When `!raw` (no argument) at the current line ~458, change behavior: instead of replying with the usage string, reply with the amount picker and set pending to `withdraw_amount_entry`:

```typescript
if (!raw) {
  this.pending.set(msg.userId, { kind: 'withdraw_amount_entry' });
  await this.deps.reply(msg.chatId, 'How much to withdraw?', { keyboard: withdrawAmountKeyboard() });
  return;
}
```

Keep the existing parsed-arg branch behavior. At the success prompt (where the `withdraw` pending is set and the user is asked for the TOTP code), attach `cancelKeyboard()`.

- [ ] **Step 3: Update `respondWithdraw` success reply**

```typescript
await this.deps.reply(
  msg.chatId,
  '✅ Withdrawal queued.',
  { keyboard: postActionKeyboard() },
);
```

Failures → `errorKeyboard({ retryCallback: 'act:withdraw' })`.

- [ ] **Step 4: Update `handleSetWhitelist` / `respondSetWhitelist` / `handleCancelWhitelist` / `respondCancelWhitelist` symmetrically**

Prompts → `cancelKeyboard()`. Success → `postActionKeyboard()`. Errors → `errorKeyboard({ retryCallback: 'wl:set' or 'wl:cancel' })`.

- [ ] **Step 5: Run, verify pass**

Run: `pnpm vitest run tests/vault/commands.test.ts`

- [ ] **Step 6: Commit**

```bash
git add src/vault/commands.ts tests/vault/commands.test.ts
git commit -m "feat(ui): withdraw + whitelist flow keyboards (incl. amount picker)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: `uiCallbacks.ts` — `routeCallback` dispatcher

**Files:**
- Create: `src/vault/uiCallbacks.ts`
- Test: `tests/vault/uiCallbacks.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { makeCallbackRouter } from '../../src/vault/uiCallbacks.js';

function makeMockHandlers() {
  return {
    handleMenu:            vi.fn(async () => {}),
    handleAccount:         vi.fn(async () => {}),
    handleAccept:          vi.fn(async () => {}),
    handleDecline:         vi.fn(async () => {}),
    handleDeposit:         vi.fn(async () => {}),
    handleBalance:         vi.fn(async () => {}),
    handleWithdraw:        vi.fn(async () => {}),
    handleSetWhitelist:    vi.fn(async () => {}),
    handleCancelWhitelist: vi.fn(async () => {}),
    handleStats:           vi.fn(async () => {}),
    // internal setters for pending-action shortcuts
    setPending:            vi.fn(() => {}),
    clearPending:          vi.fn(() => {}),
  };
}

function makeMockReply() { return vi.fn(async () => {}); }

describe('uiCallbacks — routeCallback', () => {
  it('nav:home → handleMenu', async () => {
    const h = makeMockHandlers(); const reply = makeMockReply();
    const route = makeCallbackRouter({ handlers: h as any, reply });
    await route({ id: 'q', userId: 1, chatId: 2, data: 'nav:home' });
    expect(h.handleMenu).toHaveBeenCalledWith({ chatId: 2, userId: 1 });
  });

  it('nav:create_account → handleAccount', async () => {
    const h = makeMockHandlers(); const reply = makeMockReply();
    const route = makeCallbackRouter({ handlers: h as any, reply });
    await route({ id: 'q', userId: 1, chatId: 2, data: 'nav:create_account' });
    expect(h.handleAccount).toHaveBeenCalledWith({ chatId: 2, userId: 1 });
  });

  it('enr:accept → handleAccept', async () => {
    const h = makeMockHandlers(); const reply = makeMockReply();
    const route = makeCallbackRouter({ handlers: h as any, reply });
    await route({ id: 'q', userId: 1, chatId: 2, data: 'enr:accept' });
    expect(h.handleAccept).toHaveBeenCalledWith({ chatId: 2, userId: 1 });
  });

  it('act:deposit → handleDeposit', async () => {
    const h = makeMockHandlers(); const reply = makeMockReply();
    const route = makeCallbackRouter({ handlers: h as any, reply });
    await route({ id: 'q', userId: 1, chatId: 2, data: 'act:deposit' });
    expect(h.handleDeposit).toHaveBeenCalledWith({ chatId: 2, userId: 1 });
  });
  it('act:balance → handleBalance', async () => {
    const h = makeMockHandlers(); const reply = makeMockReply();
    const route = makeCallbackRouter({ handlers: h as any, reply });
    await route({ id: 'q', userId: 1, chatId: 2, data: 'act:balance' });
    expect(h.handleBalance).toHaveBeenCalledWith({ chatId: 2, userId: 1 });
  });
  it('act:stats → handleStats', async () => {
    const h = makeMockHandlers(); const reply = makeMockReply();
    const route = makeCallbackRouter({ handlers: h as any, reply });
    await route({ id: 'q', userId: 1, chatId: 2, data: 'act:stats' });
    expect(h.handleStats).toHaveBeenCalledWith({ chatId: 2 });
  });

  it('act:withdraw → handleWithdraw with empty text (triggers amount picker)', async () => {
    const h = makeMockHandlers(); const reply = makeMockReply();
    const route = makeCallbackRouter({ handlers: h as any, reply });
    await route({ id: 'q', userId: 1, chatId: 2, data: 'act:withdraw' });
    expect(h.handleWithdraw).toHaveBeenCalledWith({ chatId: 2, userId: 1, text: '/withdraw' });
  });

  it('wd:p50 → handleWithdraw("/withdraw 50%")', async () => {
    const h = makeMockHandlers(); const reply = makeMockReply();
    const route = makeCallbackRouter({ handlers: h as any, reply });
    await route({ id: 'q', userId: 1, chatId: 2, data: 'wd:p50' });
    expect(h.handleWithdraw).toHaveBeenCalledWith({ chatId: 2, userId: 1, text: '/withdraw 50%' });
  });

  it('wd:custom → setPending(withdraw_amount_entry) + reply prompt', async () => {
    const h = makeMockHandlers(); const reply = makeMockReply();
    const route = makeCallbackRouter({ handlers: h as any, reply });
    await route({ id: 'q', userId: 1, chatId: 2, data: 'wd:custom' });
    expect(h.setPending).toHaveBeenCalledWith(1, { kind: 'withdraw_amount_entry' });
    expect(reply).toHaveBeenCalledWith(2, expect.stringMatching(/USD amount/i), expect.anything());
  });

  it('wl:set → handleSetWhitelist with empty arg', async () => {
    const h = makeMockHandlers(); const reply = makeMockReply();
    const route = makeCallbackRouter({ handlers: h as any, reply });
    await route({ id: 'q', userId: 1, chatId: 2, data: 'wl:set' });
    expect(h.handleSetWhitelist).toHaveBeenCalledWith({ chatId: 2, userId: 1, text: '/setwhitelist' });
  });

  it('nav:settings → reply with settings keyboard', async () => {
    const h = makeMockHandlers(); const reply = makeMockReply();
    const route = makeCallbackRouter({ handlers: h as any, reply });
    await route({ id: 'q', userId: 1, chatId: 2, data: 'nav:settings' });
    expect(reply).toHaveBeenCalled();
    expect(reply.mock.calls[0][2].keyboard.inline_keyboard.flat().map((b: any) => b.callback_data))
      .toEqual(['wl:set', 'wl:cancel', 'nav:home']);
  });

  it('cancel → clearPending + reply "Cancelled"', async () => {
    const h = makeMockHandlers(); const reply = makeMockReply();
    const route = makeCallbackRouter({ handlers: h as any, reply });
    await route({ id: 'q', userId: 1, chatId: 2, data: 'cancel' });
    expect(h.clearPending).toHaveBeenCalledWith(1);
    expect(reply).toHaveBeenCalled();
  });

  it('unknown callback_data → no-op (no handler called, no throw)', async () => {
    const h = makeMockHandlers(); const reply = makeMockReply();
    const route = makeCallbackRouter({ handlers: h as any, reply });
    await expect(route({ id: 'q', userId: 1, chatId: 2, data: 'totally-bogus' })).resolves.toBeUndefined();
    expect(h.handleMenu).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Expose `setPending`/`clearPending` on `CommandHandlers`**

Add these tiny public methods to `CommandHandlers`:

```typescript
setPending(userId: number, action: PendingAction): void { this.pending.set(userId, action); }
clearPending(userId: number): void { this.pending.delete(userId); }
```

(Lines adjacent to `pendingFor` — these two are used by the router.)

- [ ] **Step 3: Implement `src/vault/uiCallbacks.ts`**

```typescript
import type { CommandHandlers } from './commands.js';
import type { ReplyFn } from './commands.js';
import { settingsKeyboard, cancelKeyboard, postActionKeyboard } from './uiKeyboards.js';

interface RouterDeps {
  handlers: Pick<
    CommandHandlers,
    | 'handleMenu' | 'handleAccount' | 'handleAccept' | 'handleDecline'
    | 'handleDeposit' | 'handleBalance' | 'handleStats'
    | 'handleWithdraw' | 'handleSetWhitelist' | 'handleCancelWhitelist'
    | 'setPending' | 'clearPending'
  >;
  reply: ReplyFn;
}

export function makeCallbackRouter(deps: RouterDeps) {
  return async function route(q: { id: string; userId: number; chatId: number; data: string }): Promise<void> {
    const { handlers, reply } = deps;
    const ctx = { chatId: q.chatId, userId: q.userId };
    switch (q.data) {
      case 'nav:home':          return handlers.handleMenu(ctx);
      case 'nav:create_account':return handlers.handleAccount(ctx);
      case 'nav:settings':
        await reply(q.chatId, 'Settings', { keyboard: settingsKeyboard() });
        return;

      case 'enr:accept':        return handlers.handleAccept(ctx);
      case 'enr:decline':       return handlers.handleDecline(ctx);

      case 'act:deposit':       return handlers.handleDeposit(ctx);
      case 'act:balance':       return handlers.handleBalance(ctx);
      case 'act:stats':         return handlers.handleStats({ chatId: q.chatId });
      case 'act:withdraw':      return handlers.handleWithdraw({ ...ctx, text: '/withdraw' });

      case 'wd:p25':            return handlers.handleWithdraw({ ...ctx, text: '/withdraw 25%' });
      case 'wd:p50':            return handlers.handleWithdraw({ ...ctx, text: '/withdraw 50%' });
      case 'wd:p75':            return handlers.handleWithdraw({ ...ctx, text: '/withdraw 75%' });
      case 'wd:p100':           return handlers.handleWithdraw({ ...ctx, text: '/withdraw 100%' });
      case 'wd:custom':
        handlers.setPending(q.userId, { kind: 'withdraw_amount_entry' });
        await reply(q.chatId, 'Reply with a USD amount (e.g., 25).', { keyboard: cancelKeyboard() });
        return;

      case 'wl:set':            return handlers.handleSetWhitelist({ ...ctx, text: '/setwhitelist' });
      case 'wl:cancel':         return handlers.handleCancelWhitelist(ctx);

      case 'cancel':
        handlers.clearPending(q.userId);
        await reply(q.chatId, 'Cancelled.', { keyboard: postActionKeyboard() });
        return;

      default:
        // unknown — no-op; TelegramCommander.dispatchCallback already calls answerCallbackQuery
        return;
    }
  };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm vitest run tests/vault/uiCallbacks.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/vault/uiCallbacks.ts src/vault/commands.ts tests/vault/uiCallbacks.test.ts
git commit -m "feat(ui): uiCallbacks.routeCallback — maps callback_data to CommandHandlers

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Wire `/menu` command + callback router in `main.ts`

**Files:**
- Modify: `src/main.ts:461-470` (vault command registrations)

- [ ] **Step 1: Register `/menu` command**

Inside the `if (cfg.vault?.enabled) { … }` vault-wiring block, after the `registerVaultCommand('cancelwhitelist', …)` line, add:

```typescript
tgCmd.registerVaultCommand('menu', (msg) => handlers.handleMenu(msg));
// Public /menu for non-depositors (welcome screen)
tgCmd.registerEnrollmentCommand('menu', (msg) => handlers.handleMenu(msg));
```

(Enrollment-kind registration lets non-enrolled users also reach the welcome screen.)

- [ ] **Step 2: Wire the callback router conditional on `uiButtons`**

Inside the same block, after handlers are constructed, add:

```typescript
if (cfg.vault.uiButtons) {
  const router = makeCallbackRouter({
    handlers,
    reply: (chatId, text, extras) => tgCmd.reply(chatId, text, extras),
  });
  tgCmd.setCallbackRouter((q) => router(q));
}
```

Import at the top of `main.ts`: `import { makeCallbackRouter } from './vault/uiCallbacks.js';`.

- [ ] **Step 3: Build + tsc + test**

```bash
pnpm build
pnpm tsc --noEmit
pnpm vitest run
```

Expected: all green, tsc clean.

- [ ] **Step 4: Commit**

```bash
git add src/main.ts
git commit -m "feat(ui): register /menu + wire callback router when vault.uiButtons on

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: End-to-end integration test — button tap to queued withdrawal

**Files:**
- Create: `tests/vault/uiIntegration.test.ts`

- [ ] **Step 1: Write the integration test**

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TelegramCommander } from '../../src/telegramCommander.js';
import { CommandHandlers } from '../../src/vault/commands.js';
import { StateStore } from '../../src/stateStore.js';
import { DepositorStore } from '../../src/vault/depositorStore.js';
import { Enrollment } from '../../src/vault/enrollment.js';
import { Cooldowns } from '../../src/vault/cooldowns.js';
import { makeCallbackRouter } from '../../src/vault/uiCallbacks.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MASTER_KEY = Buffer.alloc(32, 42);

describe('UI integration — button flow → queued withdrawal', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bertmm-ui-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('tap [50%] on enrolled user with whitelist + balance → TOTP prompt, reply consumes, withdrawal queued', async () => {
    // set up full stack
    const state = new StateStore(join(dir, 'state.db'));
    state.init();
    const store = new DepositorStore(state);
    const enrollment = new Enrollment({ store, masterKey: MASTER_KEY, ensureAta: async () => {} });
    const cooldowns = new Cooldowns({ store, cooldownMs: 24 * 3600 * 1000 });

    // outbound reply capture
    const sends: any[] = [];
    const reply = vi.fn(async (chatId: number, text: string, extras?: any) => {
      sends.push({ chatId, text, extras });
    });

    const handlers = new CommandHandlers({
      store, enrollment, cooldowns, masterKey: MASTER_KEY, reply,
      config: { withdrawalFeeBps: 30, minWithdrawalUsd: 10, maxDailyWithdrawalsPerUser: 3, maxDailyWithdrawalUsdPerUser: 1000, maxPendingWithdrawals: 20 },
      getNav: async () => ({ totalUsd: 100, totalShares: 50 }),
      nowMs: () => Date.now(),
    });
    const route = makeCallbackRouter({ handlers, reply });

    // enroll user + set whitelist + credit shares
    await enrollment.accept({ telegramId: 7, now: 100 });
    const { secretBase32 } = await enrollment.beginTotpEnrollment({ telegramId: 7 });
    const { TOTP } = await import('otpauth');
    const code1 = new TOTP({ secret: secretBase32 }).generate();
    await enrollment.confirmTotp({ telegramId: 7, code: code1, now: 101 });
    store.setWhitelist({ telegramId: 7, address: 'A'.repeat(44), now: 200, cooldownActive: false });
    store.creditShares({ telegramId: 7, netShares: 25, event: 'deposit_credit', navSnapshotId: 1, inboundTxSig: null });

    // user taps [50%]
    await route({ id: 'q1', userId: 7, chatId: 5, data: 'wd:p50' });
    // should have received a confirm prompt with cancelKeyboard
    const confirm = sends[sends.length - 1];
    expect(confirm.text).toMatch(/6-digit code/i);

    // user replies with fresh TOTP code
    const stepMs = 30_000;
    const realNow = Date.now.bind(Date);
    const restore = () => { Date.now = realNow; };
    try {
      const start = realNow();
      Date.now = () => realNow() + (stepMs - (start % stepMs)) + 1_000;
      const code2 = new TOTP({ secret: secretBase32 }).generate();
      await handlers.handleMessage({ chatId: 5, userId: 7, text: code2 });
    } finally { restore(); }

    // withdrawal should be queued in the store
    const queue = store.listWithdrawalsByStatus('pending');
    expect(queue.length).toBeGreaterThanOrEqual(1);
    expect(queue[0].amountUsd).toBeCloseTo(50, 1);

    state.close();
  });
});
```

The `DepositorStore.listWithdrawalsByStatus(status)` accessor is already in `src/vault/depositorStore.ts:224` and returns `VaultWithdrawal[]`.

- [ ] **Step 2: Run, verify pass**

Run: `pnpm vitest run tests/vault/uiIntegration.test.ts`
Expected: PASS. If it fails, debug the reply sequence (log `sends`) to verify the flow.

- [ ] **Step 3: Commit**

```bash
git add tests/vault/uiIntegration.test.ts
git commit -m "test(ui): integration — button tap to queued withdrawal

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: Final verification — build + full test + typecheck

- [ ] **Step 1: Run the full test suite**

```bash
cd /opt/bert-mm-bot/.worktrees/telegram-ui
pnpm vitest run
```

Expected: all tests PASS. Target count: 243 preexisting + ≈30 new ≈ 270+ total.

- [ ] **Step 2: Typecheck**

```bash
pnpm tsc --noEmit
```

Expected: no output.

- [ ] **Step 3: Build**

```bash
pnpm build
```

Expected: clean; new files in `dist/vault/`.

- [ ] **Step 4: Confirm disk state**

Run: `git status` — should be clean.
Run: `git log --oneline main..HEAD | wc -l` — should be ≈ 13 new commits on top of `feature/vault-v1`.

- [ ] **Step 5: If anything fails**

Fix inline, re-run, add a follow-up commit. Do NOT mark this task complete until all three (test, tsc, build) succeed.

---

## Task 14: Update `CLAUDE.md` with UI-toggle doc + ship

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add a section to `CLAUDE.md`**

Insert after the "Notifications" section:

```markdown
## Telegram depositor UI (`vault.uiButtons`)

When `vault.uiButtons: true` (default), depositor flows present inline-keyboard
buttons alongside the typed commands. Button taps fire `callback_query` events
routed through `src/vault/uiCallbacks.ts` → `CommandHandlers` (same methods
typed commands invoke; TOTP gating and rate limiter unchanged). The `/menu`
command renders the main keyboard; typed commands still work.

Set `vault.uiButtons: false` to disable buttons (commands still work, but no
`callback_query` updates are polled and no `reply_markup` is attached).
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document vault.uiButtons flag in CLAUDE.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 3: Branch-state sanity**

```bash
git -C /opt/bert-mm-bot log --oneline feature/vault-v1..feature/telegram-ui
```

You should see ≈ 14 commits (one per task).

- [ ] **Step 4: Hand-off to operator**

At this point the branch is ready to merge. The operator can:
1. `git -C /opt/bert-mm-bot merge --ff-only feature/telegram-ui` (on top of vault-v1) — or merge via PR.
2. Rebuild + restart.
3. Verify with a test depositor that buttons appear after `/menu`.
4. To roll back UI only: set `vault.uiButtons: false` in `/etc/bert-mm-bot/config.yaml` + restart.

No new secrets, no schema change, no RPC impact, no SOL cost.

---

## Appendix — Design → Task coverage map

| Spec section | Covered by |
|---|---|
| §1 Goals | Tasks 1–14 |
| §4 Architecture | Tasks 2, 3, 6, 10 |
| §5 Touched/new files | All tasks |
| §6 `callback_data` schema | Tasks 2, 3, 10 |
| §7.1 Enrollment flow | Task 9a |
| §7.2 Deposit | Task 9b |
| §7.3 Balance + withdraw | Tasks 9b, 9c |
| §7.4 Set whitelist | Task 9c |
| §7.5 Main menu | Tasks 8, 11 |
| §7.6 Stats | Task 9b |
| §7.7 Contextual tails | Tasks 3, 9a–9c |
| §8 Error handling | Tasks 3 (errorKeyboard), 6 (unknown/stale), 9 (per-reply) |
| §9 Testing | All tasks; Task 12 E2E |
| §10 Deployment | Task 14 |
| §11 Risks | Task 6 handles stale/unknown; Task 14 rollback |
| §12 Acceptance criteria | Task 13 |
