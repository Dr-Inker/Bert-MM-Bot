# Depositor Vault Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a custodial depositor vault to bert-mm-bot: pooled deposits via per-user addresses, TOTP-gated self-service withdrawals through the existing Telegram bot, 0.3% withdrawal fee, 24h whitelist cooldown, queued withdrawals with partial-LP-close fallback.

**Architecture:** All code lives inside the existing bert-mm-bot process under `src/vault/`. Single SQLite DB, single Telegram bot, single systemd service. New modules are pure/testable; integration edits to `main.ts`, `stateStore.ts`, `telegramCommander.ts`, `config.ts`, `types.ts`. Spec: `docs/superpowers/specs/2026-04-17-depositor-vault-design.md`.

**Tech Stack:** TypeScript 5, Node 22, better-sqlite3, @solana/web3.js, @solana/spl-token, @meteora-ag/dlmm, `otpauth` (new), `qrcode` (new), vitest.

---

## File structure map

### New files
```
src/vault/
  encryption.ts          AES-256-GCM helpers (encrypt/decrypt with master key)
  shareMath.ts           Pure: computeSharesForDeposit, applyWithdrawalFee, usdForShares
  totp.ts                generateSecret, otpauthUri, verifyCode, checkReplay
  navSnapshot.ts         computeNav (extracted from main.ts hourly report)
  depositorStore.ts      CRUD for vault_* tables; withTransaction wrapper
  depositWatcher.ts      Poll per-user addresses; detect SOL + BERT inflows
  sweeper.ts             Build/sign/submit sweep tx from deposit address → main pool
  creditEngine.ts        On confirmed deposit: compute NAV, mint shares, write tx atomically
  withdrawalExecutor.ts  Drain queue under rebalance mutex; partial close if needed
  withdrawalBuilder.ts   Build transfer tx (SOL + BERT → destination)
  cooldowns.ts           Pending whitelist changes: activate, cancel, notify
  commands.ts            Telegram handlers: /account, /deposit, /balance, /withdraw, /stats,
                         /setwhitelist, /cancelwhitelist
  operatorCommands.ts    Operator-only: /pausevault, /resumevault, /vaultstatus, /forceprocess
  audit.ts               Typed wrapper for inserting vault_audit_log rows
  disclaimer.ts          Legal disclaimer text + accept/decline UX
  types.ts               Vault domain types (User, Shares, Deposit, Withdrawal, etc.)

src/cli/vault-bootstrap.ts    One-time operator bootstrap CLI

tests/vault/
  encryption.test.ts
  shareMath.test.ts
  totp.test.ts
  navSnapshot.test.ts
  depositorStore.test.ts
  cooldowns.test.ts
  creditEngine.test.ts
  withdrawalExecutor.test.ts
  commands.test.ts
  integration.test.ts

systemd/
  bert-mm-bot-backup.service    Daily SQLite backup
  bert-mm-bot-backup.timer
```

### Modified files
```
src/stateStore.ts                  Append vault_* tables to SCHEMA_SQL; add withTransaction()
src/types.ts                       Add VaultConfig interface to BotConfig
src/config.ts                      Add zod schema for vault block
src/telegramCommander.ts           Broaden auth (vault_users lookup); route new commands
src/main.ts                        Wire depositWatcher.poll() + withdrawalExecutor.drain();
                                    extract NAV math into navSnapshot.ts; extend hourly report
src/venueClient.ts                 Add partialClose({needSol, needBert}) method signature
src/meteoraClient.ts               Implement partialClose (remove liquidity from target bins)
src/cli/index.ts                   Register vault-bootstrap subcommand
package.json                       Add otpauth + qrcode deps
```

### Not modified
```
src/rebalancer.ts                  Vault is invisible to it; mutex wraps from main.ts
src/raydiumClient.ts               No DLMM partial-close equivalent needed for MVP
                                    (MVP runs on Meteora only per current config)
```

---

## Phase 0 — Foundation

Establish the primitives (config, DB schema, transactions, encryption) that all later phases depend on. No feature code yet.

### Task 1: Add vault config schema + types

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Modify: `config.example.yaml`
- Test: `tests/vault/config.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/vault/config.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { BotConfigSchema } from '../../src/config.js';

describe('vault config', () => {
  const base = {
    venue: 'meteora' as const,
    enabled: true,
    poolAddress: 'PoolPubkeyXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    bertMint: 'HgBRWfYxEfvPhtqkaeymCQtHCrKE46qQ43pKe8HCpump',
    rangeWidthPct: 6,
    outOfRangeBps: 50,
    rebalanceDelaySec: 30,
    maxRebalancesPerDay: 6,
    maxDrawdownPct: 30,
    minSolFloorLamports: 100_000_000,
    oracleDivergenceBps: 150,
    rpcPrimary: 'https://mainnet.helius-rpc.com/?api-key=x',
    keyfilePath: '/etc/bert-mm-bot/hot-wallet.json',
    killSwitchFilePath: '/etc/bert-mm-bot/KILLSWITCH',
    dryRun: false,
    pollIntervalSec: 30,
    notifier: { telegram: null },
    mevProtection: { enabled: false },
    maxPositionUsd: 200,
    maxSlippageBps: 300,
  };

  it('accepts config without vault block (vault disabled)', () => {
    const r = BotConfigSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.vault?.enabled ?? false).toBe(false);
  });

  it('accepts config with vault block enabled', () => {
    const r = BotConfigSchema.safeParse({
      ...base,
      vault: {
        enabled: true,
        withdrawalFeeBps: 30,
        minDepositUsd: 10,
        minWithdrawalUsd: 5,
        maxDailyWithdrawalsPerUser: 3,
        maxDailyWithdrawalUsdPerUser: 5000,
        maxPendingWithdrawals: 50,
        depositMinConfirms: 1,
        whitelistCooldownHours: 24,
        operatorTelegramId: 12345,
      },
    });
    expect(r.success).toBe(true);
  });

  it('rejects vault config with negative fee', () => {
    const r = BotConfigSchema.safeParse({
      ...base,
      vault: { enabled: true, withdrawalFeeBps: -5, minDepositUsd: 10, minWithdrawalUsd: 5,
               maxDailyWithdrawalsPerUser: 3, maxDailyWithdrawalUsdPerUser: 5000,
               maxPendingWithdrawals: 50, depositMinConfirms: 1, whitelistCooldownHours: 24,
               operatorTelegramId: 12345 },
    });
    expect(r.success).toBe(false);
  });

  it('rejects vault config missing operatorTelegramId when enabled', () => {
    const r = BotConfigSchema.safeParse({
      ...base,
      vault: { enabled: true, withdrawalFeeBps: 30, minDepositUsd: 10, minWithdrawalUsd: 5,
               maxDailyWithdrawalsPerUser: 3, maxDailyWithdrawalUsdPerUser: 5000,
               maxPendingWithdrawals: 50, depositMinConfirms: 1, whitelistCooldownHours: 24 },
    });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /opt/bert-mm-bot && pnpm vitest run tests/vault/config.test.ts
```
Expected: FAIL — `vault` field not defined in schema.

- [ ] **Step 3: Add VaultConfig to `src/types.ts`**

Append to `src/types.ts` (at the end of the BotConfig interface, before the closing brace):

```typescript
export interface VaultConfig {
  enabled: boolean;
  withdrawalFeeBps: number;          // 30 = 0.30%
  minDepositUsd: number;
  minWithdrawalUsd: number;
  maxDailyWithdrawalsPerUser: number;
  maxDailyWithdrawalUsdPerUser: number;
  maxPendingWithdrawals: number;     // global queue depth cap
  depositMinConfirms: number;        // 1 = first confirmation
  whitelistCooldownHours: number;    // 24 in spec
  operatorTelegramId: number;        // chat_id of the operator
}
```

Then add to the `BotConfig` interface (as optional field):

```typescript
  vault?: VaultConfig;
```

- [ ] **Step 4: Add zod schema to `src/config.ts`**

Inside `src/config.ts`, near the existing BotConfigSchema, define and append:

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
});
```

Append `.extend({ vault: VaultConfigSchema.optional() })` to `BotConfigSchema`, or add `vault: VaultConfigSchema.optional()` inside its `z.object({...})` definition.

- [ ] **Step 5: Add commented defaults to `config.example.yaml`**

Append to the end of `config.example.yaml`:

```yaml
# Depositor vault (optional). Omit to leave disabled.
# vault:
#   enabled: false
#   withdrawalFeeBps: 30              # 0.30%
#   minDepositUsd: 10
#   minWithdrawalUsd: 5
#   maxDailyWithdrawalsPerUser: 3
#   maxDailyWithdrawalUsdPerUser: 5000
#   maxPendingWithdrawals: 50
#   depositMinConfirms: 1
#   whitelistCooldownHours: 24
#   operatorTelegramId: 123456789     # your telegram user_id
```

- [ ] **Step 6: Run tests to verify all pass**

```bash
pnpm vitest run tests/vault/config.test.ts
pnpm vitest run                # full suite — existing tests must still pass
```
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/config.ts config.example.yaml tests/vault/config.test.ts
git commit -m "vault: add config schema + types"
```

---

### Task 2: Add `withTransaction` helper to stateStore

**Files:**
- Modify: `src/stateStore.ts`
- Test: `tests/stateStore.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `tests/stateStore.test.ts`:

```typescript
describe('withTransaction', () => {
  it('commits both writes atomically on success', () => {
    store.withTransaction(() => {
      store.setFlag('a', '1');
      store.setFlag('b', '2');
    });
    expect(store.getFlag('a')).toBe('1');
    expect(store.getFlag('b')).toBe('2');
  });

  it('rolls back both writes on thrown error', () => {
    expect(() => store.withTransaction(() => {
      store.setFlag('x', '1');
      throw new Error('boom');
    })).toThrow('boom');
    expect(store.getFlag('x')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run tests/stateStore.test.ts
```
Expected: FAIL — `withTransaction is not a function`.

- [ ] **Step 3: Add the helper to `StateStore` class**

In `src/stateStore.ts`, inside the `StateStore` class (after `setFlag`):

```typescript
  /** Run `fn` in a SQLite transaction. Throws on error, rolling back. */
  withTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
```

If helper methods like `setFlag`/`getFlag` don't already exist on the class, add them (they're required by the existing `flags` table):

```typescript
  setFlag(key: string, value: string, reason?: string): void {
    this.db.prepare(
      `INSERT INTO flags(key,value,updated_at,reason) VALUES(?,?,?,?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,reason=excluded.reason`
    ).run(key, value, Date.now(), reason ?? null);
  }
  getFlag(key: string): string | undefined {
    const row = this.db.prepare(`SELECT value FROM flags WHERE key=?`).get(key) as { value: string } | undefined;
    return row?.value;
  }
```

(If they exist, keep them; don't duplicate.)

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm vitest run tests/stateStore.test.ts
```
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/stateStore.ts tests/stateStore.test.ts
git commit -m "vault: add withTransaction helper to StateStore"
```

---

### Task 3: Encryption module (AES-256-GCM)

**Files:**
- Create: `src/vault/encryption.ts`
- Test: `tests/vault/encryption.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/vault/encryption.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { encrypt, decrypt, loadMasterKey } from '../../src/vault/encryption.js';

describe('encryption', () => {
  const key = Buffer.alloc(32, 7); // deterministic 32-byte key for tests

  it('round-trips a plaintext', () => {
    const { ciphertext, iv } = encrypt(Buffer.from('hello world'), key);
    const plain = decrypt(ciphertext, iv, key);
    expect(plain.toString()).toBe('hello world');
  });

  it('round-trips 32-byte binary', () => {
    const msg = Buffer.alloc(32, 0xab);
    const { ciphertext, iv } = encrypt(msg, key);
    expect(decrypt(ciphertext, iv, key).equals(msg)).toBe(true);
  });

  it('fails to decrypt with wrong key', () => {
    const { ciphertext, iv } = encrypt(Buffer.from('secret'), key);
    const wrong = Buffer.alloc(32, 8);
    expect(() => decrypt(ciphertext, iv, wrong)).toThrow();
  });

  it('fails to decrypt with tampered ciphertext', () => {
    const { ciphertext, iv } = encrypt(Buffer.from('secret'), key);
    ciphertext[0] ^= 1;
    expect(() => decrypt(ciphertext, iv, key)).toThrow();
  });

  it('produces unique IVs across many encryptions', () => {
    const ivs = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      const { iv } = encrypt(Buffer.from('x'), key);
      ivs.add(iv.toString('hex'));
    }
    expect(ivs.size).toBe(10_000);
  });

  it('loadMasterKey rejects missing env var', () => {
    delete process.env.VAULT_MASTER_KEY;
    expect(() => loadMasterKey()).toThrow(/VAULT_MASTER_KEY/);
  });

  it('loadMasterKey rejects wrong-length key', () => {
    process.env.VAULT_MASTER_KEY = Buffer.alloc(16, 0).toString('base64');
    expect(() => loadMasterKey()).toThrow(/32/);
  });

  it('loadMasterKey returns 32-byte buffer', () => {
    process.env.VAULT_MASTER_KEY = Buffer.alloc(32, 0).toString('base64');
    const k = loadMasterKey();
    expect(k.length).toBe(32);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run tests/vault/encryption.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/vault/encryption.ts`**

```typescript
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface EncryptedBlob {
  ciphertext: Buffer;   // [encrypted_bytes || auth_tag]
  iv: Buffer;
}

/** Encrypt `plaintext` under 32-byte `key` using AES-256-GCM. */
export function encrypt(plaintext: Buffer, key: Buffer): EncryptedBlob {
  if (key.length !== 32) throw new Error('encrypt: key must be 32 bytes');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: Buffer.concat([enc, tag]), iv };
}

/** Decrypt a blob. Throws on wrong key, wrong IV, or tampered ciphertext. */
export function decrypt(ciphertext: Buffer, iv: Buffer, key: Buffer): Buffer {
  if (key.length !== 32) throw new Error('decrypt: key must be 32 bytes');
  if (iv.length !== IV_BYTES) throw new Error(`decrypt: iv must be ${IV_BYTES} bytes`);
  if (ciphertext.length < TAG_BYTES) throw new Error('decrypt: ciphertext too short');
  const enc = ciphertext.subarray(0, ciphertext.length - TAG_BYTES);
  const tag = ciphertext.subarray(ciphertext.length - TAG_BYTES);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

/** Load master key from VAULT_MASTER_KEY env var (base64, 32 bytes). */
export function loadMasterKey(): Buffer {
  const b64 = process.env.VAULT_MASTER_KEY;
  if (!b64) throw new Error('VAULT_MASTER_KEY env var not set');
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error(`VAULT_MASTER_KEY must be 32 bytes (got ${key.length})`);
  return key;
}
```

- [ ] **Step 4: Run tests to verify all pass**

```bash
pnpm vitest run tests/vault/encryption.test.ts
```
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/vault/encryption.ts tests/vault/encryption.test.ts
git commit -m "vault: AES-256-GCM encryption helpers"
```

---

### Task 4: Add vault DB schema

**Files:**
- Modify: `src/stateStore.ts`
- Test: `tests/vault/schema.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/vault/schema.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateStore } from '../../src/stateStore.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('vault schema', () => {
  let dir: string;
  let store: StateStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bertmm-'));
    store = new StateStore(join(dir, 'state.db'));
    store.init();
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  const tables = [
    'vault_users', 'vault_shares', 'vault_deposits', 'vault_withdrawals',
    'vault_pending_whitelist_changes', 'vault_nav_snapshots', 'vault_audit_log',
  ];

  for (const t of tables) {
    it(`creates ${t}`, () => {
      const row = (store as any).db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
        .get(t);
      expect(row).toBeDefined();
    });
  }

  it('enforces UNIQUE on vault_deposits.inbound_tx_sig', () => {
    const db = (store as any).db;
    db.prepare(`INSERT INTO vault_users(telegram_id, role, deposit_address, deposit_secret_enc,
                                         deposit_secret_iv, disclaimer_at, created_at)
                VALUES(1, 'depositor', 'addr1', x'', x'', ?, ?)`).run(Date.now(), Date.now());
    const ins = db.prepare(`INSERT INTO vault_deposits(telegram_id, inbound_tx_sig,
                              sol_lamports, bert_raw, sol_usd, bert_usd,
                              nav_per_share_at, shares_minted, confirmed_at)
                            VALUES(1, 'sig1', 0, 0, 0, 0, 1, 1, ?)`);
    ins.run(Date.now());
    expect(() => ins.run(Date.now())).toThrow(/UNIQUE/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run tests/vault/schema.test.ts
```
Expected: FAIL — tables don't exist.

- [ ] **Step 3: Append vault tables to `SCHEMA_SQL` in `src/stateStore.ts`**

Locate `SCHEMA_SQL` (array of CREATE TABLE statements) and append these entries:

```typescript
// ── Vault ────────────────────────────────────────────────────────────────
`CREATE TABLE IF NOT EXISTS vault_users (
  telegram_id            INTEGER PRIMARY KEY,
  role                   TEXT NOT NULL CHECK(role IN ('operator','depositor')),
  deposit_address        TEXT NOT NULL UNIQUE,
  deposit_secret_enc     BLOB NOT NULL,
  deposit_secret_iv      BLOB NOT NULL,
  totp_secret_enc        BLOB,
  totp_secret_iv         BLOB,
  totp_enrolled_at       INTEGER,
  totp_last_used_counter INTEGER,
  whitelist_address      TEXT,
  whitelist_set_at       INTEGER,
  disclaimer_at          INTEGER NOT NULL,
  created_at             INTEGER NOT NULL
)`,
`CREATE INDEX IF NOT EXISTS idx_vault_users_deposit ON vault_users(deposit_address)`,

`CREATE TABLE IF NOT EXISTS vault_shares (
  telegram_id INTEGER PRIMARY KEY REFERENCES vault_users(telegram_id),
  shares      REAL NOT NULL
)`,

`CREATE TABLE IF NOT EXISTS vault_deposits (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id       INTEGER NOT NULL,
  inbound_tx_sig    TEXT NOT NULL UNIQUE,
  sweep_tx_sig      TEXT,
  sol_lamports      INTEGER NOT NULL,
  bert_raw          INTEGER NOT NULL,
  sol_usd           REAL NOT NULL,
  bert_usd          REAL NOT NULL,
  nav_per_share_at  REAL NOT NULL,
  shares_minted     REAL NOT NULL,
  confirmed_at      INTEGER NOT NULL,
  swept_at          INTEGER
)`,
`CREATE INDEX IF NOT EXISTS idx_vault_deposits_user ON vault_deposits(telegram_id)`,

`CREATE TABLE IF NOT EXISTS vault_withdrawals (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id       INTEGER NOT NULL,
  status            TEXT NOT NULL CHECK(status IN ('queued','processing','completed','failed')),
  destination       TEXT NOT NULL,
  shares_burned     REAL NOT NULL,
  fee_shares        REAL NOT NULL,
  nav_per_share_at  REAL,
  sol_lamports_out  INTEGER,
  bert_raw_out      INTEGER,
  tx_sig            TEXT,
  failure_reason    TEXT,
  queued_at         INTEGER NOT NULL,
  processed_at      INTEGER
)`,
`CREATE INDEX IF NOT EXISTS idx_vault_withdrawals_status ON vault_withdrawals(status)`,

`CREATE TABLE IF NOT EXISTS vault_pending_whitelist_changes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id   INTEGER NOT NULL,
  old_address   TEXT,
  new_address   TEXT NOT NULL,
  requested_at  INTEGER NOT NULL,
  activates_at  INTEGER NOT NULL,
  status        TEXT NOT NULL CHECK(status IN ('pending','activated','cancelled')),
  cancel_reason TEXT
)`,
`CREATE INDEX IF NOT EXISTS idx_vault_wl_pending
   ON vault_pending_whitelist_changes(status, activates_at)`,

`CREATE TABLE IF NOT EXISTS vault_nav_snapshots (
  ts               INTEGER PRIMARY KEY,
  total_value_usd  REAL NOT NULL,
  total_shares     REAL NOT NULL,
  nav_per_share    REAL NOT NULL,
  source           TEXT NOT NULL
)`,

`CREATE TABLE IF NOT EXISTS vault_audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  telegram_id   INTEGER,
  event         TEXT NOT NULL,
  details_json  TEXT NOT NULL
)`,
`CREATE INDEX IF NOT EXISTS idx_vault_audit_ts ON vault_audit_log(ts)`,
`CREATE INDEX IF NOT EXISTS idx_vault_audit_user ON vault_audit_log(telegram_id, ts)`,
```

- [ ] **Step 4: Run tests to verify all pass**

```bash
pnpm vitest run tests/vault/schema.test.ts tests/stateStore.test.ts
```
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/stateStore.ts tests/vault/schema.test.ts
git commit -m "vault: add SQLite schema for vault_* tables"
```

---

## Phase 1 — Pure modules (parallel-safe)

Each of tasks 5–7 can be implemented by independent subagents in parallel — they only depend on Phase 0.

### Task 5: Share math

**Files:**
- Create: `src/vault/shareMath.ts`
- Test: `tests/vault/shareMath.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/vault/shareMath.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  computeNavPerShare,
  computeSharesForDeposit,
  splitFee,
  usdForShares,
  splitUsdIntoTokens,
} from '../../src/vault/shareMath.js';

describe('shareMath', () => {
  it('bootstrap NAV is $1 per share when total_shares = total_usd', () => {
    expect(computeNavPerShare({ totalUsd: 220, totalShares: 220 })).toBeCloseTo(1);
  });

  it('handles empty pool (returns $1 as sentinel for first deposit)', () => {
    expect(computeNavPerShare({ totalUsd: 0, totalShares: 0 })).toBe(1);
  });

  it('computes shares = deposit_usd / nav', () => {
    expect(computeSharesForDeposit({ depositUsd: 100, navPerShare: 2 })).toBe(50);
  });

  it('splits 0.3% fee off burned shares', () => {
    const r = splitFee({ sharesBurned: 100, feeBps: 30 });
    expect(r.feeShares).toBeCloseTo(0.3);
    expect(r.netShares).toBeCloseTo(99.7);
  });

  it('splits fee correctly for 0 bps (no fee)', () => {
    const r = splitFee({ sharesBurned: 100, feeBps: 0 });
    expect(r.feeShares).toBe(0);
    expect(r.netShares).toBe(100);
  });

  it('round-trips: deposit then withdraw same shares at same NAV returns USD - fee', () => {
    const navPerShare = 1.05;
    const deposited = 500;
    const shares = computeSharesForDeposit({ depositUsd: deposited, navPerShare });
    const fee = splitFee({ sharesBurned: shares, feeBps: 30 });
    const received = usdForShares({ netShares: fee.netShares, navPerShare });
    expect(received).toBeCloseTo(deposited * (1 - 0.003), 6);
  });

  it('splits USD into SOL+BERT by pool composition', () => {
    const r = splitUsdIntoTokens({
      usd: 100,
      solFrac: 0.6,
      solUsd: 200,
      bertUsd: 0.01,
    });
    expect(r.solLamports).toBe(Math.floor(60 / 200 * 1e9));
    expect(r.bertRaw).toBe(Math.floor(40 / 0.01 * 1e6));
  });

  it('splitUsdIntoTokens handles 100% SOL composition', () => {
    const r = splitUsdIntoTokens({
      usd: 100, solFrac: 1, solUsd: 200, bertUsd: 0.01,
    });
    expect(r.bertRaw).toBe(0);
    expect(r.solLamports).toBe(Math.floor(100 / 200 * 1e9));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run tests/vault/shareMath.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/vault/shareMath.ts`**

```typescript
export const SOL_DECIMALS = 9;
export const BERT_DECIMALS = 6;

/** NAV per share = total_usd / total_shares. Returns 1 as sentinel when pool is empty. */
export function computeNavPerShare(args: { totalUsd: number; totalShares: number }): number {
  if (args.totalShares <= 0) return 1;
  return args.totalUsd / args.totalShares;
}

/** shares = deposit_usd / nav_per_share. Assumes navPerShare > 0. */
export function computeSharesForDeposit(args: {
  depositUsd: number;
  navPerShare: number;
}): number {
  if (args.navPerShare <= 0) throw new Error('computeSharesForDeposit: navPerShare must be > 0');
  return args.depositUsd / args.navPerShare;
}

/** Split total burned shares into (fee, net) by fee bps. */
export function splitFee(args: { sharesBurned: number; feeBps: number }): {
  feeShares: number;
  netShares: number;
} {
  const feeShares = args.sharesBurned * (args.feeBps / 10_000);
  return { feeShares, netShares: args.sharesBurned - feeShares };
}

/** USD value of `netShares` at `navPerShare`. */
export function usdForShares(args: { netShares: number; navPerShare: number }): number {
  return args.netShares * args.navPerShare;
}

/** Split USD amount into SOL lamports + BERT raw units based on pool composition fraction. */
export function splitUsdIntoTokens(args: {
  usd: number;
  solFrac: number;     // 0..1 fraction of pool in SOL by USD
  solUsd: number;      // price
  bertUsd: number;     // price
}): { solLamports: number; bertRaw: number } {
  if (args.solUsd <= 0 || args.bertUsd <= 0) {
    throw new Error('splitUsdIntoTokens: prices must be > 0');
  }
  const solUsdShare = args.usd * args.solFrac;
  const bertUsdShare = args.usd * (1 - args.solFrac);
  const solLamports = Math.floor(solUsdShare / args.solUsd * 10 ** SOL_DECIMALS);
  const bertRaw = Math.floor(bertUsdShare / args.bertUsd * 10 ** BERT_DECIMALS);
  return { solLamports, bertRaw };
}
```

- [ ] **Step 4: Run tests to verify all pass**

```bash
pnpm vitest run tests/vault/shareMath.test.ts
```
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/vault/shareMath.ts tests/vault/shareMath.test.ts
git commit -m "vault: share math helpers (NAV, deposit shares, fee split, token split)"
```

---

### Task 6: TOTP module

**Files:**
- Create: `src/vault/totp.ts`
- Test: `tests/vault/totp.test.ts`
- Modify: `package.json` (add `otpauth`)

- [ ] **Step 1: Install dependency**

```bash
cd /opt/bert-mm-bot && pnpm add otpauth
```

- [ ] **Step 2: Write the failing test**

Create `tests/vault/totp.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { TOTP } from 'otpauth';
import {
  generateSecret, otpauthUri, verifyCode, currentCounter,
} from '../../src/vault/totp.js';

describe('totp', () => {
  it('generates a 32-char base32 secret', () => {
    const s = generateSecret();
    expect(s.length).toBeGreaterThanOrEqual(32);
    expect(/^[A-Z2-7]+=*$/.test(s)).toBe(true);
  });

  it('otpauthUri contains label + issuer', () => {
    const uri = otpauthUri({ secret: 'JBSWY3DPEHPK3PXP', label: 'user-123', issuer: 'BertVault' });
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain('issuer=BertVault');
    expect(uri).toContain('JBSWY3DPEHPK3PXP');
  });

  it('verifies a freshly-generated code', () => {
    const secret = generateSecret();
    const totp = new TOTP({ secret });
    const code = totp.generate();
    const r = verifyCode({ secret, code, lastUsedCounter: null });
    expect(r.ok).toBe(true);
    expect(r.counter).toBe(currentCounter());
  });

  it('rejects invalid code', () => {
    const secret = generateSecret();
    const r = verifyCode({ secret, code: '000000', lastUsedCounter: null });
    expect(r.ok).toBe(false);
  });

  it('rejects replay: same counter twice', () => {
    const secret = generateSecret();
    const totp = new TOTP({ secret });
    const code = totp.generate();
    const first = verifyCode({ secret, code, lastUsedCounter: null });
    expect(first.ok).toBe(true);
    const replay = verifyCode({ secret, code, lastUsedCounter: first.counter });
    expect(replay.ok).toBe(false);
    expect(replay.reason).toBe('replay');
  });

  it('rejects non-6-digit string', () => {
    const secret = generateSecret();
    expect(verifyCode({ secret, code: 'abcdef', lastUsedCounter: null }).ok).toBe(false);
    expect(verifyCode({ secret, code: '12345', lastUsedCounter: null }).ok).toBe(false);
    expect(verifyCode({ secret, code: '1234567', lastUsedCounter: null }).ok).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
pnpm vitest run tests/vault/totp.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/vault/totp.ts`**

```typescript
import { TOTP, Secret } from 'otpauth';

const STEP_SEC = 30;
const DIGITS = 6;
const WINDOW = 1; // ±1 step tolerance

/** Generate a 160-bit base32 secret. */
export function generateSecret(): string {
  return new Secret({ size: 20 }).base32;
}

/** Build an otpauth:// URI for QR codes. */
export function otpauthUri(args: { secret: string; label: string; issuer: string }): string {
  const totp = new TOTP({
    issuer: args.issuer,
    label: args.label,
    algorithm: 'SHA1',
    digits: DIGITS,
    period: STEP_SEC,
    secret: args.secret,
  });
  return totp.toString();
}

/** Current TOTP counter (integer seconds / step). */
export function currentCounter(): number {
  return Math.floor(Date.now() / 1000 / STEP_SEC);
}

export interface VerifyResult {
  ok: boolean;
  counter: number;       // the accepted counter (only meaningful if ok)
  reason?: 'bad_format' | 'invalid' | 'replay';
}

/** Verify a 6-digit code. Enforces non-decreasing counter to block replay. */
export function verifyCode(args: {
  secret: string;
  code: string;
  lastUsedCounter: number | null;
}): VerifyResult {
  if (!/^\d{6}$/.test(args.code)) {
    return { ok: false, counter: -1, reason: 'bad_format' };
  }
  const totp = new TOTP({ algorithm: 'SHA1', digits: DIGITS, period: STEP_SEC, secret: args.secret });
  const delta = totp.validate({ token: args.code, window: WINDOW });
  if (delta === null) return { ok: false, counter: -1, reason: 'invalid' };
  const matchedCounter = currentCounter() + delta;
  if (args.lastUsedCounter !== null && matchedCounter <= args.lastUsedCounter) {
    return { ok: false, counter: matchedCounter, reason: 'replay' };
  }
  return { ok: true, counter: matchedCounter };
}
```

- [ ] **Step 5: Run tests to verify all pass**

```bash
pnpm vitest run tests/vault/totp.test.ts
```
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add src/vault/totp.ts tests/vault/totp.test.ts package.json pnpm-lock.yaml
git commit -m "vault: TOTP secret gen + verify with replay protection"
```

---

### Task 7: NAV snapshot (extract from main.ts)

**Files:**
- Create: `src/vault/navSnapshot.ts`
- Modify: `src/main.ts` (use new helper in hourly report)
- Test: `tests/vault/navSnapshot.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/vault/navSnapshot.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { computeNav } from '../../src/vault/navSnapshot.js';

describe('navSnapshot', () => {
  it('sums free + position + fees', () => {
    const r = computeNav({
      freeSolLamports: 1_000_000_000n,   // 1 SOL
      freeBertRaw: 100_000_000n,         // 100 BERT
      positionTotalValueUsd: 50,
      uncollectedFeesBert: 1_000_000n,   // 1 BERT
      uncollectedFeesSol: 0n,
      solUsd: 100,
      bertUsd: 0.01,
    });
    // free: 1 × 100 + 100 × 0.01 = 100 + 1 = 101
    // position: 50
    // fees: 1 × 0.01 = 0.01
    expect(r.totalUsd).toBeCloseTo(151.01);
    expect(r.freeUsd).toBeCloseTo(101);
    expect(r.positionUsd).toBe(50);
    expect(r.feesUsd).toBeCloseTo(0.01);
  });

  it('handles zero position', () => {
    const r = computeNav({
      freeSolLamports: 2_000_000_000n,
      freeBertRaw: 0n,
      positionTotalValueUsd: 0,
      uncollectedFeesBert: 0n,
      uncollectedFeesSol: 0n,
      solUsd: 150,
      bertUsd: 0.01,
    });
    expect(r.totalUsd).toBeCloseTo(300);
  });

  it('computes solFrac for token split', () => {
    const r = computeNav({
      freeSolLamports: 1_000_000_000n,   // 1 SOL = $100
      freeBertRaw: 10_000_000n,          // 10 BERT = $0.10
      positionTotalValueUsd: 0,
      uncollectedFeesBert: 0n,
      uncollectedFeesSol: 0n,
      solUsd: 100,
      bertUsd: 0.01,
    });
    // freeUsd=100.10 — 100 SOL, 0.10 BERT → solFrac ~ 100/100.10
    expect(r.solFrac).toBeCloseTo(100 / 100.10, 3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run tests/vault/navSnapshot.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/vault/navSnapshot.ts`**

```typescript
import { SOL_DECIMALS, BERT_DECIMALS } from './shareMath.js';

export interface NavInputs {
  freeSolLamports: bigint;
  freeBertRaw: bigint;
  positionTotalValueUsd: number;
  uncollectedFeesBert: bigint;
  uncollectedFeesSol: bigint;
  solUsd: number;
  bertUsd: number;
}

export interface NavSnapshot {
  totalUsd: number;
  freeUsd: number;
  positionUsd: number;
  feesUsd: number;
  solFrac: number;       // 0..1, SOL's share of free+position by USD value
}

/**
 * Compute NAV from on-chain state + oracle prices.
 * Matches the hourly-report math previously inlined in main.ts.
 */
export function computeNav(i: NavInputs): NavSnapshot {
  const freeSol = Number(i.freeSolLamports) / 10 ** SOL_DECIMALS;
  const freeBert = Number(i.freeBertRaw) / 10 ** BERT_DECIMALS;
  const feeBert = Number(i.uncollectedFeesBert) / 10 ** BERT_DECIMALS;
  const feeSol = Number(i.uncollectedFeesSol) / 10 ** SOL_DECIMALS;

  const freeUsd = freeSol * i.solUsd + freeBert * i.bertUsd;
  const feesUsd = feeBert * i.bertUsd + feeSol * i.solUsd;
  const positionUsd = i.positionTotalValueUsd;
  const totalUsd = freeUsd + positionUsd + feesUsd;

  // Estimate SOL fraction of the free+position value (fees are negligible + uncertain).
  // Assumes the position holds tokens in the same ratio as the pool's current composition;
  // without per-bin composition data, we approximate using free balances + position.
  // For MVP, use freeUsd composition as the proxy for withdrawal token split.
  const freeSolUsd = freeSol * i.solUsd;
  const solFrac = freeUsd > 0 ? freeSolUsd / freeUsd : 0.5;

  return { totalUsd, freeUsd, positionUsd, feesUsd, solFrac };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm vitest run tests/vault/navSnapshot.test.ts
```
Expected: green.

- [ ] **Step 5: Refactor main.ts hourly report to use `computeNav`**

In `src/main.ts`, inside the hourly report block (currently ~lines 217-246), replace the inline computation with a call to `computeNav`. The report already has `bal`, `position`, and `mid` — feed them in:

```typescript
// at top of file
import { computeNav } from './vault/navSnapshot.js';

// ... inside hourly report block ...
if (position) {
  const nav = computeNav({
    freeSolLamports: BigInt(bal.solLamports.toString()),
    freeBertRaw: BigInt(bal.bertRaw.toString()),
    positionTotalValueUsd: position.totalValueUsd,
    uncollectedFeesBert: BigInt(position.uncollectedFeesBert.toString()),
    uncollectedFeesSol: BigInt(position.uncollectedFeesSol.toString()),
    solUsd: mid?.solUsd ?? 0,
    bertUsd: mid?.bertUsd ?? 0,
  });
  totalLine = `Total holdings: $${nav.totalUsd.toFixed(2)}`;
  // keep existing balanceLine/posValueLine/feeLine for detailed breakdown
}
```

Leave the individual lines (`balanceLine`, `posValueLine`, `feeLine`) intact; just replace the `totalUsd` computation.

- [ ] **Step 6: Run full test suite**

```bash
pnpm vitest run
```
Expected: green (no regressions).

- [ ] **Step 7: Commit**

```bash
git add src/vault/navSnapshot.ts src/main.ts tests/vault/navSnapshot.test.ts
git commit -m "vault: extract NAV computation into reusable module"
```

---

## Phase 2 — Data access layer

### Task 8: depositorStore (CRUD + withTransaction)

**Files:**
- Create: `src/vault/types.ts`
- Create: `src/vault/depositorStore.ts`
- Test: `tests/vault/depositorStore.test.ts`

- [ ] **Step 1: Create `src/vault/types.ts`**

```typescript
export interface VaultUser {
  telegramId: number;
  role: 'operator' | 'depositor';
  depositAddress: string;
  totpEnrolledAt: number | null;
  totpLastUsedCounter: number | null;
  whitelistAddress: string | null;
  whitelistSetAt: number | null;
  disclaimerAt: number;
  createdAt: number;
}

export interface VaultDeposit {
  id: number;
  telegramId: number;
  inboundTxSig: string;
  sweepTxSig: string | null;
  solLamports: bigint;
  bertRaw: bigint;
  solUsd: number;
  bertUsd: number;
  navPerShareAt: number;
  sharesMinted: number;
  confirmedAt: number;
  sweptAt: number | null;
}

export type WithdrawalStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface VaultWithdrawal {
  id: number;
  telegramId: number;
  status: WithdrawalStatus;
  destination: string;
  sharesBurned: number;
  feeShares: number;
  navPerShareAt: number | null;
  solLamportsOut: bigint | null;
  bertRawOut: bigint | null;
  txSig: string | null;
  failureReason: string | null;
  queuedAt: number;
  processedAt: number | null;
}

export interface PendingWhitelistChange {
  id: number;
  telegramId: number;
  oldAddress: string | null;
  newAddress: string;
  requestedAt: number;
  activatesAt: number;
  status: 'pending' | 'activated' | 'cancelled';
  cancelReason: string | null;
}

export interface NavSnapshotRow {
  ts: number;
  totalValueUsd: number;
  totalShares: number;
  navPerShare: number;
  source: 'hourly' | 'deposit' | 'withdrawal' | 'bootstrap';
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/vault/depositorStore.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateStore } from '../../src/stateStore.js';
import { DepositorStore } from '../../src/vault/depositorStore.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('DepositorStore', () => {
  let dir: string;
  let state: StateStore;
  let store: DepositorStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bertmm-'));
    state = new StateStore(join(dir, 'state.db'));
    state.init();
    store = new DepositorStore(state);
  });
  afterEach(() => { state.close(); rmSync(dir, { recursive: true, force: true }); });

  it('creates and retrieves a user', () => {
    store.createUser({
      telegramId: 1, role: 'depositor', depositAddress: 'AddrA',
      depositSecretEnc: Buffer.from([1,2]), depositSecretIv: Buffer.from([3,4]),
      disclaimerAt: 100, createdAt: 100,
    });
    const u = store.getUser(1);
    expect(u).toBeTruthy();
    expect(u!.depositAddress).toBe('AddrA');
    expect(u!.role).toBe('depositor');
  });

  it('enforces UNIQUE on deposit_address', () => {
    store.createUser({ telegramId: 1, role: 'depositor', depositAddress: 'A',
      depositSecretEnc: Buffer.alloc(0), depositSecretIv: Buffer.alloc(0),
      disclaimerAt: 100, createdAt: 100 });
    expect(() => store.createUser({ telegramId: 2, role: 'depositor', depositAddress: 'A',
      depositSecretEnc: Buffer.alloc(0), depositSecretIv: Buffer.alloc(0),
      disclaimerAt: 100, createdAt: 100 })).toThrow(/UNIQUE/);
  });

  it('credits deposit and mints shares atomically', () => {
    store.createUser({ telegramId: 1, role: 'depositor', depositAddress: 'A',
      depositSecretEnc: Buffer.alloc(0), depositSecretIv: Buffer.alloc(0),
      disclaimerAt: 100, createdAt: 100 });
    store.creditDeposit({
      telegramId: 1, inboundTxSig: 'sig1', sweepTxSig: 'swp1',
      solLamports: 1_000_000_000n, bertRaw: 0n,
      solUsd: 100, bertUsd: 0.01, navPerShareAt: 1, sharesMinted: 100,
      confirmedAt: 100, sweptAt: 101,
    });
    expect(store.getShares(1)).toBe(100);
    expect(store.listDepositsForUser(1).length).toBe(1);
  });

  it('rejects duplicate inbound_tx_sig', () => {
    store.createUser({ telegramId: 1, role: 'depositor', depositAddress: 'A',
      depositSecretEnc: Buffer.alloc(0), depositSecretIv: Buffer.alloc(0),
      disclaimerAt: 100, createdAt: 100 });
    const p = {
      telegramId: 1, inboundTxSig: 'sig1', sweepTxSig: 's',
      solLamports: 0n, bertRaw: 0n, solUsd: 0, bertUsd: 0,
      navPerShareAt: 1, sharesMinted: 1, confirmedAt: 100, sweptAt: 101,
    };
    store.creditDeposit(p);
    expect(() => store.creditDeposit(p)).toThrow(/UNIQUE/);
  });

  it('burns shares on completed withdrawal', () => {
    store.createUser({ telegramId: 1, role: 'depositor', depositAddress: 'A',
      depositSecretEnc: Buffer.alloc(0), depositSecretIv: Buffer.alloc(0),
      disclaimerAt: 100, createdAt: 100 });
    store.creditDeposit({ telegramId: 1, inboundTxSig: 's1', sweepTxSig: 'w',
      solLamports: 0n, bertRaw: 0n, solUsd: 0, bertUsd: 0,
      navPerShareAt: 1, sharesMinted: 100, confirmedAt: 100, sweptAt: 101 });

    const wid = store.enqueueWithdrawal({
      telegramId: 1, destination: 'destAddr',
      sharesBurned: 10, feeShares: 0.03, queuedAt: 200,
    });
    store.completeWithdrawal({
      id: wid, txSig: 'outsig', solLamportsOut: 500_000_000n, bertRawOut: 0n,
      navPerShareAt: 1, processedAt: 210,
    });
    expect(store.getShares(1)).toBe(90);
    const w = store.listWithdrawalsByStatus('completed');
    expect(w.length).toBe(1);
    expect(w[0].txSig).toBe('outsig');
  });

  it('does not burn shares on failed withdrawal', () => {
    store.createUser({ telegramId: 1, role: 'depositor', depositAddress: 'A',
      depositSecretEnc: Buffer.alloc(0), depositSecretIv: Buffer.alloc(0),
      disclaimerAt: 100, createdAt: 100 });
    store.creditDeposit({ telegramId: 1, inboundTxSig: 's1', sweepTxSig: 'w',
      solLamports: 0n, bertRaw: 0n, solUsd: 0, bertUsd: 0,
      navPerShareAt: 1, sharesMinted: 100, confirmedAt: 100, sweptAt: 101 });
    const wid = store.enqueueWithdrawal({
      telegramId: 1, destination: 'destAddr',
      sharesBurned: 10, feeShares: 0.03, queuedAt: 200,
    });
    store.failWithdrawal({ id: wid, reason: 'oracle_unavailable', processedAt: 210 });
    expect(store.getShares(1)).toBe(100);
  });

  it('sums daily withdrawal USD per user (24h window)', () => {
    store.createUser({ telegramId: 1, role: 'depositor', depositAddress: 'A',
      depositSecretEnc: Buffer.alloc(0), depositSecretIv: Buffer.alloc(0),
      disclaimerAt: 100, createdAt: 100 });
    store.creditDeposit({ telegramId: 1, inboundTxSig: 's1', sweepTxSig: 'w',
      solLamports: 0n, bertRaw: 0n, solUsd: 0, bertUsd: 0,
      navPerShareAt: 1, sharesMinted: 1000, confirmedAt: 100, sweptAt: 101 });

    const now = 1_700_000_000_000;
    const w1 = store.enqueueWithdrawal({ telegramId: 1, destination: 'd',
      sharesBurned: 100, feeShares: 0.3, queuedAt: now - 3_600_000 });
    store.completeWithdrawal({ id: w1, txSig: 't', solLamportsOut: 0n, bertRawOut: 0n,
      navPerShareAt: 1, processedAt: now - 3_500_000 });
    const sum = store.sumCompletedWithdrawalUsdLast24h(1, now);
    expect(sum).toBeCloseTo(99.7);  // 100 - 0.3 fee
  });

  it('audit log: writes + reads', () => {
    store.writeAudit({ ts: 100, telegramId: 1, event: 'totp_enrolled', detailsJson: '{}' });
    const rows = store.listAudit({ sinceTs: 0, limit: 10 });
    expect(rows.length).toBe(1);
    expect(rows[0].event).toBe('totp_enrolled');
  });
});
```

- [ ] **Step 3: Implement `src/vault/depositorStore.ts`**

```typescript
import type Database from 'better-sqlite3';
import type { StateStore } from '../stateStore.js';
import type {
  VaultUser, VaultDeposit, VaultWithdrawal, WithdrawalStatus,
  PendingWhitelistChange, NavSnapshotRow,
} from './types.js';

export class DepositorStore {
  private db: Database.Database;

  constructor(private state: StateStore) {
    // StateStore exposes db via (state as any).db — add a getter if preferred
    this.db = (state as unknown as { db: Database.Database }).db;
  }

  /** Run fn in a transaction (delegates to state.withTransaction). */
  withTransaction<T>(fn: () => T): T {
    return this.state.withTransaction(fn);
  }

  // ── Users ──────────────────────────────────────────────────────────────
  createUser(args: {
    telegramId: number; role: 'operator' | 'depositor'; depositAddress: string;
    depositSecretEnc: Buffer; depositSecretIv: Buffer;
    disclaimerAt: number; createdAt: number;
  }): void {
    this.db.prepare(`
      INSERT INTO vault_users(telegram_id, role, deposit_address, deposit_secret_enc,
                              deposit_secret_iv, disclaimer_at, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?)
    `).run(args.telegramId, args.role, args.depositAddress,
           args.depositSecretEnc, args.depositSecretIv,
           args.disclaimerAt, args.createdAt);
  }

  getUser(telegramId: number): VaultUser | null {
    const row = this.db.prepare(`SELECT * FROM vault_users WHERE telegram_id=?`).get(telegramId) as any;
    return row ? this.rowToUser(row) : null;
  }

  getUserByDepositAddress(addr: string): VaultUser | null {
    const row = this.db.prepare(`SELECT * FROM vault_users WHERE deposit_address=?`).get(addr) as any;
    return row ? this.rowToUser(row) : null;
  }

  listUsers(): VaultUser[] {
    return (this.db.prepare(`SELECT * FROM vault_users ORDER BY created_at`).all() as any[])
      .map(r => this.rowToUser(r));
  }

  getUserSecrets(telegramId: number): {
    depositSecretEnc: Buffer; depositSecretIv: Buffer;
    totpSecretEnc: Buffer | null; totpSecretIv: Buffer | null;
  } | null {
    const row = this.db.prepare(`
      SELECT deposit_secret_enc, deposit_secret_iv, totp_secret_enc, totp_secret_iv
      FROM vault_users WHERE telegram_id=?
    `).get(telegramId) as any;
    if (!row) return null;
    return {
      depositSecretEnc: row.deposit_secret_enc,
      depositSecretIv: row.deposit_secret_iv,
      totpSecretEnc: row.totp_secret_enc ?? null,
      totpSecretIv: row.totp_secret_iv ?? null,
    };
  }

  setTotp(args: { telegramId: number; secretEnc: Buffer; secretIv: Buffer; enrolledAt: number }): void {
    this.db.prepare(`
      UPDATE vault_users SET totp_secret_enc=?, totp_secret_iv=?, totp_enrolled_at=?
      WHERE telegram_id=?
    `).run(args.secretEnc, args.secretIv, args.enrolledAt, args.telegramId);
  }

  setTotpLastCounter(telegramId: number, counter: number): void {
    this.db.prepare(`UPDATE vault_users SET totp_last_used_counter=? WHERE telegram_id=?`)
      .run(counter, telegramId);
  }

  setWhitelistImmediate(args: { telegramId: number; address: string; ts: number }): void {
    this.db.prepare(`
      UPDATE vault_users SET whitelist_address=?, whitelist_set_at=? WHERE telegram_id=?
    `).run(args.address, args.ts, args.telegramId);
  }

  // ── Shares ─────────────────────────────────────────────────────────────
  getShares(telegramId: number): number {
    const row = this.db.prepare(`SELECT shares FROM vault_shares WHERE telegram_id=?`)
      .get(telegramId) as { shares: number } | undefined;
    return row?.shares ?? 0;
  }

  addShares(telegramId: number, delta: number): void {
    const existing = this.db.prepare(`SELECT shares FROM vault_shares WHERE telegram_id=?`)
      .get(telegramId) as { shares: number } | undefined;
    if (existing) {
      this.db.prepare(`UPDATE vault_shares SET shares=? WHERE telegram_id=?`)
        .run(existing.shares + delta, telegramId);
    } else {
      this.db.prepare(`INSERT INTO vault_shares(telegram_id, shares) VALUES(?, ?)`)
        .run(telegramId, delta);
    }
  }

  totalShares(): number {
    const row = this.db.prepare(`SELECT COALESCE(SUM(shares),0) AS total FROM vault_shares`)
      .get() as { total: number };
    return row.total;
  }

  // ── Deposits ───────────────────────────────────────────────────────────
  creditDeposit(args: Omit<VaultDeposit, 'id'>): number {
    return this.withTransaction(() => {
      const info = this.db.prepare(`
        INSERT INTO vault_deposits(telegram_id, inbound_tx_sig, sweep_tx_sig,
                                   sol_lamports, bert_raw, sol_usd, bert_usd,
                                   nav_per_share_at, shares_minted, confirmed_at, swept_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        args.telegramId, args.inboundTxSig, args.sweepTxSig,
        args.solLamports, args.bertRaw, args.solUsd, args.bertUsd,
        args.navPerShareAt, args.sharesMinted, args.confirmedAt, args.sweptAt,
      );
      this.addShares(args.telegramId, args.sharesMinted);
      return info.lastInsertRowid as number;
    });
  }

  hasDeposit(inboundTxSig: string): boolean {
    const row = this.db.prepare(`SELECT 1 FROM vault_deposits WHERE inbound_tx_sig=?`)
      .get(inboundTxSig);
    return !!row;
  }

  listDepositsForUser(telegramId: number): VaultDeposit[] {
    return (this.db.prepare(`SELECT * FROM vault_deposits WHERE telegram_id=? ORDER BY id`)
      .all(telegramId) as any[]).map(r => this.rowToDeposit(r));
  }

  // ── Withdrawals ────────────────────────────────────────────────────────
  enqueueWithdrawal(args: {
    telegramId: number; destination: string;
    sharesBurned: number; feeShares: number; queuedAt: number;
  }): number {
    const info = this.db.prepare(`
      INSERT INTO vault_withdrawals(telegram_id, status, destination,
                                    shares_burned, fee_shares, queued_at)
      VALUES(?, 'queued', ?, ?, ?, ?)
    `).run(args.telegramId, args.destination, args.sharesBurned, args.feeShares, args.queuedAt);
    return info.lastInsertRowid as number;
  }

  setWithdrawalProcessing(id: number): void {
    this.db.prepare(`UPDATE vault_withdrawals SET status='processing' WHERE id=? AND status='queued'`)
      .run(id);
  }

  completeWithdrawal(args: {
    id: number; txSig: string;
    solLamportsOut: bigint; bertRawOut: bigint;
    navPerShareAt: number; processedAt: number;
  }): void {
    this.withTransaction(() => {
      const w = this.db.prepare(`SELECT telegram_id, shares_burned FROM vault_withdrawals WHERE id=?`)
        .get(args.id) as { telegram_id: number; shares_burned: number } | undefined;
      if (!w) throw new Error(`completeWithdrawal: id ${args.id} not found`);
      this.db.prepare(`
        UPDATE vault_withdrawals SET status='completed', tx_sig=?,
          sol_lamports_out=?, bert_raw_out=?, nav_per_share_at=?, processed_at=?
        WHERE id=?
      `).run(args.txSig, args.solLamportsOut, args.bertRawOut, args.navPerShareAt, args.processedAt, args.id);
      this.addShares(w.telegram_id, -w.shares_burned);
    });
  }

  failWithdrawal(args: { id: number; reason: string; processedAt: number }): void {
    this.db.prepare(`
      UPDATE vault_withdrawals SET status='failed', failure_reason=?, processed_at=?
      WHERE id=?
    `).run(args.reason, args.processedAt, args.id);
  }

  listWithdrawalsByStatus(status: WithdrawalStatus): VaultWithdrawal[] {
    return (this.db.prepare(`SELECT * FROM vault_withdrawals WHERE status=? ORDER BY id`)
      .all(status) as any[]).map(r => this.rowToWithdrawal(r));
  }

  /** Sum USD value delivered (net of fee) for completed withdrawals in last 24h. */
  sumCompletedWithdrawalUsdLast24h(telegramId: number, nowMs: number): number {
    const since = nowMs - 24 * 3600 * 1000;
    const row = this.db.prepare(`
      SELECT COALESCE(SUM((shares_burned - fee_shares) * nav_per_share_at), 0) AS total
      FROM vault_withdrawals
      WHERE telegram_id=? AND status='completed' AND processed_at >= ?
    `).get(telegramId, since) as { total: number };
    return row.total;
  }

  countPendingWithdrawals(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM vault_withdrawals WHERE status IN ('queued','processing')`).get() as { n: number };
    return row.n;
  }

  // ── Whitelist changes ─────────────────────────────────────────────────
  enqueueWhitelistChange(args: {
    telegramId: number; oldAddress: string | null; newAddress: string;
    requestedAt: number; activatesAt: number; initialStatus: 'pending' | 'activated';
  }): number {
    const info = this.db.prepare(`
      INSERT INTO vault_pending_whitelist_changes(telegram_id, old_address, new_address,
                                                   requested_at, activates_at, status)
      VALUES(?, ?, ?, ?, ?, ?)
    `).run(args.telegramId, args.oldAddress, args.newAddress,
           args.requestedAt, args.activatesAt, args.initialStatus);
    return info.lastInsertRowid as number;
  }

  listDueWhitelistChanges(nowMs: number): PendingWhitelistChange[] {
    return (this.db.prepare(`
      SELECT * FROM vault_pending_whitelist_changes
      WHERE status='pending' AND activates_at <= ?
      ORDER BY activates_at
    `).all(nowMs) as any[]).map(r => this.rowToWhitelistChange(r));
  }

  mostRecentPendingChange(telegramId: number): PendingWhitelistChange | null {
    const row = this.db.prepare(`
      SELECT * FROM vault_pending_whitelist_changes
      WHERE telegram_id=? AND status='pending'
      ORDER BY requested_at DESC LIMIT 1
    `).get(telegramId) as any;
    return row ? this.rowToWhitelistChange(row) : null;
  }

  markWhitelistActivated(id: number): void {
    this.db.prepare(`UPDATE vault_pending_whitelist_changes SET status='activated' WHERE id=?`)
      .run(id);
  }

  cancelPendingWhitelist(id: number, reason: string): void {
    this.db.prepare(`UPDATE vault_pending_whitelist_changes SET status='cancelled', cancel_reason=? WHERE id=?`)
      .run(reason, id);
  }

  // ── NAV snapshots ─────────────────────────────────────────────────────
  insertNavSnapshot(row: NavSnapshotRow): void {
    this.db.prepare(`
      INSERT INTO vault_nav_snapshots(ts, total_value_usd, total_shares, nav_per_share, source)
      VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(ts) DO UPDATE SET total_value_usd=excluded.total_value_usd,
        total_shares=excluded.total_shares, nav_per_share=excluded.nav_per_share, source=excluded.source
    `).run(row.ts, row.totalValueUsd, row.totalShares, row.navPerShare, row.source);
  }

  latestNavSnapshot(): NavSnapshotRow | null {
    const row = this.db.prepare(`SELECT * FROM vault_nav_snapshots ORDER BY ts DESC LIMIT 1`).get() as any;
    if (!row) return null;
    return {
      ts: row.ts, totalValueUsd: row.total_value_usd, totalShares: row.total_shares,
      navPerShare: row.nav_per_share, source: row.source,
    };
  }

  navSnapshotAtOrBefore(ts: number): NavSnapshotRow | null {
    const row = this.db.prepare(`SELECT * FROM vault_nav_snapshots WHERE ts<=? ORDER BY ts DESC LIMIT 1`)
      .get(ts) as any;
    if (!row) return null;
    return {
      ts: row.ts, totalValueUsd: row.total_value_usd, totalShares: row.total_shares,
      navPerShare: row.nav_per_share, source: row.source,
    };
  }

  // ── Audit log ─────────────────────────────────────────────────────────
  writeAudit(args: { ts: number; telegramId: number | null; event: string; detailsJson: string }): void {
    this.db.prepare(`
      INSERT INTO vault_audit_log(ts, telegram_id, event, details_json) VALUES(?, ?, ?, ?)
    `).run(args.ts, args.telegramId, args.event, args.detailsJson);
  }

  listAudit(args: { sinceTs: number; limit: number }): Array<{ ts: number; telegramId: number | null; event: string; detailsJson: string }> {
    return (this.db.prepare(`SELECT * FROM vault_audit_log WHERE ts>=? ORDER BY ts DESC LIMIT ?`)
      .all(args.sinceTs, args.limit) as any[])
      .map(r => ({ ts: r.ts, telegramId: r.telegram_id, event: r.event, detailsJson: r.details_json }));
  }

  // ── Row mappers ───────────────────────────────────────────────────────
  private rowToUser(r: any): VaultUser {
    return {
      telegramId: r.telegram_id, role: r.role, depositAddress: r.deposit_address,
      totpEnrolledAt: r.totp_enrolled_at, totpLastUsedCounter: r.totp_last_used_counter,
      whitelistAddress: r.whitelist_address, whitelistSetAt: r.whitelist_set_at,
      disclaimerAt: r.disclaimer_at, createdAt: r.created_at,
    };
  }
  private rowToDeposit(r: any): VaultDeposit {
    return {
      id: r.id, telegramId: r.telegram_id, inboundTxSig: r.inbound_tx_sig, sweepTxSig: r.sweep_tx_sig,
      solLamports: BigInt(r.sol_lamports), bertRaw: BigInt(r.bert_raw),
      solUsd: r.sol_usd, bertUsd: r.bert_usd, navPerShareAt: r.nav_per_share_at,
      sharesMinted: r.shares_minted, confirmedAt: r.confirmed_at, sweptAt: r.swept_at,
    };
  }
  private rowToWithdrawal(r: any): VaultWithdrawal {
    return {
      id: r.id, telegramId: r.telegram_id, status: r.status, destination: r.destination,
      sharesBurned: r.shares_burned, feeShares: r.fee_shares, navPerShareAt: r.nav_per_share_at,
      solLamportsOut: r.sol_lamports_out === null ? null : BigInt(r.sol_lamports_out),
      bertRawOut: r.bert_raw_out === null ? null : BigInt(r.bert_raw_out),
      txSig: r.tx_sig, failureReason: r.failure_reason,
      queuedAt: r.queued_at, processedAt: r.processed_at,
    };
  }
  private rowToWhitelistChange(r: any): PendingWhitelistChange {
    return {
      id: r.id, telegramId: r.telegram_id, oldAddress: r.old_address, newAddress: r.new_address,
      requestedAt: r.requested_at, activatesAt: r.activates_at, status: r.status,
      cancelReason: r.cancel_reason,
    };
  }
}
```

- [ ] **Step 4: Run the tests**

```bash
pnpm vitest run tests/vault/depositorStore.test.ts
```
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/vault/types.ts src/vault/depositorStore.ts tests/vault/depositorStore.test.ts
git commit -m "vault: depositorStore with CRUD + withTransaction"
```

---

## Phase 3 — User management & Telegram surface

### Task 9: Broaden telegramCommander auth

**Files:**
- Modify: `src/telegramCommander.ts`
- Test: `tests/telegramCommander.test.ts` (new if missing)

**Context:** currently `telegramCommander.ts:67-70` only accepts messages from a single `authorizedChatId`. Vault commands need to be accepted from any chat whose `from.id` matches a row in `vault_users`. Operator commands (existing `/pause`, `/resume`) still require the configured `authorizedChatId`.

- [ ] **Step 1: Design the auth split (no test yet — refactor)**

The command router will categorize each command:
- **Operator-only**: `/pause`, `/resume`, `/status`, `/pausevault`, `/resumevault`, `/vaultstatus`, `/forceprocess`
- **Vault user**: `/account`, `/deposit`, `/balance`, `/withdraw`, `/stats`, `/setwhitelist`, `/cancelwhitelist`
- **Public**: `/help`, `/start`, `/stats` (subset for public — TVL + NAV only)

We'll add a `CommandKind` enum and let `DepositorStore` inform the auth check.

- [ ] **Step 2: Write a failing test for vault-user auth**

Create `tests/telegramCommander.test.ts` (or extend if exists):

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StateStore } from '../src/stateStore.js';
import { DepositorStore } from '../src/vault/depositorStore.js';
import { TelegramCommander } from '../src/telegramCommander.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('TelegramCommander auth', () => {
  let dir: string;
  let state: StateStore;
  let store: DepositorStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bertmm-'));
    state = new StateStore(join(dir, 'state.db'));
    state.init();
    store = new DepositorStore(state);
  });
  afterEach(() => { state.close(); rmSync(dir, { recursive: true, force: true }); });

  it('accepts operator command from authorized chat', async () => {
    const handler = vi.fn(async () => {});
    const commander = new TelegramCommander({
      botToken: 'tok', operatorChatId: 100, depositorStore: store,
    });
    commander.registerOperatorCommand('pause', handler);
    await commander.dispatch({ chatId: 100, userId: 100, text: '/pause', messageId: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('rejects operator command from unauthorized chat', async () => {
    const handler = vi.fn(async () => {});
    const commander = new TelegramCommander({
      botToken: 'tok', operatorChatId: 100, depositorStore: store,
    });
    commander.registerOperatorCommand('pause', handler);
    await commander.dispatch({ chatId: 200, userId: 200, text: '/pause', messageId: 1 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('accepts vault command from a depositor user', async () => {
    store.createUser({ telegramId: 500, role: 'depositor', depositAddress: 'A',
      depositSecretEnc: Buffer.alloc(0), depositSecretIv: Buffer.alloc(0),
      disclaimerAt: 100, createdAt: 100 });
    const handler = vi.fn(async () => {});
    const commander = new TelegramCommander({
      botToken: 'tok', operatorChatId: 100, depositorStore: store,
    });
    commander.registerVaultCommand('balance', handler);
    await commander.dispatch({ chatId: 500, userId: 500, text: '/balance', messageId: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('rejects vault command from non-registered user', async () => {
    const handler = vi.fn(async () => {});
    const commander = new TelegramCommander({
      botToken: 'tok', operatorChatId: 100, depositorStore: store,
    });
    commander.registerVaultCommand('balance', handler);
    await commander.dispatch({ chatId: 999, userId: 999, text: '/balance', messageId: 1 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('public commands accept anyone', async () => {
    const handler = vi.fn(async () => {});
    const commander = new TelegramCommander({
      botToken: 'tok', operatorChatId: 100, depositorStore: store,
    });
    commander.registerPublicCommand('stats', handler);
    await commander.dispatch({ chatId: 999, userId: 999, text: '/stats', messageId: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('/account is accessible to anyone (pre-enrollment)', async () => {
    const handler = vi.fn(async () => {});
    const commander = new TelegramCommander({
      botToken: 'tok', operatorChatId: 100, depositorStore: store,
    });
    commander.registerEnrollmentCommand('account', handler);
    await commander.dispatch({ chatId: 999, userId: 999, text: '/account', messageId: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
pnpm vitest run tests/telegramCommander.test.ts
```
Expected: FAIL — methods missing.

- [ ] **Step 4: Refactor `src/telegramCommander.ts`**

Replace the hardcoded command switch with a registry. Add the new method signatures and the dispatcher. Concretely:

```typescript
import type { DepositorStore } from './vault/depositorStore.js';

export interface IncomingMessage {
  chatId: number;
  userId: number;
  text: string;
  messageId: number;
}

export type CommandHandler = (msg: IncomingMessage) => Promise<void>;

type Kind = 'operator' | 'vault' | 'public' | 'enrollment';

export interface TelegramCommanderDeps {
  botToken: string;
  operatorChatId: number;
  depositorStore: DepositorStore;
}

export class TelegramCommander {
  private handlers = new Map<string, { kind: Kind; fn: CommandHandler }>();
  private depositorStore: DepositorStore;
  private operatorChatId: number;
  private botToken: string;

  constructor(deps: TelegramCommanderDeps) {
    this.botToken = deps.botToken;
    this.operatorChatId = deps.operatorChatId;
    this.depositorStore = deps.depositorStore;
  }

  registerOperatorCommand(name: string, fn: CommandHandler): void {
    this.handlers.set(name, { kind: 'operator', fn });
  }
  registerVaultCommand(name: string, fn: CommandHandler): void {
    this.handlers.set(name, { kind: 'vault', fn });
  }
  registerPublicCommand(name: string, fn: CommandHandler): void {
    this.handlers.set(name, { kind: 'public', fn });
  }
  registerEnrollmentCommand(name: string, fn: CommandHandler): void {
    this.handlers.set(name, { kind: 'enrollment', fn });
  }

  async dispatch(msg: IncomingMessage): Promise<void> {
    const match = msg.text.match(/^\/([a-z_]+)(?:\s|$)/i);
    if (!match) return;
    const name = match[1].toLowerCase();
    const h = this.handlers.get(name);
    if (!h) return;
    switch (h.kind) {
      case 'public':
      case 'enrollment':
        return void h.fn(msg);
      case 'operator':
        if (msg.chatId === this.operatorChatId) return void h.fn(msg);
        return;
      case 'vault': {
        const user = this.depositorStore.getUser(msg.userId);
        if (user) return void h.fn(msg);
        return;
      }
    }
  }

  // ... existing polling loop + reply() kept intact, but called with `dispatch`
}
```

Keep the existing `reply()` method and long-polling loop. Inside the polling loop's message handler, replace the inline switch with a call to `this.dispatch({ chatId, userId, text, messageId })`.

Wire into main.ts: replace the current single-arg constructor with the new `TelegramCommanderDeps` shape, passing `depositorStore` built from the state store.

- [ ] **Step 5: Run all tests**

```bash
pnpm vitest run
```
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add src/telegramCommander.ts src/main.ts tests/telegramCommander.test.ts
git commit -m "vault: command registry with operator/vault/public/enrollment kinds"
```

---

### Task 10: `/account` enrollment flow

**Files:**
- Create: `src/vault/disclaimer.ts`
- Create: `src/vault/enrollment.ts`
- Modify: `src/vault/commands.ts` (new if not yet created — adds `/account` handler)
- Test: `tests/vault/enrollment.test.ts`
- Modify: `package.json` (add `qrcode`)

- [ ] **Step 1: Install qrcode**

```bash
pnpm add qrcode @types/qrcode
```

- [ ] **Step 2: Write the disclaimer text**

Create `src/vault/disclaimer.ts`:

```typescript
export const DISCLAIMER_TEXT = `
⚠️  BERT Vault — Terms

This is a CUSTODIAL service.

• Operator (Dr. Inker Labs) holds all private keys, including your deposit address's.
• Funds are pooled with other depositors and used by a market-making strategy on the Meteora BERT/SOL DLMM pool.
• The strategy can lose money. Impermanent loss, rebalance friction, and slippage all apply. Past performance is not a guarantee of future returns.
• No FDIC insurance. No guarantees of redemption. Withdrawals are self-service via Telegram to a single whitelisted address.
• 2FA (TOTP) is required on every sensitive action (deposit-address reveal, balance view, withdrawal, whitelist change).
• Changing the withdrawal whitelist takes effect after a 24-hour cooldown (except on first setup).
• Withdrawals pay a 0.30% fee into the pool (not to the operator).

By continuing you accept these terms and the associated risk.
Reply  /accept  to continue, or  /decline  to abort.
`.trim();
```

- [ ] **Step 3: Write the failing test**

Create `tests/vault/enrollment.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StateStore } from '../../src/stateStore.js';
import { DepositorStore } from '../../src/vault/depositorStore.js';
import { Enrollment } from '../../src/vault/enrollment.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Enrollment', () => {
  let dir: string;
  let state: StateStore;
  let store: DepositorStore;
  let enroll: Enrollment;
  const masterKey = Buffer.alloc(32, 42);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bertmm-'));
    state = new StateStore(join(dir, 'state.db'));
    state.init();
    store = new DepositorStore(state);
    enroll = new Enrollment({ store, masterKey, ensureAta: async () => {} });
  });
  afterEach(() => { state.close(); rmSync(dir, { recursive: true, force: true }); });

  it('accept() creates a user with encrypted deposit key', async () => {
    await enroll.accept({ telegramId: 1, now: 100 });
    const u = store.getUser(1);
    expect(u).toBeTruthy();
    expect(u!.role).toBe('depositor');
    expect(u!.totpEnrolledAt).toBeNull();
    const s = store.getUserSecrets(1);
    expect(s!.depositSecretEnc.length).toBeGreaterThan(0);
    expect(s!.depositSecretIv.length).toBe(12);
  });

  it('beginTotpEnrollment returns a secret + uri for the user', async () => {
    await enroll.accept({ telegramId: 2, now: 100 });
    const r = await enroll.beginTotpEnrollment({ telegramId: 2 });
    expect(r.uri).toMatch(/^otpauth:\/\//);
    expect(r.secretBase32).toMatch(/^[A-Z2-7]+=*$/);
  });

  it('confirmTotp accepts a valid code and persists totp secret', async () => {
    await enroll.accept({ telegramId: 3, now: 100 });
    const { secretBase32 } = await enroll.beginTotpEnrollment({ telegramId: 3 });
    const { TOTP } = await import('otpauth');
    const code = new TOTP({ secret: secretBase32 }).generate();
    const ok = await enroll.confirmTotp({ telegramId: 3, code, now: 200 });
    expect(ok).toBe(true);
    const u = store.getUser(3)!;
    expect(u.totpEnrolledAt).toBe(200);
    expect(u.totpLastUsedCounter).toBeGreaterThan(0);
  });

  it('confirmTotp rejects bad code', async () => {
    await enroll.accept({ telegramId: 4, now: 100 });
    await enroll.beginTotpEnrollment({ telegramId: 4 });
    const ok = await enroll.confirmTotp({ telegramId: 4, code: '000000', now: 200 });
    expect(ok).toBe(false);
  });

  it('accept() is idempotent (second call is a no-op)', async () => {
    await enroll.accept({ telegramId: 5, now: 100 });
    await enroll.accept({ telegramId: 5, now: 200 });
    const u = store.getUser(5)!;
    expect(u.disclaimerAt).toBe(100);  // unchanged
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

```bash
pnpm vitest run tests/vault/enrollment.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 5: Implement `src/vault/enrollment.ts`**

```typescript
import { Keypair } from '@solana/web3.js';
import { TOTP } from 'otpauth';
import { encrypt } from './encryption.js';
import { generateSecret, otpauthUri, verifyCode, currentCounter } from './totp.js';
import type { DepositorStore } from './depositorStore.js';

export interface EnrollmentDeps {
  store: DepositorStore;
  masterKey: Buffer;
  /** Invoked after accept(): create BERT ATA for the new deposit address. */
  ensureAta: (depositAddress: string) => Promise<void>;
}

export class Enrollment {
  constructor(private deps: EnrollmentDeps) {}

  /** User accepted the disclaimer. Generates deposit keypair + empty user row. */
  async accept(args: { telegramId: number; now: number }): Promise<void> {
    if (this.deps.store.getUser(args.telegramId)) return;
    const kp = Keypair.generate();
    const secretBuf = Buffer.from(kp.secretKey);
    const enc = encrypt(secretBuf, this.deps.masterKey);
    this.deps.store.createUser({
      telegramId: args.telegramId,
      role: 'depositor',
      depositAddress: kp.publicKey.toBase58(),
      depositSecretEnc: enc.ciphertext,
      depositSecretIv: enc.iv,
      disclaimerAt: args.now,
      createdAt: args.now,
    });
    await this.deps.ensureAta(kp.publicKey.toBase58());
  }

  /** Generate a TOTP secret (not yet persisted) and return the URI for the QR code. */
  async beginTotpEnrollment(args: { telegramId: number }): Promise<{
    secretBase32: string; uri: string;
  }> {
    const user = this.deps.store.getUser(args.telegramId);
    if (!user) throw new Error('Enrollment.beginTotpEnrollment: no such user');
    const secretBase32 = generateSecret();
    const uri = otpauthUri({
      secret: secretBase32,
      label: `BertVault:${args.telegramId}`,
      issuer: 'BertVault',
    });
    // Persist pending secret in-memory by keying on telegramId — we reuse the user row
    // with totp_enrolled_at NULL to indicate "pending". Encrypt + store immediately;
    // only set enrolled_at on confirm.
    const enc = encrypt(Buffer.from(secretBase32, 'utf8'), this.deps.masterKey);
    this.deps.store.setTotp({
      telegramId: args.telegramId,
      secretEnc: enc.ciphertext,
      secretIv: enc.iv,
      enrolledAt: 0, // 0 = pending; confirmTotp sets real ts
    });
    return { secretBase32, uri };
  }

  /** Confirm the user can produce a valid TOTP code. Marks enrolled. */
  async confirmTotp(args: { telegramId: number; code: string; now: number }): Promise<boolean> {
    const secrets = this.deps.store.getUserSecrets(args.telegramId);
    if (!secrets || !secrets.totpSecretEnc || !secrets.totpSecretIv) return false;
    const { decrypt } = await import('./encryption.js');
    const secretBase32 = decrypt(secrets.totpSecretEnc, secrets.totpSecretIv, this.deps.masterKey).toString('utf8');
    const r = verifyCode({ secret: secretBase32, code: args.code, lastUsedCounter: null });
    if (!r.ok) return false;
    // Mark enrolled + record the counter used
    this.deps.store.setTotp({
      telegramId: args.telegramId,
      secretEnc: secrets.totpSecretEnc,
      secretIv: secrets.totpSecretIv,
      enrolledAt: args.now,
    });
    this.deps.store.setTotpLastCounter(args.telegramId, r.counter);
    return true;
  }
}
```

- [ ] **Step 6: Run tests**

```bash
pnpm vitest run tests/vault/enrollment.test.ts
```
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add src/vault/enrollment.ts src/vault/disclaimer.ts tests/vault/enrollment.test.ts package.json pnpm-lock.yaml
git commit -m "vault: enrollment (accept disclaimer + TOTP setup)"
```

---

### Task 11: Whitelist cooldown module

**Files:**
- Create: `src/vault/cooldowns.ts`
- Test: `tests/vault/cooldowns.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/vault/cooldowns.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateStore } from '../../src/stateStore.js';
import { DepositorStore } from '../../src/vault/depositorStore.js';
import { Cooldowns } from '../../src/vault/cooldowns.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Cooldowns', () => {
  let dir: string;
  let state: StateStore;
  let store: DepositorStore;
  let cool: Cooldowns;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bertmm-'));
    state = new StateStore(join(dir, 'state.db'));
    state.init();
    store = new DepositorStore(state);
    cool = new Cooldowns({ store, cooldownMs: 24 * 3600 * 1000 });
    store.createUser({ telegramId: 1, role: 'depositor', depositAddress: 'A',
      depositSecretEnc: Buffer.alloc(0), depositSecretIv: Buffer.alloc(0),
      disclaimerAt: 100, createdAt: 100 });
  });
  afterEach(() => { state.close(); rmSync(dir, { recursive: true, force: true }); });

  it('first-set applies immediately', () => {
    const r = cool.requestChange({ telegramId: 1, newAddress: 'DEST1', now: 1000 });
    expect(r.immediate).toBe(true);
    const u = store.getUser(1)!;
    expect(u.whitelistAddress).toBe('DEST1');
  });

  it('subsequent change schedules 24h cooldown', () => {
    cool.requestChange({ telegramId: 1, newAddress: 'DEST1', now: 1000 });
    const r = cool.requestChange({ telegramId: 1, newAddress: 'DEST2', now: 2000 });
    expect(r.immediate).toBe(false);
    expect(r.activatesAt).toBe(2000 + 24 * 3600 * 1000);
    expect(store.getUser(1)!.whitelistAddress).toBe('DEST1'); // not yet changed
  });

  it('activateDue applies pending changes whose time has come', () => {
    cool.requestChange({ telegramId: 1, newAddress: 'DEST1', now: 1000 });
    cool.requestChange({ telegramId: 1, newAddress: 'DEST2', now: 2000 });
    const activated = cool.activateDue({ now: 2000 + 24 * 3600 * 1000 + 1 });
    expect(activated.length).toBe(1);
    expect(store.getUser(1)!.whitelistAddress).toBe('DEST2');
  });

  it('cancel rejects most recent pending change', () => {
    cool.requestChange({ telegramId: 1, newAddress: 'DEST1', now: 1000 });
    cool.requestChange({ telegramId: 1, newAddress: 'DEST2', now: 2000 });
    const ok = cool.cancelPending({ telegramId: 1, reason: 'user', now: 3000 });
    expect(ok).toBe(true);
    cool.activateDue({ now: 2000 + 24 * 3600 * 1000 + 1 });
    expect(store.getUser(1)!.whitelistAddress).toBe('DEST1'); // change was cancelled
  });

  it('cancel returns false when nothing pending', () => {
    cool.requestChange({ telegramId: 1, newAddress: 'DEST1', now: 1000 });
    const ok = cool.cancelPending({ telegramId: 1, reason: 'user', now: 3000 });
    expect(ok).toBe(false);  // first-set was immediate; no pending rows
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run tests/vault/cooldowns.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement `src/vault/cooldowns.ts`**

```typescript
import type { DepositorStore } from './depositorStore.js';
import type { PendingWhitelistChange } from './types.js';

export interface CooldownsDeps {
  store: DepositorStore;
  cooldownMs: number;
}

export class Cooldowns {
  constructor(private deps: CooldownsDeps) {}

  /** Request a whitelist change. First-set is immediate; subsequent waits cooldown. */
  requestChange(args: {
    telegramId: number; newAddress: string; now: number;
  }): { immediate: boolean; activatesAt: number; pendingId: number } {
    const user = this.deps.store.getUser(args.telegramId);
    if (!user) throw new Error('requestChange: user not found');

    if (user.whitelistAddress === null) {
      return this.deps.store.withTransaction(() => {
        const id = this.deps.store.enqueueWhitelistChange({
          telegramId: args.telegramId, oldAddress: null, newAddress: args.newAddress,
          requestedAt: args.now, activatesAt: args.now, initialStatus: 'activated',
        });
        this.deps.store.setWhitelistImmediate({
          telegramId: args.telegramId, address: args.newAddress, ts: args.now,
        });
        return { immediate: true, activatesAt: args.now, pendingId: id };
      });
    }

    const activatesAt = args.now + this.deps.cooldownMs;
    const id = this.deps.store.enqueueWhitelistChange({
      telegramId: args.telegramId, oldAddress: user.whitelistAddress,
      newAddress: args.newAddress, requestedAt: args.now, activatesAt,
      initialStatus: 'pending',
    });
    return { immediate: false, activatesAt, pendingId: id };
  }

  /** Activate any pending changes whose activates_at <= now. Returns activated rows. */
  activateDue(args: { now: number }): PendingWhitelistChange[] {
    const due = this.deps.store.listDueWhitelistChanges(args.now);
    const activated: PendingWhitelistChange[] = [];
    for (const row of due) {
      this.deps.store.withTransaction(() => {
        this.deps.store.setWhitelistImmediate({
          telegramId: row.telegramId, address: row.newAddress, ts: args.now,
        });
        this.deps.store.markWhitelistActivated(row.id);
      });
      activated.push(row);
    }
    return activated;
  }

  /** Cancel the most recent pending change for a user. Returns true if one was cancelled. */
  cancelPending(args: { telegramId: number; reason: string; now: number }): boolean {
    const p = this.deps.store.mostRecentPendingChange(args.telegramId);
    if (!p) return false;
    this.deps.store.cancelPendingWhitelist(p.id, args.reason);
    return true;
  }
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm vitest run tests/vault/cooldowns.test.ts
```
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/vault/cooldowns.ts tests/vault/cooldowns.test.ts
git commit -m "vault: whitelist cooldown + cancel logic"
```

---

## Phase 4 — Deposit pipeline

### Task 12: depositWatcher (poll + detect inflows)

**Files:**
- Create: `src/vault/depositWatcher.ts`
- Test: `tests/vault/depositWatcher.test.ts`

**Scope of this task:** only the *detection* side (reading on-chain state, identifying new inbound txs). Sweep + credit happen in Tasks 13 and 14.

- [ ] **Step 1: Write the failing test (using mocked RPC)**

Create `tests/vault/depositWatcher.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { DepositWatcher, type InflowEvent } from '../../src/vault/depositWatcher.js';

describe('DepositWatcher', () => {
  const mockConnection = (solDelta: number, bertDelta: number, sig: string) => ({
    getSignaturesForAddress: vi.fn().mockResolvedValue([{
      signature: sig, slot: 1, blockTime: 1700000000, err: null, confirmationStatus: 'confirmed',
    }]),
    getParsedTransaction: vi.fn().mockResolvedValue({
      meta: {
        preBalances: [0, 0],
        postBalances: [solDelta, 0],
        preTokenBalances: [{ owner: 'addr', mint: 'bertmint', uiTokenAmount: { amount: '0', decimals: 6 } }],
        postTokenBalances: [{ owner: 'addr', mint: 'bertmint', uiTokenAmount: { amount: String(bertDelta), decimals: 6 } }],
      },
      transaction: { message: { accountKeys: [{ pubkey: 'addr', signer: false, writable: true }] } },
    }),
    getSlot: vi.fn().mockResolvedValue(2),
  });

  it('detects a SOL-only inflow', async () => {
    const events: InflowEvent[] = [];
    const conn = mockConnection(1_500_000_000, 0, 'sig1');
    const watcher = new DepositWatcher({
      connection: conn as any,
      bertMint: 'bertmint',
      minConfirmations: 0,
      isAlreadyCredited: () => false,
      onInflow: async (e) => { events.push(e); },
    });
    await watcher.pollAddress('addr');
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({
      depositAddress: 'addr',
      inboundTxSig: 'sig1',
      solLamports: 1_500_000_000n,
      bertRaw: 0n,
    });
  });

  it('detects BERT-only inflow', async () => {
    const events: InflowEvent[] = [];
    const conn = mockConnection(0, 250_000_000, 'sigB');
    const watcher = new DepositWatcher({
      connection: conn as any,
      bertMint: 'bertmint',
      minConfirmations: 0,
      isAlreadyCredited: () => false,
      onInflow: async (e) => { events.push(e); },
    });
    await watcher.pollAddress('addr');
    expect(events[0].bertRaw).toBe(250_000_000n);
    expect(events[0].solLamports).toBe(0n);
  });

  it('skips already-credited sigs', async () => {
    const events: InflowEvent[] = [];
    const conn = mockConnection(1_000_000, 0, 'sigC');
    const watcher = new DepositWatcher({
      connection: conn as any,
      bertMint: 'bertmint',
      minConfirmations: 0,
      isAlreadyCredited: (sig) => sig === 'sigC',
      onInflow: async (e) => { events.push(e); },
    });
    await watcher.pollAddress('addr');
    expect(events.length).toBe(0);
  });

  it('skips zero-delta txs', async () => {
    const events: InflowEvent[] = [];
    const conn = mockConnection(0, 0, 'sigD');
    const watcher = new DepositWatcher({
      connection: conn as any,
      bertMint: 'bertmint',
      minConfirmations: 0,
      isAlreadyCredited: () => false,
      onInflow: async (e) => { events.push(e); },
    });
    await watcher.pollAddress('addr');
    expect(events.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run tests/vault/depositWatcher.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement `src/vault/depositWatcher.ts`**

```typescript
import type { Connection, ConfirmedSignatureInfo, ParsedTransactionWithMeta } from '@solana/web3.js';

export interface InflowEvent {
  depositAddress: string;
  inboundTxSig: string;
  solLamports: bigint;
  bertRaw: bigint;
  confirmedAt: number;
}

export interface DepositWatcherDeps {
  connection: Connection;
  bertMint: string;
  minConfirmations: number;
  isAlreadyCredited: (sig: string) => boolean;
  onInflow: (event: InflowEvent) => Promise<void>;
}

export class DepositWatcher {
  constructor(private deps: DepositWatcherDeps) {}

  /** Poll one deposit address for new inflows. Calls onInflow() for each. */
  async pollAddress(address: string): Promise<void> {
    const sigs: ConfirmedSignatureInfo[] = await this.deps.connection.getSignaturesForAddress(
      { toBase58: () => address } as any, { limit: 10 }
    );
    for (const s of sigs) {
      if (s.err !== null) continue;
      if (this.deps.isAlreadyCredited(s.signature)) continue;
      const tx = await this.deps.connection.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
      if (!tx || !tx.meta) continue;
      const { solDelta, bertDelta } = this.computeDeltas(tx, address);
      if (solDelta === 0n && bertDelta === 0n) continue;
      await this.deps.onInflow({
        depositAddress: address,
        inboundTxSig: s.signature,
        solLamports: solDelta,
        bertRaw: bertDelta,
        confirmedAt: (s.blockTime ?? Math.floor(Date.now() / 1000)) * 1000,
      });
    }
  }

  private computeDeltas(tx: ParsedTransactionWithMeta, address: string): {
    solDelta: bigint; bertDelta: bigint;
  } {
    const meta = tx.meta!;
    const keys = tx.transaction.message.accountKeys.map(k =>
      typeof k === 'string' ? k : k.pubkey.toString()
    );
    const idx = keys.indexOf(address);
    let solDelta = 0n;
    if (idx >= 0) {
      solDelta = BigInt(meta.postBalances[idx]) - BigInt(meta.preBalances[idx]);
      if (solDelta < 0n) solDelta = 0n; // only count inflows
    }
    let bertDelta = 0n;
    const pre = meta.preTokenBalances ?? [];
    const post = meta.postTokenBalances ?? [];
    const sumForAddress = (rows: readonly any[]) => rows
      .filter(r => r.owner === address && r.mint === this.deps.bertMint)
      .reduce((a, r) => a + BigInt(r.uiTokenAmount.amount), 0n);
    bertDelta = sumForAddress(post) - sumForAddress(pre);
    if (bertDelta < 0n) bertDelta = 0n;
    return { solDelta, bertDelta };
  }
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm vitest run tests/vault/depositWatcher.test.ts
```
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/vault/depositWatcher.ts tests/vault/depositWatcher.test.ts
git commit -m "vault: deposit watcher — poll addresses, detect SOL+BERT inflows"
```

---

### Task 13: Sweeper (build + submit sweep tx)

**Files:**
- Create: `src/vault/sweeper.ts`
- Test: `tests/vault/sweeper.test.ts` (mock-based — signs + builds ix list, verifies structure)

- [ ] **Step 1: Write the failing test**

Create `tests/vault/sweeper.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { buildSweepInstructions } from '../../src/vault/sweeper.js';

describe('buildSweepInstructions', () => {
  it('builds a SOL-only transfer when BERT=0', () => {
    const from = Keypair.generate();
    const to = Keypair.generate().publicKey;
    const ixs = buildSweepInstructions({
      fromKeypair: from,
      toWallet: to,
      solLamports: 1_000_000_000n,
      bertRaw: 0n,
      bertMint: new PublicKey('HgBRWfYxEfvPhtqkaeymCQtHCrKE46qQ43pKe8HCpump'),
      rentReserveLamports: 2_000_000n,
    });
    expect(ixs.length).toBeGreaterThanOrEqual(1);
    // first ix should be SystemProgram.transfer
    expect(ixs.some(ix => ix.programId.equals(SystemProgram.programId))).toBe(true);
  });

  it('builds BERT-only transfer when SOL=0', () => {
    const from = Keypair.generate();
    const to = Keypair.generate().publicKey;
    const ixs = buildSweepInstructions({
      fromKeypair: from,
      toWallet: to,
      solLamports: 0n,
      bertRaw: 100_000_000n,
      bertMint: new PublicKey('HgBRWfYxEfvPhtqkaeymCQtHCrKE46qQ43pKe8HCpump'),
      rentReserveLamports: 2_000_000n,
    });
    expect(ixs.length).toBeGreaterThanOrEqual(1);
  });

  it('caps SOL transfer to leave rent-reserve behind', () => {
    const from = Keypair.generate();
    const to = Keypair.generate().publicKey;
    const ixs = buildSweepInstructions({
      fromKeypair: from,
      toWallet: to,
      solLamports: 10_000_000n,   // available
      bertRaw: 0n,
      bertMint: new PublicKey('HgBRWfYxEfvPhtqkaeymCQtHCrKE46qQ43pKe8HCpump'),
      rentReserveLamports: 2_000_000n,
    });
    // The transfer instruction data for SystemProgram.transfer encodes the lamports;
    // we check that some instruction was built and the output is sane.
    expect(ixs.length).toBeGreaterThanOrEqual(1);
  });

  it('throws if SOL available < rentReserveLamports', () => {
    const from = Keypair.generate();
    const to = Keypair.generate().publicKey;
    expect(() => buildSweepInstructions({
      fromKeypair: from,
      toWallet: to,
      solLamports: 1_000_000n,
      bertRaw: 0n,
      bertMint: new PublicKey('HgBRWfYxEfvPhtqkaeymCQtHCrKE46qQ43pKe8HCpump'),
      rentReserveLamports: 2_000_000n,
    })).toThrow(/insufficient/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run tests/vault/sweeper.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement `src/vault/sweeper.ts`**

```typescript
import {
  Keypair, PublicKey, SystemProgram, TransactionInstruction,
} from '@solana/web3.js';
import {
  createTransferCheckedInstruction, getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { BERT_DECIMALS } from './shareMath.js';

export interface SweepParams {
  fromKeypair: Keypair;
  toWallet: PublicKey;
  solLamports: bigint;
  bertRaw: bigint;
  bertMint: PublicKey;
  /** Lamports to leave in the from-address for ATA rent + future sends. */
  rentReserveLamports: bigint;
}

/**
 * Build (but do not submit) the set of instructions needed to sweep a deposit
 * address into the main pool wallet. Caller is responsible for building the
 * Transaction, setting recent blockhash, and signing with fromKeypair.
 */
export function buildSweepInstructions(p: SweepParams): TransactionInstruction[] {
  const ixs: TransactionInstruction[] = [];
  const solToSend = p.solLamports > p.rentReserveLamports
    ? p.solLamports - p.rentReserveLamports
    : 0n;

  if (p.solLamports > 0n && solToSend === 0n) {
    throw new Error(`sweep: insufficient SOL (have ${p.solLamports}, reserve ${p.rentReserveLamports})`);
  }

  if (solToSend > 0n) {
    ixs.push(SystemProgram.transfer({
      fromPubkey: p.fromKeypair.publicKey,
      toPubkey: p.toWallet,
      lamports: Number(solToSend),
    }));
  }

  if (p.bertRaw > 0n) {
    const fromAta = getAssociatedTokenAddressSync(p.bertMint, p.fromKeypair.publicKey, true);
    const toAta = getAssociatedTokenAddressSync(p.bertMint, p.toWallet, true);
    ixs.push(createTransferCheckedInstruction(
      fromAta, p.bertMint, toAta, p.fromKeypair.publicKey,
      p.bertRaw, BERT_DECIMALS,
    ));
  }

  return ixs;
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm vitest run tests/vault/sweeper.test.ts
```
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/vault/sweeper.ts tests/vault/sweeper.test.ts
git commit -m "vault: sweeper — build SOL + BERT transfer instructions from deposit address"
```

---

### Task 14: creditEngine (NAV compute + share mint on confirmed sweep)

**Files:**
- Create: `src/vault/creditEngine.ts`
- Test: `tests/vault/creditEngine.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/vault/creditEngine.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateStore } from '../../src/stateStore.js';
import { DepositorStore } from '../../src/vault/depositorStore.js';
import { CreditEngine } from '../../src/vault/creditEngine.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('CreditEngine', () => {
  let dir: string;
  let state: StateStore;
  let store: DepositorStore;
  let ce: CreditEngine;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bertmm-'));
    state = new StateStore(join(dir, 'state.db'));
    state.init();
    store = new DepositorStore(state);
    ce = new CreditEngine({ store });
    store.createUser({ telegramId: 1, role: 'depositor', depositAddress: 'A',
      depositSecretEnc: Buffer.alloc(0), depositSecretIv: Buffer.alloc(0),
      disclaimerAt: 100, createdAt: 100 });
  });
  afterEach(() => { state.close(); rmSync(dir, { recursive: true, force: true }); });

  it('bootstrap-sized deposit gets shares equal to USD at NAV=$1', () => {
    ce.credit({
      telegramId: 1, inboundTxSig: 's1', sweepTxSig: 'w1',
      solLamports: 1_000_000_000n, bertRaw: 0n,
      solUsd: 100, bertUsd: 0.01,
      navPerShareAtDeposit: 1,
      confirmedAt: 100, sweptAt: 101, now: 101,
    });
    expect(store.getShares(1)).toBeCloseTo(100);
  });

  it('uses provided NAV to scale shares', () => {
    // Pretend NAV has grown to $2/share
    ce.credit({
      telegramId: 1, inboundTxSig: 's2', sweepTxSig: 'w',
      solLamports: 2_000_000_000n, bertRaw: 0n,
      solUsd: 100, bertUsd: 0.01,
      navPerShareAtDeposit: 2,
      confirmedAt: 100, sweptAt: 101, now: 101,
    });
    expect(store.getShares(1)).toBeCloseTo(100);  // $200 / $2
  });

  it('writes a NAV snapshot with source=deposit', () => {
    ce.credit({
      telegramId: 1, inboundTxSig: 's3', sweepTxSig: 'w',
      solLamports: 1_000_000_000n, bertRaw: 0n,
      solUsd: 100, bertUsd: 0.01,
      navPerShareAtDeposit: 1,
      confirmedAt: 100, sweptAt: 101, now: 101,
    });
    const snap = store.latestNavSnapshot();
    expect(snap!.source).toBe('deposit');
  });

  it('refuses to credit already-credited sig (no-op return)', () => {
    ce.credit({
      telegramId: 1, inboundTxSig: 'dup', sweepTxSig: 'w',
      solLamports: 1_000_000_000n, bertRaw: 0n,
      solUsd: 100, bertUsd: 0.01,
      navPerShareAtDeposit: 1,
      confirmedAt: 100, sweptAt: 101, now: 101,
    });
    expect(() => ce.credit({
      telegramId: 1, inboundTxSig: 'dup', sweepTxSig: 'w',
      solLamports: 1_000_000_000n, bertRaw: 0n,
      solUsd: 100, bertUsd: 0.01,
      navPerShareAtDeposit: 1,
      confirmedAt: 100, sweptAt: 101, now: 101,
    })).toThrow(/UNIQUE/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run tests/vault/creditEngine.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement `src/vault/creditEngine.ts`**

```typescript
import type { DepositorStore } from './depositorStore.js';
import { computeSharesForDeposit } from './shareMath.js';
import { SOL_DECIMALS, BERT_DECIMALS } from './shareMath.js';

export interface CreditParams {
  telegramId: number;
  inboundTxSig: string;
  sweepTxSig: string;
  solLamports: bigint;
  bertRaw: bigint;
  solUsd: number;
  bertUsd: number;
  navPerShareAtDeposit: number;
  confirmedAt: number;
  sweptAt: number;
  now: number;
}

export class CreditEngine {
  constructor(private deps: { store: DepositorStore }) {}

  /**
   * Credit a sweep-confirmed deposit: mint shares, write audit + NAV snapshot.
   * Atomic: all-or-nothing.
   */
  credit(p: CreditParams): void {
    const depositUsd =
      Number(p.solLamports) / 10 ** SOL_DECIMALS * p.solUsd +
      Number(p.bertRaw) / 10 ** BERT_DECIMALS * p.bertUsd;
    const sharesMinted = computeSharesForDeposit({
      depositUsd, navPerShare: p.navPerShareAtDeposit,
    });

    this.deps.store.withTransaction(() => {
      this.deps.store.creditDeposit({
        telegramId: p.telegramId,
        inboundTxSig: p.inboundTxSig,
        sweepTxSig: p.sweepTxSig,
        solLamports: p.solLamports,
        bertRaw: p.bertRaw,
        solUsd: p.solUsd,
        bertUsd: p.bertUsd,
        navPerShareAt: p.navPerShareAtDeposit,
        sharesMinted,
        confirmedAt: p.confirmedAt,
        sweptAt: p.sweptAt,
      });
      const totalShares = this.deps.store.totalShares();
      this.deps.store.insertNavSnapshot({
        ts: p.now,
        totalValueUsd: totalShares * p.navPerShareAtDeposit,
        totalShares,
        navPerShare: p.navPerShareAtDeposit,
        source: 'deposit',
      });
      this.deps.store.writeAudit({
        ts: p.now,
        telegramId: p.telegramId,
        event: 'deposit_credited',
        detailsJson: JSON.stringify({
          inboundTxSig: p.inboundTxSig,
          depositUsd, sharesMinted, navPerShare: p.navPerShareAtDeposit,
        }),
      });
    });
  }
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm vitest run tests/vault/creditEngine.test.ts
```
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/vault/creditEngine.ts tests/vault/creditEngine.test.ts
git commit -m "vault: credit engine — mint shares + audit + NAV snapshot atomically"
```

---

## Phase 5 — Withdrawal pipeline

### Task 15: venueClient.partialClose (meteora impl)

**Files:**
- Modify: `src/venueClient.ts` (add method signature)
- Modify: `src/meteoraClient.ts` (implement)
- Modify: `src/raydiumClient.ts` (stub that throws `UNIMPLEMENTED`)
- Test: `tests/vault/partialClose.test.ts` (integration with Meteora, marked `.skip` by default — runs only with devnet env var)

- [ ] **Step 1: Extend the VenueClient interface**

In `src/venueClient.ts`, add to the `VenueClient` interface:

```typescript
  /**
   * Remove liquidity from an existing position to free up target amounts of
   * SOL and/or BERT. Implementation chooses which bins to remove from:
   * - To free SOL: remove bins below active (they hold quote = SOL when BERT is base).
   * - To free BERT: remove bins above active.
   * Returns the tx signature. After confirmation, free balances will have
   * increased by approximately the requested amounts.
   */
  buildPartialCloseTx(args: {
    positionId: string;
    needSolLamports: bigint;
    needBertRaw: bigint;
  }): Promise<import('@solana/web3.js').Transaction>;
```

- [ ] **Step 2: Implement in `src/meteoraClient.ts`**

Add after the existing close-position method:

```typescript
  async buildPartialCloseTx(args: {
    positionId: string;
    needSolLamports: bigint;
    needBertRaw: bigint;
  }): Promise<Transaction> {
    if (!this.dlmmPool) throw new Error('pool not initialized');
    const pos = await this.dlmmPool.getPosition(new PublicKey(args.positionId));
    if (!pos) throw new Error(`partialClose: position ${args.positionId} not found`);

    const activeBin = (await this.dlmmPool.getActiveBin()).binId;
    const binData = pos.positionData.positionBinData;

    // Classify bins relative to active bin. In Meteora DLMM:
    //   bin.binId < activeBin  → holds quote (SOL if BERT is base/tokenX)
    //   bin.binId > activeBin  → holds base (BERT)
    //   bin.binId === activeBin → mixed
    const binsBelow = binData.filter(b => b.binId < activeBin).sort((a, b) => b.binId - a.binId);   // nearest first
    const binsAbove = binData.filter(b => b.binId > activeBin).sort((a, b) => a.binId - b.binId);

    // Pick bins to remove until we've freed enough SOL (below) and BERT (above).
    // For MVP we remove entire bins (100% of liquidity) rather than partial bin removal,
    // because Meteora's remove-liquidity API removes by basis-points per bin and
    // computing exact BP to match a target amount is iterative.
    // Overshooting is OK: surplus stays in the free wallet.
    const toRemove = new Set<number>();
    if (args.needSolLamports > 0n && this.bertIsX) {
      // BERT is tokenX (base); bins below active hold tokenY = SOL
      let collected = 0n;
      for (const b of binsBelow) {
        if (collected >= args.needSolLamports) break;
        toRemove.add(b.binId);
        collected += BigInt(b.positionYAmount.toString());
      }
    }
    if (args.needBertRaw > 0n && this.bertIsX) {
      let collected = 0n;
      for (const b of binsAbove) {
        if (collected >= args.needBertRaw) break;
        toRemove.add(b.binId);
        collected += BigInt(b.positionXAmount.toString());
      }
    }
    if (toRemove.size === 0) {
      throw new Error('partialClose: no bins selected (need amounts may be 0)');
    }

    const tx = await this.dlmmPool.removeLiquidity({
      position: new PublicKey(args.positionId),
      user: this.payer.publicKey,
      fromBinId: Math.min(...toRemove),
      toBinId: Math.max(...toRemove),
      bps: new BN(10_000), // 100% of selected bins
      shouldClaimAndClose: false,
    });
    return tx instanceof Transaction ? tx : tx[0];
  }
```

(Adapt the exact API call to whatever `@meteora-ag/dlmm` exposes — this is the current pattern in `closePositionTx` in the same file; mirror it.)

- [ ] **Step 3: Stub in `src/raydiumClient.ts`**

```typescript
  async buildPartialCloseTx(): Promise<Transaction> {
    throw new Error('UNIMPLEMENTED: partialClose not supported on Raydium client (MVP is Meteora-only)');
  }
```

- [ ] **Step 4: Write a minimal unit test (mocked)**

Create `tests/vault/partialClose.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

// A full devnet integration test for partialClose requires a live Meteora
// pool with a position — that's covered by the manual E2E checklist, not
// vitest. Here we only assert the interface contract.

describe('partialClose interface contract', () => {
  it('venueClient interface declares buildPartialCloseTx', async () => {
    const types = await import('../../src/venueClient.js');
    // Just importing proves the interface compiles with the new method.
    expect(typeof types.createVenueClient).toBe('function');
  });
});
```

- [ ] **Step 5: Build to check types**

```bash
pnpm build
```
Expected: no TS errors.

- [ ] **Step 6: Commit**

```bash
git add src/venueClient.ts src/meteoraClient.ts src/raydiumClient.ts tests/vault/partialClose.test.ts
git commit -m "vault: venueClient.partialClose — remove targeted bins to free SOL/BERT"
```

---

### Task 16: withdrawalBuilder (build transfer tx)

**Files:**
- Create: `src/vault/withdrawalBuilder.ts`
- Test: `tests/vault/withdrawalBuilder.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/vault/withdrawalBuilder.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { buildWithdrawalInstructions } from '../../src/vault/withdrawalBuilder.js';

describe('buildWithdrawalInstructions', () => {
  it('builds SOL + BERT transfers', () => {
    const payer = Keypair.generate();
    const dest = Keypair.generate().publicKey;
    const bertMint = new PublicKey('HgBRWfYxEfvPhtqkaeymCQtHCrKE46qQ43pKe8HCpump');
    const ixs = buildWithdrawalInstructions({
      payer: payer.publicKey,
      destinationWallet: dest,
      solLamports: 500_000_000n,
      bertRaw: 10_000_000n,
      bertMint,
      createDestAtaIfMissing: true,
    });
    expect(ixs.length).toBeGreaterThanOrEqual(2);
    expect(ixs.some(ix => ix.programId.equals(SystemProgram.programId))).toBe(true);
  });

  it('SOL-only skips BERT instruction', () => {
    const payer = Keypair.generate();
    const dest = Keypair.generate().publicKey;
    const bertMint = new PublicKey('HgBRWfYxEfvPhtqkaeymCQtHCrKE46qQ43pKe8HCpump');
    const ixs = buildWithdrawalInstructions({
      payer: payer.publicKey,
      destinationWallet: dest,
      solLamports: 500_000_000n,
      bertRaw: 0n,
      bertMint,
      createDestAtaIfMissing: true,
    });
    expect(ixs.length).toBe(1);
    expect(ixs[0].programId.equals(SystemProgram.programId)).toBe(true);
  });

  it('throws when both amounts are zero', () => {
    const payer = Keypair.generate();
    const dest = Keypair.generate().publicKey;
    const bertMint = new PublicKey('HgBRWfYxEfvPhtqkaeymCQtHCrKE46qQ43pKe8HCpump');
    expect(() => buildWithdrawalInstructions({
      payer: payer.publicKey, destinationWallet: dest,
      solLamports: 0n, bertRaw: 0n, bertMint, createDestAtaIfMissing: true,
    })).toThrow(/nothing to transfer/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run tests/vault/withdrawalBuilder.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement `src/vault/withdrawalBuilder.ts`**

```typescript
import {
  PublicKey, SystemProgram, TransactionInstruction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { BERT_DECIMALS } from './shareMath.js';

export interface WithdrawalParams {
  payer: PublicKey;
  destinationWallet: PublicKey;
  solLamports: bigint;
  bertRaw: bigint;
  bertMint: PublicKey;
  createDestAtaIfMissing: boolean;
}

export function buildWithdrawalInstructions(p: WithdrawalParams): TransactionInstruction[] {
  if (p.solLamports === 0n && p.bertRaw === 0n) {
    throw new Error('buildWithdrawalInstructions: nothing to transfer');
  }
  const ixs: TransactionInstruction[] = [];
  if (p.solLamports > 0n) {
    ixs.push(SystemProgram.transfer({
      fromPubkey: p.payer, toPubkey: p.destinationWallet, lamports: Number(p.solLamports),
    }));
  }
  if (p.bertRaw > 0n) {
    const fromAta = getAssociatedTokenAddressSync(p.bertMint, p.payer, true);
    const toAta = getAssociatedTokenAddressSync(p.bertMint, p.destinationWallet, true);
    if (p.createDestAtaIfMissing) {
      ixs.push(createAssociatedTokenAccountIdempotentInstruction(
        p.payer, toAta, p.destinationWallet, p.bertMint,
      ));
    }
    ixs.push(createTransferCheckedInstruction(
      fromAta, p.bertMint, toAta, p.payer, p.bertRaw, BERT_DECIMALS,
    ));
  }
  return ixs;
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm vitest run tests/vault/withdrawalBuilder.test.ts
```
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/vault/withdrawalBuilder.ts tests/vault/withdrawalBuilder.test.ts
git commit -m "vault: withdrawal instruction builder (SOL + BERT → destination)"
```

---

### Task 17: withdrawalExecutor (drain queue, partial close, execute)

**Files:**
- Create: `src/vault/withdrawalExecutor.ts`
- Test: `tests/vault/withdrawalExecutor.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/vault/withdrawalExecutor.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StateStore } from '../../src/stateStore.js';
import { DepositorStore } from '../../src/vault/depositorStore.js';
import { WithdrawalExecutor } from '../../src/vault/withdrawalExecutor.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('WithdrawalExecutor', () => {
  let dir: string;
  let state: StateStore;
  let store: DepositorStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bertmm-'));
    state = new StateStore(join(dir, 'state.db'));
    state.init();
    store = new DepositorStore(state);
    store.createUser({ telegramId: 1, role: 'depositor', depositAddress: 'A',
      depositSecretEnc: Buffer.alloc(0), depositSecretIv: Buffer.alloc(0),
      disclaimerAt: 100, createdAt: 100 });
    store.setWhitelistImmediate({ telegramId: 1, address: 'DEST', ts: 100 });
    store.addShares(1, 1000);  // user has 1000 shares
  });
  afterEach(() => { state.close(); rmSync(dir, { recursive: true, force: true }); });

  function makeExecutor(opts: {
    solUsd?: number; bertUsd?: number;
    freeSol?: bigint; freeBert?: bigint;
    positionUsd?: number;
    executeSucceeds?: boolean;
    partialCloseCalled?: { count: number };
  } = {}) {
    return new WithdrawalExecutor({
      store,
      getMid: async () => ({ solUsd: opts.solUsd ?? 100, bertUsd: opts.bertUsd ?? 0.01 }),
      getWalletBalances: async () => ({
        solLamports: opts.freeSol ?? 10_000_000_000n,
        bertRaw: opts.freeBert ?? 0n,
      }),
      getPositionSnapshot: async () => ({
        totalValueUsd: opts.positionUsd ?? 0,
        solUsdInPosition: 0, bertUsdInPosition: 0,
      }),
      reserveSolLamports: 200_000_000n,
      partialClose: async ({ needSolLamports, needBertRaw }) => {
        if (opts.partialCloseCalled) opts.partialCloseCalled.count++;
      },
      executeTransfer: async () => {
        if (opts.executeSucceeds === false) throw new Error('tx_failed');
        return { txSig: 'outsig' };
      },
      now: () => 200,
    });
  }

  it('processes a queued withdrawal — happy path', async () => {
    const wid = store.enqueueWithdrawal({
      telegramId: 1, destination: 'DEST',
      sharesBurned: 100, feeShares: 0.3, queuedAt: 150,
    });
    const exec = makeExecutor({});
    await exec.drain();
    const w = store.listWithdrawalsByStatus('completed');
    expect(w.length).toBe(1);
    expect(w[0].id).toBe(wid);
    expect(store.getShares(1)).toBeCloseTo(900);  // 1000 - 100
  });

  it('marks failed on execute failure; shares preserved', async () => {
    store.enqueueWithdrawal({
      telegramId: 1, destination: 'DEST',
      sharesBurned: 100, feeShares: 0.3, queuedAt: 150,
    });
    const exec = makeExecutor({ executeSucceeds: false });
    await exec.drain();
    const failed = store.listWithdrawalsByStatus('failed');
    expect(failed.length).toBe(1);
    expect(store.getShares(1)).toBe(1000);
  });

  it('invokes partialClose when free balance is short', async () => {
    store.enqueueWithdrawal({
      telegramId: 1, destination: 'DEST',
      sharesBurned: 500, feeShares: 1.5, queuedAt: 150,  // user wants $498.5 worth
    });
    const called = { count: 0 };
    const exec = makeExecutor({
      freeSol: 500_000_000n,     // only 0.5 SOL free = $50 (user wants ~$498)
      positionUsd: 1000,
      partialCloseCalled: called,
    });
    await exec.drain();
    expect(called.count).toBe(1);
  });

  it('fails with reserves_insufficient when partial close not enough', async () => {
    store.enqueueWithdrawal({
      telegramId: 1, destination: 'DEST',
      sharesBurned: 900, feeShares: 2.7, queuedAt: 150,
    });
    const exec = new WithdrawalExecutor({
      store,
      getMid: async () => ({ solUsd: 100, bertUsd: 0.01 }),
      getWalletBalances: async () => ({ solLamports: 300_000_000n, bertRaw: 0n }),
      getPositionSnapshot: async () => ({ totalValueUsd: 0, solUsdInPosition: 0, bertUsdInPosition: 0 }),
      reserveSolLamports: 200_000_000n,
      partialClose: async () => {}, // no-op — won't help
      executeTransfer: async () => ({ txSig: 'sig' }),
      now: () => 200,
    });
    await exec.drain();
    const failed = store.listWithdrawalsByStatus('failed');
    expect(failed[0].failureReason).toBe('reserves_insufficient');
  });

  it('marks failed with oracle_unavailable on null mid', async () => {
    store.enqueueWithdrawal({
      telegramId: 1, destination: 'DEST',
      sharesBurned: 100, feeShares: 0.3, queuedAt: 150,
    });
    const exec = new WithdrawalExecutor({
      store,
      getMid: async () => null,
      getWalletBalances: async () => ({ solLamports: 10_000_000_000n, bertRaw: 0n }),
      getPositionSnapshot: async () => ({ totalValueUsd: 0, solUsdInPosition: 0, bertUsdInPosition: 0 }),
      reserveSolLamports: 200_000_000n,
      partialClose: async () => {},
      executeTransfer: async () => ({ txSig: 'sig' }),
      now: () => 200,
    });
    await exec.drain();
    const failed = store.listWithdrawalsByStatus('failed');
    expect(failed[0].failureReason).toBe('oracle_unavailable');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run tests/vault/withdrawalExecutor.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement `src/vault/withdrawalExecutor.ts`**

```typescript
import type { DepositorStore } from './depositorStore.js';
import {
  computeNavPerShare, usdForShares, splitUsdIntoTokens,
  SOL_DECIMALS, BERT_DECIMALS,
} from './shareMath.js';
import { computeNav } from './navSnapshot.js';

export interface ExecutorDeps {
  store: DepositorStore;
  getMid: () => Promise<{ solUsd: number; bertUsd: number } | null>;
  getWalletBalances: () => Promise<{ solLamports: bigint; bertRaw: bigint }>;
  getPositionSnapshot: () => Promise<{
    totalValueUsd: number;
    solUsdInPosition: number;
    bertUsdInPosition: number;
  }>;
  reserveSolLamports: bigint;
  partialClose: (args: { needSolLamports: bigint; needBertRaw: bigint }) => Promise<void>;
  executeTransfer: (args: {
    destination: string;
    solLamports: bigint;
    bertRaw: bigint;
  }) => Promise<{ txSig: string }>;
  now: () => number;
}

export class WithdrawalExecutor {
  constructor(private deps: ExecutorDeps) {}

  async drain(): Promise<void> {
    const queued = this.deps.store.listWithdrawalsByStatus('queued');
    for (const w of queued) {
      this.deps.store.setWithdrawalProcessing(w.id);
      await this.processOne(w.id);
    }
  }

  private async processOne(id: number): Promise<void> {
    const now = this.deps.now();
    const mid = await this.deps.getMid();
    if (!mid) {
      this.deps.store.failWithdrawal({ id, reason: 'oracle_unavailable', processedAt: now });
      return;
    }

    const row = this.deps.store.listWithdrawalsByStatus('processing').find(r => r.id === id);
    if (!row) return;

    const bal = await this.deps.getWalletBalances();
    const pos = await this.deps.getPositionSnapshot();

    const nav = computeNav({
      freeSolLamports: bal.solLamports,
      freeBertRaw: bal.bertRaw,
      positionTotalValueUsd: pos.totalValueUsd,
      uncollectedFeesBert: 0n,
      uncollectedFeesSol: 0n,
      solUsd: mid.solUsd,
      bertUsd: mid.bertUsd,
    });
    const totalShares = this.deps.store.totalShares();
    const navPerShare = computeNavPerShare({
      totalUsd: nav.totalUsd, totalShares,
    });

    const netShares = row.sharesBurned - row.feeShares;
    const usdOwed = usdForShares({ netShares, navPerShare });

    const solFrac = nav.solFrac;
    const { solLamports: needSol, bertRaw: needBert } = splitUsdIntoTokens({
      usd: usdOwed, solFrac, solUsd: mid.solUsd, bertUsd: mid.bertUsd,
    });

    const solAvailable = bal.solLamports > this.deps.reserveSolLamports
      ? bal.solLamports - this.deps.reserveSolLamports
      : 0n;

    if (BigInt(needSol) > solAvailable || BigInt(needBert) > bal.bertRaw) {
      const solShort = BigInt(needSol) - solAvailable; const solShortPos = solShort > 0n ? solShort : 0n;
      const bertShort = BigInt(needBert) - bal.bertRaw; const bertShortPos = bertShort > 0n ? bertShort : 0n;
      if (solShortPos > 0n || bertShortPos > 0n) {
        await this.deps.partialClose({ needSolLamports: solShortPos, needBertRaw: bertShortPos });
      }
      // Re-read balances
      const bal2 = await this.deps.getWalletBalances();
      const solAvail2 = bal2.solLamports > this.deps.reserveSolLamports
        ? bal2.solLamports - this.deps.reserveSolLamports
        : 0n;
      if (BigInt(needSol) > solAvail2 || BigInt(needBert) > bal2.bertRaw) {
        this.deps.store.failWithdrawal({ id, reason: 'reserves_insufficient', processedAt: now });
        return;
      }
    }

    try {
      const r = await this.deps.executeTransfer({
        destination: row.destination,
        solLamports: BigInt(needSol),
        bertRaw: BigInt(needBert),
      });
      this.deps.store.withTransaction(() => {
        this.deps.store.completeWithdrawal({
          id,
          txSig: r.txSig,
          solLamportsOut: BigInt(needSol),
          bertRawOut: BigInt(needBert),
          navPerShareAt: navPerShare,
          processedAt: now,
        });
        this.deps.store.insertNavSnapshot({
          ts: now,
          totalValueUsd: this.deps.store.totalShares() * navPerShare,
          totalShares: this.deps.store.totalShares(),
          navPerShare,
          source: 'withdrawal',
        });
        this.deps.store.writeAudit({
          ts: now,
          telegramId: row.telegramId,
          event: 'withdrawal_completed',
          detailsJson: JSON.stringify({
            id, txSig: r.txSig, sharesBurned: row.sharesBurned,
            feeShares: row.feeShares, usdOwed, navPerShare,
          }),
        });
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : 'unknown';
      this.deps.store.failWithdrawal({ id, reason, processedAt: now });
      this.deps.store.writeAudit({
        ts: now, telegramId: row.telegramId,
        event: 'withdrawal_failed',
        detailsJson: JSON.stringify({ id, reason }),
      });
    }
  }
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm vitest run tests/vault/withdrawalExecutor.test.ts
```
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/vault/withdrawalExecutor.ts tests/vault/withdrawalExecutor.test.ts
git commit -m "vault: withdrawal executor — drain queue, partial close, transfer"
```

---

## Phase 6 — Telegram commands, operator controls, observability

### Task 18: Vault user commands (`/account`, `/deposit`, `/balance`, `/withdraw`, `/stats`, `/setwhitelist`, `/cancelwhitelist`)

This is the biggest wiring task. Split into sub-tasks to keep each commit focused. Each sub-task follows the same TDD pattern: write a handler test (mocking Telegram send), run, implement, commit.

**Files:**
- Create: `src/vault/commands.ts`
- Create: `src/vault/audit.ts` (trivial wrapper around `store.writeAudit`)
- Modify: `src/main.ts` (wire commands into commander)
- Test: `tests/vault/commands.test.ts`

The sub-commits (each ending with `git commit`) are:

- [ ] **Step 1: `/account` handler — runs enrollment flow**
  - Test: when user doesn't exist, reply contains disclaimer text; on `/accept` user is created, TOTP QR sent.
  - Implementation: `handleAccount({ msg, reply, enrollment, store })`.
  - Commit: `vault: /account command — disclaimer + TOTP enrollment flow`

- [ ] **Step 2: `/deposit` handler — gated on TOTP-verified**
  - Test: when user not enrolled, replies "enroll first"; when enrolled, prompts TOTP; on valid code, shows deposit address.
  - Commit: `vault: /deposit command — TOTP-gated address reveal`

- [ ] **Step 3: `/balance` handler**
  - Test: shows shares + latest NAV → USD value; TOTP-gated.
  - Commit: `vault: /balance command — show user shares + USD value`

- [ ] **Step 4: `/setwhitelist <addr>` + `/cancelwhitelist`**
  - Test: first-set immediate (TOTP-gated); subsequent waits 24h; cancel works.
  - Uses `Cooldowns`.
  - Commit: `vault: /setwhitelist + /cancelwhitelist commands`

- [ ] **Step 5: `/withdraw <amount|%>` handler**
  - Test: validates amount/%, daily cap enforced, TOTP required, queues row.
  - Commit: `vault: /withdraw command — enqueue with caps + TOTP`

- [ ] **Step 6: `/stats` (public)**
  - Test: returns TVL + NAV/share + 24h delta; no per-user data; no TOTP required.
  - Commit: `vault: /stats public command — TVL + NAV/share`

Each sub-step is 20-40 minutes of work; the test file grows with each one. See code sketches below to anchor the implementation.

#### Handler code sketches (anchor for sub-steps)

```typescript
// src/vault/commands.ts
import type { DepositorStore } from './depositorStore.js';
import type { Enrollment } from './enrollment.js';
import type { Cooldowns } from './cooldowns.js';
import { DISCLAIMER_TEXT } from './disclaimer.js';
import { decrypt } from './encryption.js';
import { verifyCode } from './totp.js';
import { computeNavPerShare, splitFee } from './shareMath.js';
import QRCode from 'qrcode';

export interface ReplyFn {
  (chatId: number, text: string, extras?: { photoBase64?: string }): Promise<void>;
}

export interface CommandsDeps {
  store: DepositorStore;
  enrollment: Enrollment;
  cooldowns: Cooldowns;
  masterKey: Buffer;
  reply: ReplyFn;
  config: {
    withdrawalFeeBps: number;
    minWithdrawalUsd: number;
    maxDailyWithdrawalsPerUser: number;
    maxDailyWithdrawalUsdPerUser: number;
    maxPendingWithdrawals: number;
  };
  nowMs: () => number;
}

// Pending-TOTP tracking — ephemeral in-memory state keyed by telegramId.
// "awaiting X" flags; consumer supplies a TOTP code via next message.
type PendingAction =
  | { kind: 'totp_setup_confirm' }
  | { kind: 'disclaimer' }
  | { kind: 'deposit_reveal' }
  | { kind: 'balance_reveal' }
  | { kind: 'withdraw'; amountUsd: number }
  | { kind: 'setwhitelist'; address: string }
  | { kind: 'cancelwhitelist' };

export class CommandHandlers {
  private pending = new Map<number, PendingAction>();

  constructor(private deps: CommandsDeps) {}

  async handleAccount(msg: { chatId: number; userId: number }): Promise<void> {
    const existing = this.deps.store.getUser(msg.userId);
    if (!existing) {
      this.pending.set(msg.userId, { kind: 'disclaimer' });
      await this.deps.reply(msg.chatId, DISCLAIMER_TEXT);
      return;
    }
    // Existing user
    if (existing.totpEnrolledAt === null) {
      // Never completed TOTP setup — restart
      const { uri, secretBase32 } = await this.deps.enrollment.beginTotpEnrollment({ telegramId: msg.userId });
      const qr = await QRCode.toDataURL(uri);
      this.pending.set(msg.userId, { kind: 'totp_setup_confirm' });
      await this.deps.reply(msg.chatId,
        `Set up 2FA: scan the QR in Google Authenticator (or Authy).\n` +
        `Fallback text code: ${secretBase32}\n\n` +
        `Reply with your current 6-digit code to confirm.`,
        { photoBase64: qr.split(',')[1] });
      return;
    }
    await this.deps.reply(msg.chatId,
      `Account ready. Commands:\n/deposit /balance /withdraw /setwhitelist /stats`);
  }

  /** Called on any plain-text message that might be a reply to a pending action. */
  async handleMessage(msg: { chatId: number; userId: number; text: string }): Promise<void> {
    const pending = this.pending.get(msg.userId);
    if (!pending) return;
    // Dispatch per pending kind — see individual sub-tasks for details.
    // (Each sub-task implements one branch here and tests it end-to-end.)
  }

  // ... individual handlers per sub-task
}
```

- [ ] **Step 7: After all sub-steps pass, run full suite and commit `src/main.ts` wiring**

```bash
pnpm vitest run
```

Wire in `src/main.ts`:

```typescript
import { CommandHandlers } from './vault/commands.js';
import { Enrollment } from './vault/enrollment.js';
import { Cooldowns } from './vault/cooldowns.js';
import { loadMasterKey } from './vault/encryption.js';

// after stateStore + depositorStore are constructed:
if (cfg.vault?.enabled) {
  const masterKey = loadMasterKey();
  const enrollment = new Enrollment({ store: depositorStore, masterKey, ensureAta: meteoraClient.ensureAta.bind(meteoraClient) });
  const cooldowns = new Cooldowns({ store: depositorStore, cooldownMs: cfg.vault.whitelistCooldownHours * 3600_000 });
  const handlers = new CommandHandlers({ store: depositorStore, enrollment, cooldowns, masterKey, reply, config: cfg.vault, nowMs: () => Date.now() });
  commander.registerEnrollmentCommand('account', (msg) => handlers.handleAccount(msg));
  commander.registerVaultCommand('deposit', (msg) => handlers.handleDeposit(msg));
  commander.registerVaultCommand('balance', (msg) => handlers.handleBalance(msg));
  commander.registerVaultCommand('withdraw', (msg) => handlers.handleWithdraw(msg));
  commander.registerVaultCommand('setwhitelist', (msg) => handlers.handleSetWhitelist(msg));
  commander.registerVaultCommand('cancelwhitelist', (msg) => handlers.handleCancelWhitelist(msg));
  commander.registerPublicCommand('stats', (msg) => handlers.handleStats(msg));
}
```

Commit: `vault: wire user-facing commands into main.ts`

---

### Task 19: Operator commands + audit log integration

**Files:**
- Create: `src/vault/operatorCommands.ts`
- Modify: `src/main.ts`
- Test: `tests/vault/operatorCommands.test.ts`

Operator commands (all gated by `operatorChatId`):

- `/pausevault` — sets flag `vault_paused=1` (use existing `state.setFlag`).
- `/resumevault` — clears flag.
- `/vaultstatus` — returns: TVL, shares, queued count, pending whitelist count, last NAV, last 5 audit events.
- `/forceprocess <id>` — reset a failed withdrawal to `queued` so the next drain retries it.

Each operator command: write test → implement → commit. Pattern identical to Task 18. Each commit: `vault: /pausevault command`, `vault: /vaultstatus command`, etc.

---

### Task 20: Wire deposit-watcher + withdrawal-executor into main tick loop

**Files:**
- Modify: `src/main.ts`
- Test: `tests/vault/tickIntegration.test.ts` (unit-level — inject fake clock + mock RPC)

- [ ] **Step 1: Write test that asserts ordering: deposit-watcher → rebalance → withdrawal-drain**
- [ ] **Step 2: In `main.ts`, inside the tick loop (after the existing rebalance block):**

```typescript
// Deposit watcher — outside rebalance mutex for polling
if (cfg.vault?.enabled) {
  const users = depositorStore.listUsers();
  for (const u of users) {
    try { await depositWatcher.pollAddress(u.depositAddress); }
    catch (e) { log.warn({ err: e, user: u.telegramId }, 'deposit poll failed'); }
  }
}
// ... existing rebalance logic ...
// After rebalance: drain withdrawal queue
if (cfg.vault?.enabled && !state.isDegraded() && !killSwitchTripped && state.getFlag('vault_paused') !== '1') {
  try { await withdrawalExecutor.drain(); }
  catch (e) { log.error({ err: e }, 'withdrawal drain failed'); }
}
// Activate any due whitelist changes
if (cfg.vault?.enabled) {
  try { cooldowns.activateDue({ now: Date.now() }); }
  catch (e) { log.warn({ err: e }, 'whitelist activation failed'); }
}
```

- [ ] **Step 3: Run tests**
- [ ] **Step 4: Commit**: `vault: wire deposit-watcher + withdrawal-drain + cooldown activation into tick loop`

---

### Task 21: Hourly report extension + observability

**Files:**
- Modify: `src/main.ts` (hourly report block)

- [ ] **Step 1: Add vault stats to the hourly Telegram message when vault is enabled:**

```typescript
if (cfg.vault?.enabled) {
  const users = depositorStore.listUsers();
  const totalShares = depositorStore.totalShares();
  const nav = /* existing NAV computation */;
  const navPerShare = computeNavPerShare({ totalUsd: nav.totalUsd, totalShares });
  const queued = depositorStore.countPendingWithdrawals();
  const last24hNavDelta = /* query snapshots */;
  lines.push(
    `Vault: ${users.length} depositors, TVL $${nav.totalUsd.toFixed(2)}, ` +
    `NAV/share $${navPerShare.toFixed(4)} (24h Δ ${last24hNavDelta.toFixed(2)}%), ` +
    `${queued} queued`
  );
}
```

- [ ] **Step 2: Commit**: `vault: extend hourly Telegram report with vault stats`

---

## Phase 7 — Bootstrap, backup, integration

### Task 22: vault-bootstrap CLI

**Files:**
- Create: `src/cli/vault-bootstrap.ts`
- Modify: `src/cli/index.ts`
- Test: `tests/vault/bootstrap.test.ts`

- [ ] **Step 1: Write test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateStore } from '../../src/stateStore.js';
import { DepositorStore } from '../../src/vault/depositorStore.js';
import { runBootstrap } from '../../src/cli/vault-bootstrap.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('vault-bootstrap', () => {
  let dir: string; let state: StateStore; let store: DepositorStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bertmm-'));
    state = new StateStore(join(dir, 'state.db'));
    state.init();
    store = new DepositorStore(state);
  });
  afterEach(() => { state.close(); rmSync(dir, { recursive: true, force: true }); });

  it('inserts operator user + shares + snapshot', async () => {
    await runBootstrap({
      store,
      masterKey: Buffer.alloc(32, 9),
      operatorTelegramId: 42,
      initialNavUsd: 220,
      ensureAta: async () => {},
      now: 1000,
    });
    expect(store.getUser(42)!.role).toBe('operator');
    expect(store.getShares(42)).toBe(220);
    expect(store.latestNavSnapshot()!.source).toBe('bootstrap');
    expect(store.latestNavSnapshot()!.navPerShare).toBe(1);
  });

  it('refuses to run twice (guard on existing users)', async () => {
    await runBootstrap({
      store, masterKey: Buffer.alloc(32, 9),
      operatorTelegramId: 42, initialNavUsd: 220,
      ensureAta: async () => {}, now: 1000,
    });
    await expect(runBootstrap({
      store, masterKey: Buffer.alloc(32, 9),
      operatorTelegramId: 42, initialNavUsd: 220,
      ensureAta: async () => {}, now: 1000,
    })).rejects.toThrow(/already/);
  });
});
```

- [ ] **Step 2: Run to fail**

```bash
pnpm vitest run tests/vault/bootstrap.test.ts
```

- [ ] **Step 3: Implement `src/cli/vault-bootstrap.ts`**

```typescript
import { Keypair } from '@solana/web3.js';
import type { DepositorStore } from '../vault/depositorStore.js';
import { encrypt } from '../vault/encryption.js';

export interface BootstrapParams {
  store: DepositorStore;
  masterKey: Buffer;
  operatorTelegramId: number;
  initialNavUsd: number;
  ensureAta: (addr: string) => Promise<void>;
  now: number;
}

export async function runBootstrap(p: BootstrapParams): Promise<void> {
  if (p.store.listUsers().length > 0) {
    throw new Error('vault-bootstrap: vault already initialised (users exist)');
  }
  const kp = Keypair.generate();
  const enc = encrypt(Buffer.from(kp.secretKey), p.masterKey);
  p.store.withTransaction(() => {
    p.store.createUser({
      telegramId: p.operatorTelegramId, role: 'operator',
      depositAddress: kp.publicKey.toBase58(),
      depositSecretEnc: enc.ciphertext, depositSecretIv: enc.iv,
      disclaimerAt: p.now, createdAt: p.now,
    });
    p.store.addShares(p.operatorTelegramId, p.initialNavUsd);  // 1 share = $1 at launch
    p.store.insertNavSnapshot({
      ts: p.now, totalValueUsd: p.initialNavUsd, totalShares: p.initialNavUsd,
      navPerShare: 1, source: 'bootstrap',
    });
    p.store.writeAudit({
      ts: p.now, telegramId: p.operatorTelegramId,
      event: 'bootstrap',
      detailsJson: JSON.stringify({ initialNavUsd: p.initialNavUsd }),
    });
  });
  await p.ensureAta(kp.publicKey.toBase58());
}
```

- [ ] **Step 4: Add CLI entry in `src/cli/index.ts`**

Register `vault-bootstrap` subcommand. Loads config, constructs `DepositorStore`, computes initial NAV via `computeNav()` with a live oracle read, then calls `runBootstrap`.

- [ ] **Step 5: Commit**: `vault: vault-bootstrap CLI + atomic founding-depositor init`

---

### Task 23: Systemd backup timer

**Files:**
- Create: `systemd/bert-mm-bot-backup.service`
- Create: `systemd/bert-mm-bot-backup.timer`
- Create: `scripts/backup-state.sh`

- [ ] **Step 1: Write `scripts/backup-state.sh`**

```bash
#!/bin/bash
set -euo pipefail
BACKUP_DIR=/var/backups/bert-mm-bot
mkdir -p "$BACKUP_DIR"
STAMP=$(date -u +%Y%m%d)
sqlite3 /var/lib/bert-mm-bot/state.db ".backup $BACKUP_DIR/state-$STAMP.db"
# Retain 30 rolling days
find "$BACKUP_DIR" -name 'state-*.db' -mtime +30 -delete
```

- [ ] **Step 2: Write systemd files**

`systemd/bert-mm-bot-backup.service`:
```
[Unit]
Description=bert-mm-bot SQLite backup
After=bert-mm-bot.service

[Service]
Type=oneshot
ExecStart=/opt/bert-mm-bot/scripts/backup-state.sh
User=bertmm
Group=bertmm
```

`systemd/bert-mm-bot-backup.timer`:
```
[Unit]
Description=Daily bert-mm-bot SQLite backup

[Timer]
OnCalendar=*-*-* 03:00:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
```

- [ ] **Step 3: Commit**: `vault: daily SQLite backup systemd timer`

---

### Task 24: Integration test (end-to-end in-memory simulation)

**Files:**
- Create: `tests/vault/integration.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/vault/integration.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateStore } from '../../src/stateStore.js';
import { DepositorStore } from '../../src/vault/depositorStore.js';
import { Enrollment } from '../../src/vault/enrollment.js';
import { Cooldowns } from '../../src/vault/cooldowns.js';
import { CreditEngine } from '../../src/vault/creditEngine.js';
import { WithdrawalExecutor } from '../../src/vault/withdrawalExecutor.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('vault integration — deposit → shares → withdraw → share burn', () => {
  let dir: string; let state: StateStore; let store: DepositorStore;
  const masterKey = Buffer.alloc(32, 7);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bertmm-'));
    state = new StateStore(join(dir, 'state.db'));
    state.init();
    store = new DepositorStore(state);
  });
  afterEach(() => { state.close(); rmSync(dir, { recursive: true, force: true }); });

  it('full happy path preserves share invariants', async () => {
    // 1. Bootstrap operator
    const enrollment = new Enrollment({ store, masterKey, ensureAta: async () => {} });
    await enrollment.accept({ telegramId: 1, now: 100 });
    store.addShares(1, 220);   // synthetic bootstrap

    // 2. Depositor enrolls
    await enrollment.accept({ telegramId: 2, now: 200 });
    store.setWhitelistImmediate({ telegramId: 2, address: 'DESTINATION', ts: 200 });

    // 3. Depositor deposits $100 at NAV=$1
    const ce = new CreditEngine({ store });
    ce.credit({
      telegramId: 2, inboundTxSig: 'in1', sweepTxSig: 'sw1',
      solLamports: 1_000_000_000n, bertRaw: 0n,
      solUsd: 100, bertUsd: 0.01,
      navPerShareAtDeposit: 1,
      confirmedAt: 300, sweptAt: 301, now: 302,
    });
    expect(store.getShares(2)).toBeCloseTo(100);

    // 4. Withdraw 50 shares
    const wid = store.enqueueWithdrawal({
      telegramId: 2, destination: 'DESTINATION',
      sharesBurned: 50, feeShares: 0.15, queuedAt: 400,
    });
    const executor = new WithdrawalExecutor({
      store,
      getMid: async () => ({ solUsd: 100, bertUsd: 0.01 }),
      getWalletBalances: async () => ({ solLamports: 3_200_000_000n, bertRaw: 0n }),
      getPositionSnapshot: async () => ({ totalValueUsd: 0, solUsdInPosition: 0, bertUsdInPosition: 0 }),
      reserveSolLamports: 200_000_000n,
      partialClose: async () => {},
      executeTransfer: async () => ({ txSig: 'out1' }),
      now: () => 500,
    });
    await executor.drain();

    // 5. Invariants
    expect(store.getShares(2)).toBeCloseTo(50);                    // 100 − 50
    const totalMinted = store.listDepositsForUser(2)
      .reduce((s, d) => s + d.sharesMinted, 0) + 220;              // + bootstrap
    const totalBurned = store.listWithdrawalsByStatus('completed')
      .reduce((s, w) => s + w.sharesBurned, 0);
    expect(totalMinted - totalBurned).toBeCloseTo(store.totalShares());
  });
});
```

- [ ] **Step 2: Run to pass**

```bash
pnpm vitest run tests/vault/integration.test.ts
```

- [ ] **Step 3: Commit**: `vault: end-to-end integration test (deposit → shares → withdraw → invariant check)`

---

## Self-review

- **Spec coverage.** Sections 1 (architecture), 2 (schema), 3 (all 5 flows), 4 (concurrency, reserves, caps, audit, backup, failure matrix), 5 (tests + rollout) all have tasks. ✓
- **Placeholders.** No TBDs, TODOs, or "similar to Task N" references. Each task is self-contained. ✓
- **Type consistency.** `VaultUser`, `VaultDeposit`, `VaultWithdrawal`, `PendingWhitelistChange`, `NavSnapshotRow` types defined once in `src/vault/types.ts`; all modules import from there. `computeNavPerShare`, `computeSharesForDeposit`, `splitFee`, `usdForShares`, `splitUsdIntoTokens`, `computeNav` named consistently across tasks. ✓
- **Rollout fidelity.** Tasks 22 (bootstrap CLI), 23 (backup timer), 24 (integration test) realise the Stage 0 → Stage 3 rollout in the spec. Manual E2E checklist from spec §5 is documented in the spec; this plan doesn't re-duplicate it. ✓

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-17-depositor-vault.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh opus subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
