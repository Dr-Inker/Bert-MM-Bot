# BERT Market-Maker Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an autonomous Raydium CLMM position manager that actively market-makes BERT/SOL with $2k of project treasury, tightening effective spread and earning fees while enforcing treasury-grade safety guardrails.

**Architecture:** Single Node.js daemon written in TypeScript. Eight focused modules: `config`, `stateStore`, `priceOracle`, `strategy` (pure decision function), `raydiumClient` (thin SDK wrapper), `txSubmitter` (only signer), `notifier` (webhook only), and `main` (orchestrator). A separate `cli` entry point wraps the same modules for operator commands. SQLite holds state; systemd supervises the process. The strategy module is pure and exhaustively unit-tested.

**Tech Stack:** TypeScript 5 / Node.js 22 LTS, pnpm, `@raydium-io/raydium-sdk-v2`, `@solana/web3.js`, `@solana/spl-token`, `@coral-xyz/anchor`, `better-sqlite3`, `pino`, `zod`, `vitest`, systemd.

**Reference:** Full design rationale lives at `docs/superpowers/specs/2026-04-09-bert-mm-bot-design.md`. Read it before starting.

**Working directory for all paths in this plan:** `/opt/bert-mm-bot`.

---

## File Structure

```
/opt/bert-mm-bot/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── .gitignore
├── .prettierrc.json
├── README.md
├── config.example.yaml
├── docs/superpowers/
│   ├── specs/2026-04-09-bert-mm-bot-design.md
│   └── plans/2026-04-09-bert-mm-bot.md
├── src/
│   ├── types.ts
│   ├── logger.ts
│   ├── config.ts
│   ├── stateStore.ts
│   ├── priceOracle.ts
│   ├── notifier.ts
│   ├── strategy.ts
│   ├── raydiumClient.ts
│   ├── txSubmitter.ts
│   ├── reconciler.ts
│   ├── main.ts
│   └── cli/
│       ├── index.ts
│       ├── status.ts
│       ├── pause.ts
│       ├── collect-fees.ts
│       ├── emergency-exit.ts
│       ├── force-rebalance.ts
│       ├── report.ts
│       ├── clear-degraded.ts
│       └── reconcile.ts
├── tests/
│   ├── config.test.ts
│   ├── stateStore.test.ts
│   ├── priceOracle.test.ts
│   ├── strategy.test.ts
│   ├── notifier.test.ts
│   ├── reconciler.test.ts
│   └── fixtures/valid-config.yaml
├── scripts/rescue-tx.ts
├── systemd/bert-mm-bot.service
└── ops/
    ├── logrotate.conf
    └── heartbeat-check.sh
```

Each file has one responsibility. The strategy module is pure and exhaustively unit-tested; raydiumClient is the only module that imports the Raydium SDK; txSubmitter is the only module that signs; notifier is the only egress channel; main is a dumb orchestrator.

---

## Task 1: Project scaffolding

**Files:**
- Create: `/opt/bert-mm-bot/package.json`
- Create: `/opt/bert-mm-bot/tsconfig.json`
- Create: `/opt/bert-mm-bot/vitest.config.ts`
- Create: `/opt/bert-mm-bot/.gitignore`
- Create: `/opt/bert-mm-bot/.prettierrc.json`

- [ ] **Step 1.1: Initialize git repo**

```bash
cd /opt/bert-mm-bot
git init
git branch -M main
```

- [ ] **Step 1.2: Create `package.json`**

```json
{
  "name": "bert-mm-bot",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/main.js",
    "cli": "node dist/cli/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "tsc --noEmit",
    "format": "prettier --write ."
  },
  "dependencies": {
    "@coral-xyz/anchor": "^0.30.0",
    "@raydium-io/raydium-sdk-v2": "^0.1.95",
    "@solana/spl-token": "^0.4.6",
    "@solana/web3.js": "^1.95.0",
    "better-sqlite3": "^11.3.0",
    "commander": "^12.1.0",
    "dotenv": "^16.4.5",
    "pino": "^9.4.0",
    "pino-pretty": "^11.2.2",
    "yaml": "^2.5.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^22.5.0",
    "prettier": "^3.3.3",
    "typescript": "^5.5.0",
    "vitest": "^2.0.5"
  }
}
```

- [ ] **Step 1.3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noImplicitAny": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 1.4: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10000,
  },
});
```

- [ ] **Step 1.5: Create `.gitignore`**

```
node_modules/
dist/
*.log
.env
.env.*
!.env.example
coverage/
*.tsbuildinfo
state.db
state.db-*
```

- [ ] **Step 1.6: Create `.prettierrc.json`**

```json
{
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "semi": true
}
```

- [ ] **Step 1.7: Install and verify**

```bash
cd /opt/bert-mm-bot
pnpm install
```

Expected: successful install.

- [ ] **Step 1.8: Commit**

```bash
git add -A
git commit -m "chore: project scaffolding"
```

---

## Task 2: Shared types module

**Files:**
- Create: `/opt/bert-mm-bot/src/types.ts`

- [ ] **Step 2.1: Create `src/types.ts`**

```ts
export type Usd = number;
export type SolLamports = bigint;
export type BertRaw = bigint;

export interface MidPrice {
  bertPerSol: number;
  bertUsd: number;
  solUsd: number;
  ts: number;
  sources: string[];
}

export interface Range {
  lowerBertUsd: number;
  upperBertUsd: number;
  centerBertUsd: number;
  widthPct: number;
}

export interface PositionSnapshot {
  nftMint: string;
  range: Range;
  bertAmount: BertRaw;
  solAmount: SolLamports;
  uncollectedFeesBert: BertRaw;
  uncollectedFeesSol: SolLamports;
  totalValueUsd: Usd;
  openedAt: number;
}

export interface BotState {
  price: MidPrice | null;
  priceHistory: MidPrice[];
  position: PositionSnapshot | null;
  lastRebalanceAt: number | null;
  rebalancesToday: number;
  killSwitchTripped: boolean;
  degraded: boolean;
  now: number;
}

export type Decision =
  | { kind: 'HOLD'; reason: string }
  | { kind: 'REBALANCE'; reason: string; newCenterUsd: number }
  | { kind: 'PAUSE'; reason: string }
  | { kind: 'ALERT_ONLY'; reason: string };

export interface BotConfig {
  enabled: boolean;
  poolAddress: string;
  bertMint: string;
  rangeWidthPct: number;
  sustainedMinutes: number;
  minRebalanceIntervalMin: number;
  maxRebalancesPerDay: number;
  maxSlippageBps: number;
  maxDrawdownPct: number;
  drawdownWindowMin: number;
  maxPositionUsd: number;
  oracleDivergenceBps: number;
  oracleStaleMinutes: number;
  rpcOutageMinutes: number;
  minSolBalance: number;
  hardPauseSolBalance: number;
  pollIntervalSec: number;
  feeCollectionMode: 'on_rebalance' | 'scheduled';
  feeHandling: 'compound' | 'sweep';
  rpcPrimary: string;
  rpcFallback: string;
  keyfilePath: string;
  statePath: string;
  killSwitchFilePath: string;
  heartbeatPath: string;
  notifier: {
    telegram?: { botToken: string; chatIdInfo: string; chatIdCritical: string };
    discord?: { webhookInfo: string; webhookCritical: string };
  };
  dryRun: boolean;
}
```

- [ ] **Step 2.2: Verify compile**

```bash
pnpm lint
```

- [ ] **Step 2.3: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): shared domain types"
```

---

## Task 3: Config loader with zod schema

**Files:**
- Create: `/opt/bert-mm-bot/src/config.ts`
- Create: `/opt/bert-mm-bot/tests/config.test.ts`
- Create: `/opt/bert-mm-bot/tests/fixtures/valid-config.yaml`

- [ ] **Step 3.1: Create `tests/fixtures/valid-config.yaml`**

```yaml
enabled: true
poolAddress: "9LkdXDXQkWC8RgqMTn2eAnzgFTNjKjJiSq4smpdKLuaH"
bertMint: "HgBRWfYxEfvPhtqkaeymCQtHCrKE46qQ43pKe8HCpump"
rangeWidthPct: 20
sustainedMinutes: 10
minRebalanceIntervalMin: 60
maxRebalancesPerDay: 6
maxSlippageBps: 100
maxDrawdownPct: 15
drawdownWindowMin: 30
maxPositionUsd: 2200
oracleDivergenceBps: 150
oracleStaleMinutes: 15
rpcOutageMinutes: 5
minSolBalance: 0.1
hardPauseSolBalance: 0.03
pollIntervalSec: 30
feeCollectionMode: "on_rebalance"
feeHandling: "compound"
rpcPrimary: "https://rpc.example.com/primary"
rpcFallback: "https://rpc.example.com/fallback"
keyfilePath: "/etc/bert-mm-bot/hot-wallet.json"
statePath: "/var/lib/bert-mm-bot/state.db"
killSwitchFilePath: "/var/lib/bert-mm-bot/KILLSWITCH"
heartbeatPath: "/var/lib/bert-mm-bot/heartbeat.txt"
notifier:
  discord:
    webhookInfo: "https://discord.com/api/webhooks/info"
    webhookCritical: "https://discord.com/api/webhooks/critical"
dryRun: false
```

- [ ] **Step 3.2: Write failing test `tests/config.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError } from '../src/config.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const VALID_PATH = join(__dirname, 'fixtures', 'valid-config.yaml');
const validYaml = readFileSync(VALID_PATH, 'utf8');

describe('config loader', () => {
  it('parses a valid config', () => {
    const cfg = loadConfig(validYaml);
    expect(cfg.rangeWidthPct).toBe(20);
    expect(cfg.enabled).toBe(true);
    expect(cfg.feeHandling).toBe('compound');
  });

  it('rejects rangeWidthPct out of bounds (too small)', () => {
    const bad = validYaml.replace('rangeWidthPct: 20', 'rangeWidthPct: 0.2');
    expect(() => loadConfig(bad)).toThrow(ConfigError);
  });

  it('rejects rangeWidthPct above 100', () => {
    const bad = validYaml.replace('rangeWidthPct: 20', 'rangeWidthPct: 150');
    expect(() => loadConfig(bad)).toThrow(ConfigError);
  });

  it('rejects maxSlippageBps above 500', () => {
    const bad = validYaml.replace('maxSlippageBps: 100', 'maxSlippageBps: 1000');
    expect(() => loadConfig(bad)).toThrow(ConfigError);
  });

  it('rejects unknown feeHandling', () => {
    const bad = validYaml.replace('feeHandling: "compound"', 'feeHandling: "burn"');
    expect(() => loadConfig(bad)).toThrow(ConfigError);
  });

  it('requires at least one notifier channel', () => {
    const bad = validYaml.replace(/notifier:[\s\S]*?dryRun/, 'notifier: {}\ndryRun');
    expect(() => loadConfig(bad)).toThrow(ConfigError);
  });

  it('requires hardPauseSolBalance < minSolBalance', () => {
    const bad = validYaml.replace('hardPauseSolBalance: 0.03', 'hardPauseSolBalance: 0.5');
    expect(() => loadConfig(bad)).toThrow(ConfigError);
  });
});
```

- [ ] **Step 3.3: Run test, verify it fails**

```bash
pnpm test config.test
```

Expected: FAIL — symbols not defined.

- [ ] **Step 3.4: Implement `src/config.ts`**

```ts
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { readFileSync } from 'node:fs';
import type { BotConfig } from './types.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(`ConfigError: ${message}`);
    this.name = 'ConfigError';
  }
}

const NotifierSchema = z
  .object({
    telegram: z
      .object({
        botToken: z.string().min(1),
        chatIdInfo: z.string().min(1),
        chatIdCritical: z.string().min(1),
      })
      .optional(),
    discord: z
      .object({
        webhookInfo: z.string().url(),
        webhookCritical: z.string().url(),
      })
      .optional(),
  })
  .refine((n) => n.telegram || n.discord, {
    message: 'at least one of telegram/discord must be configured',
  });

const BotConfigSchema = z
  .object({
    enabled: z.boolean(),
    poolAddress: z.string().min(32),
    bertMint: z.string().min(32),
    rangeWidthPct: z.number().min(1).max(100),
    sustainedMinutes: z.number().int().min(1).max(120),
    minRebalanceIntervalMin: z.number().int().min(5).max(1440),
    maxRebalancesPerDay: z.number().int().min(1).max(48),
    maxSlippageBps: z.number().int().min(1).max(500),
    maxDrawdownPct: z.number().min(1).max(50),
    drawdownWindowMin: z.number().int().min(5).max(240),
    maxPositionUsd: z.number().positive(),
    oracleDivergenceBps: z.number().int().min(1).max(500),
    oracleStaleMinutes: z.number().int().min(1).max(60),
    rpcOutageMinutes: z.number().int().min(1).max(30),
    minSolBalance: z.number().positive(),
    hardPauseSolBalance: z.number().positive(),
    pollIntervalSec: z.number().int().min(10).max(300),
    feeCollectionMode: z.enum(['on_rebalance', 'scheduled']),
    feeHandling: z.enum(['compound', 'sweep']),
    rpcPrimary: z.string().url(),
    rpcFallback: z.string().url(),
    keyfilePath: z.string().min(1),
    statePath: z.string().min(1),
    killSwitchFilePath: z.string().min(1),
    heartbeatPath: z.string().min(1),
    notifier: NotifierSchema,
    dryRun: z.boolean(),
  })
  .refine((c) => c.hardPauseSolBalance < c.minSolBalance, {
    message: 'hardPauseSolBalance must be < minSolBalance',
  });

export function loadConfig(yamlText: string): BotConfig {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (e) {
    throw new ConfigError(`YAML parse failed: ${(e as Error).message}`);
  }
  const parsed = BotConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }
  return parsed.data as BotConfig;
}

export function loadConfigFromFile(path: string): BotConfig {
  return loadConfig(readFileSync(path, 'utf8'));
}
```

- [ ] **Step 3.5: Run tests, verify pass**

```bash
pnpm test config.test
```

Expected: all 7 tests pass.

- [ ] **Step 3.6: Create `config.example.yaml`**

```bash
cp tests/fixtures/valid-config.yaml config.example.yaml
```

Edit to replace RPC and webhook URLs with `REPLACE_WITH_YOUR_...` placeholders.

- [ ] **Step 3.7: Commit**

```bash
git add src/config.ts tests/config.test.ts tests/fixtures/valid-config.yaml config.example.yaml
git commit -m "feat(config): zod-validated yaml loader"
```

---

## Task 4: Logger

**Files:**
- Create: `/opt/bert-mm-bot/src/logger.ts`

- [ ] **Step 4.1: Create `src/logger.ts`**

```ts
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'bert-mm-bot' },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof logger;
```

- [ ] **Step 4.2: Commit**

```bash
pnpm lint
git add src/logger.ts
git commit -m "feat(logger): pino JSON logger"
```

---

## Task 5: State store (SQLite)

**Files:**
- Create: `/opt/bert-mm-bot/src/stateStore.ts`
- Create: `/opt/bert-mm-bot/tests/stateStore.test.ts`

- [ ] **Step 5.1: Write failing test `tests/stateStore.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateStore } from '../src/stateStore.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let store: StateStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bertmm-'));
  store = new StateStore(join(dir, 'state.db'));
  store.init();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('StateStore', () => {
  it('initializes empty', () => {
    expect(store.getCurrentPosition()).toBeNull();
    expect(store.getRebalancesToday(Date.UTC(2026, 3, 9))).toBe(0);
    expect(store.isDegraded()).toBe(false);
  });

  it('persists current position', () => {
    store.setCurrentPosition({
      nftMint: 'ABC123',
      lowerUsd: 0.008,
      upperUsd: 0.012,
      centerUsd: 0.01,
      openedAt: 1_700_000_000_000,
    });
    const pos = store.getCurrentPosition();
    expect(pos?.nftMint).toBe('ABC123');
    expect(pos?.centerUsd).toBe(0.01);
  });

  it('counts rebalances per UTC day', () => {
    const day = Date.UTC(2026, 3, 9);
    const nextDay = Date.UTC(2026, 3, 10);
    store.recordRebalance({ ts: day + 1000, oldCenterUsd: 0.01, newCenterUsd: 0.011, feesCollectedUsd: 1.2 });
    store.recordRebalance({ ts: day + 2000, oldCenterUsd: 0.011, newCenterUsd: 0.012, feesCollectedUsd: 0.8 });
    store.recordRebalance({ ts: nextDay + 1000, oldCenterUsd: 0.012, newCenterUsd: 0.013, feesCollectedUsd: 0.5 });
    expect(store.getRebalancesToday(day)).toBe(2);
    expect(store.getRebalancesToday(nextDay)).toBe(1);
  });

  it('tracks degraded flag', () => {
    expect(store.isDegraded()).toBe(false);
    store.setDegraded(true, 'drawdown breaker');
    expect(store.isDegraded()).toBe(true);
    store.setDegraded(false, 'operator cleared');
    expect(store.isDegraded()).toBe(false);
  });

  it('records operator actions with user', () => {
    store.recordOperatorAction({ ts: 1_700_000_000_000, command: 'emergency-exit', osUser: 'alice' });
    const actions = store.listOperatorActions(10);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.osUser).toBe('alice');
  });

  it('survives reopen', () => {
    store.setCurrentPosition({
      nftMint: 'XYZ789',
      lowerUsd: 0.007,
      upperUsd: 0.013,
      centerUsd: 0.01,
      openedAt: 1_700_000_000_000,
    });
    const path = store.path;
    store.close();
    const reopened = new StateStore(path);
    reopened.init();
    expect(reopened.getCurrentPosition()?.nftMint).toBe('XYZ789');
    reopened.close();
  });
});
```

- [ ] **Step 5.2: Run test, verify failure**

```bash
pnpm test stateStore.test
```

- [ ] **Step 5.3: Implement `src/stateStore.ts`**

```ts
import Database from 'better-sqlite3';

export interface StoredPosition {
  nftMint: string;
  lowerUsd: number;
  upperUsd: number;
  centerUsd: number;
  openedAt: number;
}

export interface RebalanceRecord {
  ts: number;
  oldCenterUsd: number;
  newCenterUsd: number;
  feesCollectedUsd: number;
}

export interface OperatorAction {
  ts: number;
  command: string;
  osUser: string;
}

const SCHEMA_SQL = [
  "CREATE TABLE IF NOT EXISTS position_state (id INTEGER PRIMARY KEY CHECK (id = 1), nft_mint TEXT NOT NULL, lower_usd REAL NOT NULL, upper_usd REAL NOT NULL, center_usd REAL NOT NULL, opened_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS rebalance_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, old_center_usd REAL NOT NULL, new_center_usd REAL NOT NULL, fees_collected_usd REAL NOT NULL)",
  "CREATE TABLE IF NOT EXISTS flags (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL, reason TEXT)",
  "CREATE TABLE IF NOT EXISTS operator_actions (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, command TEXT NOT NULL, os_user TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_rebalance_ts ON rebalance_log(ts)",
];

export class StateStore {
  public readonly path: string;
  private db: Database.Database;

  constructor(path: string) {
    this.path = path;
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
  }

  init(): void {
    for (const stmt of SCHEMA_SQL) this.db.prepare(stmt).run();
  }

  getCurrentPosition(): StoredPosition | null {
    const row = this.db
      .prepare('SELECT nft_mint, lower_usd, upper_usd, center_usd, opened_at FROM position_state WHERE id = 1')
      .get() as
      | { nft_mint: string; lower_usd: number; upper_usd: number; center_usd: number; opened_at: number }
      | undefined;
    if (!row) return null;
    return {
      nftMint: row.nft_mint,
      lowerUsd: row.lower_usd,
      upperUsd: row.upper_usd,
      centerUsd: row.center_usd,
      openedAt: row.opened_at,
    };
  }

  setCurrentPosition(p: StoredPosition): void {
    this.db
      .prepare(
        'INSERT INTO position_state (id, nft_mint, lower_usd, upper_usd, center_usd, opened_at) VALUES (1, @nftMint, @lowerUsd, @upperUsd, @centerUsd, @openedAt) ON CONFLICT(id) DO UPDATE SET nft_mint=excluded.nft_mint, lower_usd=excluded.lower_usd, upper_usd=excluded.upper_usd, center_usd=excluded.center_usd, opened_at=excluded.opened_at',
      )
      .run(p);
  }

  clearCurrentPosition(): void {
    this.db.prepare('DELETE FROM position_state WHERE id = 1').run();
  }

  recordRebalance(r: RebalanceRecord): void {
    this.db
      .prepare(
        'INSERT INTO rebalance_log (ts, old_center_usd, new_center_usd, fees_collected_usd) VALUES (@ts, @oldCenterUsd, @newCenterUsd, @feesCollectedUsd)',
      )
      .run(r);
  }

  getRebalancesToday(nowMs: number): number {
    const startOfDay = Math.floor(nowMs / 86_400_000) * 86_400_000;
    const endOfDay = startOfDay + 86_400_000;
    const row = this.db
      .prepare('SELECT COUNT(*) as n FROM rebalance_log WHERE ts >= ? AND ts < ?')
      .get(startOfDay, endOfDay) as { n: number };
    return row.n;
  }

  lastRebalanceAt(): number | null {
    const row = this.db.prepare('SELECT MAX(ts) as ts FROM rebalance_log').get() as { ts: number | null };
    return row.ts ?? null;
  }

  setDegraded(value: boolean, reason: string): void {
    this.db
      .prepare(
        "INSERT INTO flags (key, value, updated_at, reason) VALUES ('degraded', @v, @t, @r) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, reason=excluded.reason",
      )
      .run({ v: value ? '1' : '0', t: Date.now(), r: reason });
  }

  isDegraded(): boolean {
    const row = this.db.prepare("SELECT value FROM flags WHERE key = 'degraded'").get() as
      | { value: string }
      | undefined;
    return row?.value === '1';
  }

  recordOperatorAction(a: OperatorAction): void {
    this.db
      .prepare('INSERT INTO operator_actions (ts, command, os_user) VALUES (@ts, @command, @osUser)')
      .run(a);
  }

  listOperatorActions(limit: number): OperatorAction[] {
    const rows = this.db
      .prepare('SELECT ts, command, os_user FROM operator_actions ORDER BY ts DESC LIMIT ?')
      .all(limit) as Array<{ ts: number; command: string; os_user: string }>;
    return rows.map((r) => ({ ts: r.ts, command: r.command, osUser: r.os_user }));
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 5.4: Run tests, verify pass**

```bash
pnpm test stateStore.test
```

- [ ] **Step 5.5: Commit**

```bash
git add src/stateStore.ts tests/stateStore.test.ts
git commit -m "feat(state): sqlite state store with reopen-safety"
```

---

## Task 6: Price oracle (3-source divergence)

**Files:**
- Create: `/opt/bert-mm-bot/src/priceOracle.ts`
- Create: `/opt/bert-mm-bot/tests/priceOracle.test.ts`

- [ ] **Step 6.1: Write failing test `tests/priceOracle.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { computeTrustedMid, PriceSample } from '../src/priceOracle.js';

const now = 1_700_000_000_000;

function sample(source: string, bertUsd: number): PriceSample {
  return { source, bertUsd, solUsd: 150, bertPerSol: 150 / bertUsd, ts: now };
}

describe('priceOracle divergence logic', () => {
  it('returns trusted mid when all 3 sources agree', () => {
    const mid = computeTrustedMid(
      [sample('raydium', 0.0082), sample('jupiter', 0.00821), sample('dexscreener', 0.00819)],
      150,
      now,
    );
    expect(mid).not.toBeNull();
    expect(mid!.sources).toEqual(['raydium', 'jupiter', 'dexscreener']);
  });

  it('returns null when sources diverge beyond threshold', () => {
    const mid = computeTrustedMid(
      [sample('raydium', 0.0082), sample('jupiter', 0.0095), sample('dexscreener', 0.0081)],
      150,
      now,
    );
    expect(mid).toBeNull();
  });

  it('returns mid with 2 agreeing sources if 3rd is missing', () => {
    const mid = computeTrustedMid([sample('raydium', 0.0082), sample('jupiter', 0.00821)], 150, now);
    expect(mid).not.toBeNull();
    expect(mid!.sources).toHaveLength(2);
  });

  it('returns null with only 1 source', () => {
    const mid = computeTrustedMid([sample('raydium', 0.0082)], 150, now);
    expect(mid).toBeNull();
  });

  it('returns null with empty input', () => {
    const mid = computeTrustedMid([], 150, now);
    expect(mid).toBeNull();
  });

  it('rejects 2% spread when threshold is 150 bps', () => {
    const mid = computeTrustedMid(
      [sample('raydium', 0.0080), sample('jupiter', 0.00816), sample('dexscreener', 0.0081)],
      150,
      now,
      150,
    );
    expect(mid).toBeNull();
  });

  it('tolerates small within-threshold divergence', () => {
    const mid = computeTrustedMid(
      [sample('raydium', 0.0080), sample('jupiter', 0.00808), sample('dexscreener', 0.0081)],
      150,
      now,
      150,
    );
    expect(mid).not.toBeNull();
  });
});
```

- [ ] **Step 6.2: Run test, verify failure**

```bash
pnpm test priceOracle.test
```

- [ ] **Step 6.3: Implement `src/priceOracle.ts`**

```ts
import type { MidPrice } from './types.js';

export interface PriceSample {
  source: string;
  bertUsd: number;
  solUsd: number;
  bertPerSol: number;
  ts: number;
}

export function computeTrustedMid(
  samples: PriceSample[],
  _solUsd: number,
  now: number,
  divergenceBps = 150,
): MidPrice | null {
  if (samples.length < 2) return null;
  const prices = samples.map((s) => s.bertUsd).sort((a, b) => a - b);
  const min = prices[0]!;
  const max = prices[prices.length - 1]!;
  const median = prices[Math.floor(prices.length / 2)]!;
  const divergence = ((max - min) / median) * 10_000;
  if (divergence > divergenceBps) return null;
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  const solUsdMean = samples.reduce((a, s) => a + s.solUsd, 0) / samples.length;
  return {
    bertUsd: mean,
    solUsd: solUsdMean,
    bertPerSol: solUsdMean / mean,
    ts: now,
    sources: samples.map((s) => s.source),
  };
}

export interface PriceFetchers {
  fetchRaydium: () => Promise<PriceSample | null>;
  fetchJupiter: () => Promise<PriceSample | null>;
  fetchDexScreener: () => Promise<PriceSample | null>;
}

export async function fetchAllSources(fetchers: PriceFetchers): Promise<PriceSample[]> {
  const results = await Promise.allSettled([
    fetchers.fetchRaydium(),
    fetchers.fetchJupiter(),
    fetchers.fetchDexScreener(),
  ]);
  return results
    .filter((r): r is PromiseFulfilledResult<PriceSample | null> => r.status === 'fulfilled')
    .map((r) => r.value)
    .filter((s): s is PriceSample => s !== null);
}
```

- [ ] **Step 6.4: Run tests, verify pass**

```bash
pnpm test priceOracle.test
```

- [ ] **Step 6.5: Commit**

```bash
git add src/priceOracle.ts tests/priceOracle.test.ts
git commit -m "feat(oracle): 3-source divergence-aware mid price"
```

---

## Task 7: Strategy decision function (pure, exhaustively tested)

This is the single most critical module — every spec §6 guardrail lives here.

**Files:**
- Create: `/opt/bert-mm-bot/src/strategy.ts`
- Create: `/opt/bert-mm-bot/tests/strategy.test.ts`

- [ ] **Step 7.1: Write failing test `tests/strategy.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { decide, StrategyParams } from '../src/strategy.js';
import type { BotState, MidPrice, PositionSnapshot } from '../src/types.js';

const PARAMS: StrategyParams = {
  rangeWidthPct: 20,
  sustainedMinutes: 10,
  minRebalanceIntervalMin: 60,
  maxRebalancesPerDay: 6,
  oracleStaleMinutes: 15,
  pollIntervalSec: 30,
};

const MIN = 60_000;
const NOW = 1_700_000_000_000;

function mkPrice(bertUsd: number, ts: number): MidPrice {
  return { bertUsd, solUsd: 150, bertPerSol: 150 / bertUsd, ts, sources: ['a', 'b', 'c'] };
}

function mkPosition(centerUsd: number): PositionSnapshot {
  return {
    nftMint: 'NFT',
    range: {
      centerBertUsd: centerUsd,
      lowerBertUsd: centerUsd * 0.8,
      upperBertUsd: centerUsd * 1.2,
      widthPct: 20,
    },
    bertAmount: 0n,
    solAmount: 0n,
    uncollectedFeesBert: 0n,
    uncollectedFeesSol: 0n,
    totalValueUsd: 2000,
    openedAt: NOW - 3 * 3600 * 1000,
  };
}

function mkState(overrides: Partial<BotState> = {}): BotState {
  return {
    price: mkPrice(0.01, NOW),
    priceHistory: [],
    position: mkPosition(0.01),
    lastRebalanceAt: NOW - 3 * 3600 * 1000,
    rebalancesToday: 0,
    killSwitchTripped: false,
    degraded: false,
    now: NOW,
    ...overrides,
  };
}

describe('strategy.decide', () => {
  it('HOLD when price is inside range', () => {
    expect(decide(mkState(), PARAMS).kind).toBe('HOLD');
  });

  it('HOLD when no position yet', () => {
    expect(decide(mkState({ position: null }), PARAMS).kind).toBe('HOLD');
  });

  it('PAUSE when killSwitchTripped', () => {
    expect(decide(mkState({ killSwitchTripped: true }), PARAMS).kind).toBe('PAUSE');
  });

  it('PAUSE when degraded', () => {
    expect(decide(mkState({ degraded: true }), PARAMS).kind).toBe('PAUSE');
  });

  it('PAUSE when oracle stale', () => {
    const stale = mkPrice(0.01, NOW - 20 * MIN);
    expect(decide(mkState({ price: stale }), PARAMS).kind).toBe('PAUSE');
  });

  it('HOLD when price is null (divergent oracle)', () => {
    expect(decide(mkState({ price: null }), PARAMS).kind).toBe('HOLD');
  });

  it('HOLD when price briefly out of range', () => {
    const history: MidPrice[] = [];
    for (let i = 5; i >= 0; i--) history.push(mkPrice(0.013, NOW - i * MIN));
    expect(
      decide(mkState({ price: mkPrice(0.013, NOW), priceHistory: history }), PARAMS).kind,
    ).toBe('HOLD');
  });

  it('REBALANCE when sustained out-of-range and cooldowns clear', () => {
    const history: MidPrice[] = [];
    for (let i = 11; i >= 0; i--) history.push(mkPrice(0.013, NOW - i * MIN));
    const d = decide(
      mkState({
        price: mkPrice(0.013, NOW),
        priceHistory: history,
        lastRebalanceAt: NOW - 2 * 3600 * 1000,
      }),
      PARAMS,
    );
    expect(d.kind).toBe('REBALANCE');
    if (d.kind === 'REBALANCE') expect(d.newCenterUsd).toBeCloseTo(0.013);
  });

  it('ALERT_ONLY when trigger fires within min interval', () => {
    const history: MidPrice[] = [];
    for (let i = 11; i >= 0; i--) history.push(mkPrice(0.013, NOW - i * MIN));
    expect(
      decide(
        mkState({
          price: mkPrice(0.013, NOW),
          priceHistory: history,
          lastRebalanceAt: NOW - 10 * MIN,
        }),
        PARAMS,
      ).kind,
    ).toBe('ALERT_ONLY');
  });

  it('ALERT_ONLY when daily cap reached', () => {
    const history: MidPrice[] = [];
    for (let i = 11; i >= 0; i--) history.push(mkPrice(0.013, NOW - i * MIN));
    expect(
      decide(
        mkState({
          price: mkPrice(0.013, NOW),
          priceHistory: history,
          lastRebalanceAt: NOW - 2 * 3600 * 1000,
          rebalancesToday: 6,
        }),
        PARAMS,
      ).kind,
    ).toBe('ALERT_ONLY');
  });

  it('REBALANCE on low-side sustained out-of-range', () => {
    const history: MidPrice[] = [];
    for (let i = 11; i >= 0; i--) history.push(mkPrice(0.007, NOW - i * MIN));
    const d = decide(
      mkState({
        price: mkPrice(0.007, NOW),
        priceHistory: history,
        lastRebalanceAt: NOW - 2 * 3600 * 1000,
      }),
      PARAMS,
    );
    expect(d.kind).toBe('REBALANCE');
  });

  it('does not trigger on mixed in/out history (needs continuous out)', () => {
    const history: MidPrice[] = [];
    for (let i = 11; i >= 0; i--) {
      history.push(mkPrice(i === 5 ? 0.010 : 0.013, NOW - i * MIN));
    }
    expect(
      decide(
        mkState({
          price: mkPrice(0.013, NOW),
          priceHistory: history,
          lastRebalanceAt: NOW - 2 * 3600 * 1000,
        }),
        PARAMS,
      ).kind,
    ).toBe('HOLD');
  });
});
```

- [ ] **Step 7.2: Run test, verify failure**

```bash
pnpm test strategy.test
```

- [ ] **Step 7.3: Implement `src/strategy.ts`**

```ts
import type { BotState, Decision } from './types.js';

export interface StrategyParams {
  rangeWidthPct: number;
  sustainedMinutes: number;
  minRebalanceIntervalMin: number;
  maxRebalancesPerDay: number;
  oracleStaleMinutes: number;
  pollIntervalSec: number;
}

export function decide(state: BotState, params: StrategyParams): Decision {
  if (state.killSwitchTripped) return { kind: 'PAUSE', reason: 'kill switch tripped' };
  if (state.degraded) return { kind: 'PAUSE', reason: 'degraded flag set' };

  if (state.price && state.now - state.price.ts > params.oracleStaleMinutes * 60_000) {
    return {
      kind: 'PAUSE',
      reason: `oracle stale by ${Math.round((state.now - state.price.ts) / 60_000)} min`,
    };
  }

  if (!state.price) return { kind: 'HOLD', reason: 'oracle returned null (divergent sources)' };
  if (!state.position) return { kind: 'HOLD', reason: 'no position yet (initial state)' };

  const { lowerBertUsd, upperBertUsd } = state.position.range;
  const currentPrice = state.price.bertUsd;
  const inRange = currentPrice >= lowerBertUsd && currentPrice <= upperBertUsd;
  if (inRange) return { kind: 'HOLD', reason: 'price in range' };

  const requiredMinutes = params.sustainedMinutes;
  const cutoff = state.now - requiredMinutes * 60_000;
  const recent = state.priceHistory.filter((s) => s.ts >= cutoff);
  if (recent.length < requiredMinutes) {
    return { kind: 'HOLD', reason: 'not enough history yet' };
  }
  const allOutOfRange = recent.every((s) => s.bertUsd < lowerBertUsd || s.bertUsd > upperBertUsd);
  if (!allOutOfRange) return { kind: 'HOLD', reason: 'not sustained out-of-range' };

  if (state.lastRebalanceAt !== null) {
    const sinceMin = (state.now - state.lastRebalanceAt) / 60_000;
    if (sinceMin < params.minRebalanceIntervalMin) {
      return {
        kind: 'ALERT_ONLY',
        reason: `out-of-range but cooldown active (${sinceMin.toFixed(1)}/${params.minRebalanceIntervalMin} min)`,
      };
    }
  }

  if (state.rebalancesToday >= params.maxRebalancesPerDay) {
    return {
      kind: 'ALERT_ONLY',
      reason: `out-of-range but daily cap reached (${state.rebalancesToday}/${params.maxRebalancesPerDay})`,
    };
  }

  return {
    kind: 'REBALANCE',
    reason: 'sustained out-of-range; triggers cleared',
    newCenterUsd: currentPrice,
  };
}
```

- [ ] **Step 7.4: Run tests, verify pass**

```bash
pnpm test strategy.test
```

- [ ] **Step 7.5: Commit**

```bash
git add src/strategy.ts tests/strategy.test.ts
git commit -m "feat(strategy): pure decision function with full guardrail coverage"
```

---

## Task 8: Notifier (webhooks)

**Files:**
- Create: `/opt/bert-mm-bot/src/notifier.ts`
- Create: `/opt/bert-mm-bot/tests/notifier.test.ts`

- [ ] **Step 8.1: Write failing test `tests/notifier.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Notifier } from '../src/notifier.js';

const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ ok: true, status: 200 } as Response);
});

describe('Notifier', () => {
  const channels = {
    discord: {
      webhookInfo: 'https://d.invalid/info',
      webhookCritical: 'https://d.invalid/critical',
    },
  };

  it('routes INFO to info webhook', async () => {
    const n = new Notifier(channels);
    await n.send('INFO', 'hello');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe('https://d.invalid/info');
  });

  it('routes CRITICAL to critical webhook', async () => {
    const n = new Notifier(channels);
    await n.send('CRITICAL', 'fire');
    expect(mockFetch.mock.calls[0][0]).toBe('https://d.invalid/critical');
  });

  it('prefixes message with severity', async () => {
    const n = new Notifier(channels);
    await n.send('WARN', 'minor issue');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.content).toMatch(/\[WARN\]/);
    expect(body.content).toMatch(/minor issue/);
  });

  it('does not throw on webhook failure', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 } as Response);
    const n = new Notifier(channels);
    await expect(n.send('INFO', 'test')).resolves.not.toThrow();
  });
});
```

- [ ] **Step 8.2: Run test, verify failure**

```bash
pnpm test notifier.test
```

- [ ] **Step 8.3: Implement `src/notifier.ts`**

```ts
import { logger } from './logger.js';

export type Severity = 'INFO' | 'WARN' | 'CRITICAL';

export interface NotifierChannels {
  telegram?: { botToken: string; chatIdInfo: string; chatIdCritical: string };
  discord?: { webhookInfo: string; webhookCritical: string };
}

export class Notifier {
  constructor(private readonly channels: NotifierChannels) {}

  async send(sev: Severity, message: string): Promise<void> {
    const text = `[${sev}] ${new Date().toISOString()}\n${message}`;
    const critical = sev === 'CRITICAL';
    const tasks: Promise<unknown>[] = [];

    if (this.channels.discord) {
      const url = critical
        ? this.channels.discord.webhookCritical
        : this.channels.discord.webhookInfo;
      tasks.push(this.postDiscord(url, text));
    }
    if (this.channels.telegram) {
      const chatId = critical
        ? this.channels.telegram.chatIdCritical
        : this.channels.telegram.chatIdInfo;
      tasks.push(this.postTelegram(this.channels.telegram.botToken, chatId, text));
    }

    await Promise.allSettled(tasks);
  }

  private async postDiscord(url: string, content: string): Promise<void> {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) logger.warn({ status: res.status }, 'discord webhook non-2xx');
    } catch (e) {
      logger.warn({ err: e }, 'discord webhook post failed');
    }
  }

  private async postTelegram(token: string, chatId: string, text: string): Promise<void> {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
      if (!res.ok) logger.warn({ status: res.status }, 'telegram send failed');
    } catch (e) {
      logger.warn({ err: e }, 'telegram send threw');
    }
  }
}
```

- [ ] **Step 8.4: Run tests, verify pass**

```bash
pnpm test notifier.test
```

- [ ] **Step 8.5: Commit**

```bash
git add src/notifier.ts tests/notifier.test.ts
git commit -m "feat(notifier): webhook sender with severity routing"
```

---

## Task 9: Raydium client skeleton (interface + stubs)

This task lays down the interface only. Real SDK wiring happens in Task 13 after the pure/testable modules are done.

**Files:**
- Create: `/opt/bert-mm-bot/src/raydiumClient.ts`

- [ ] **Step 9.1: Create `src/raydiumClient.ts` skeleton**

```ts
import { Connection, Keypair, Transaction } from '@solana/web3.js';
import { logger } from './logger.js';
import type { PositionSnapshot } from './types.js';

export interface OpenPositionParams {
  lowerUsd: number;
  upperUsd: number;
  bertAmountRaw: bigint;
  solAmountLamports: bigint;
}

export interface PoolState {
  address: string;
  feeTier: number;
  currentTickIndex: number;
  sqrtPriceX64: bigint;
  bertUsd: number;
  solUsd: number;
  tvlUsd: number;
}

export interface RaydiumClient {
  init(): Promise<void>;
  getPoolState(): Promise<PoolState>;
  getPosition(nftMint: string): Promise<PositionSnapshot | null>;
  buildOpenPositionTx(params: OpenPositionParams): Promise<{ tx: Transaction; nftMint: string }>;
  buildClosePositionTx(
    nftMint: string,
  ): Promise<{ tx: Transaction; expectedBertOut: bigint; expectedSolOut: bigint }>;
  buildSwapToRatioTx(params: {
    haveBertRaw: bigint;
    haveSolLamports: bigint;
    targetBertRatio: number;
  }): Promise<Transaction>;
  simulateClose(
    nftMint: string,
  ): Promise<{ effectivePriceUsd: number; bertOut: bigint; solOut: bigint }>;
}

export class RaydiumClientImpl implements RaydiumClient {
  private connection!: Connection;

  constructor(
    private readonly rpcPrimary: string,
    private readonly rpcFallback: string,
    private readonly poolAddress: string,
    private readonly payer: Keypair,
  ) {}

  async init(): Promise<void> {
    this.connection = new Connection(this.rpcPrimary, 'confirmed');
    const slot = await this.connection.getSlot();
    logger.info({ slot, rpc: this.rpcPrimary }, 'raydium client initialized');
  }

  async getPoolState(): Promise<PoolState> {
    throw new Error('getPoolState: wire to Raydium SDK in Task 13');
  }
  async getPosition(_nftMint: string): Promise<PositionSnapshot | null> {
    throw new Error('getPosition: wire to Raydium SDK in Task 13');
  }
  async buildOpenPositionTx(
    _params: OpenPositionParams,
  ): Promise<{ tx: Transaction; nftMint: string }> {
    throw new Error('buildOpenPositionTx: wire to Raydium SDK in Task 13');
  }
  async buildClosePositionTx(
    _nftMint: string,
  ): Promise<{ tx: Transaction; expectedBertOut: bigint; expectedSolOut: bigint }> {
    throw new Error('buildClosePositionTx: wire to Raydium SDK in Task 13');
  }
  async buildSwapToRatioTx(_params: {
    haveBertRaw: bigint;
    haveSolLamports: bigint;
    targetBertRatio: number;
  }): Promise<Transaction> {
    throw new Error('buildSwapToRatioTx: wire to Raydium SDK in Task 13');
  }
  async simulateClose(
    _nftMint: string,
  ): Promise<{ effectivePriceUsd: number; bertOut: bigint; solOut: bigint }> {
    throw new Error('simulateClose: wire to Raydium SDK in Task 13');
  }
}
```

- [ ] **Step 9.2: Verify compile**

```bash
pnpm lint
```

- [ ] **Step 9.3: Commit**

```bash
git add src/raydiumClient.ts
git commit -m "feat(raydium): client interface and skeleton"
```

---

## Task 10: Tx submitter

**Files:**
- Create: `/opt/bert-mm-bot/src/txSubmitter.ts`

- [ ] **Step 10.1: Create `src/txSubmitter.ts`**

```ts
import {
  Connection,
  Keypair,
  Transaction,
  TransactionSignature,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { logger } from './logger.js';

export interface SubmitOptions {
  priorityFeeMicroLamports?: number;
  maxRetries?: number;
  dryRun?: boolean;
}

export class TxSubmitter {
  constructor(
    private readonly connection: Connection,
    private readonly payer: Keypair,
  ) {}

  async submit(tx: Transaction, opts: SubmitOptions = {}): Promise<TransactionSignature> {
    const priority = opts.priorityFeeMicroLamports ?? 10_000;
    tx.instructions.unshift(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priority }),
    );

    if (opts.dryRun) {
      logger.info({ dryRun: true, ixs: tx.instructions.length }, 'DRY RUN: would submit tx');
      return 'DRY_RUN_SIGNATURE';
    }

    const maxRetries = opts.maxRetries ?? 3;
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const sig = await sendAndConfirmTransaction(this.connection, tx, [this.payer], {
          commitment: 'confirmed',
          maxRetries: 1,
        });
        logger.info({ sig, attempt }, 'tx confirmed');
        return sig;
      } catch (e) {
        lastErr = e;
        logger.warn({ attempt, err: e }, 'tx submit failed, will retry');
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    throw new Error(`tx submit failed after ${maxRetries} attempts: ${String(lastErr)}`);
  }
}
```

- [ ] **Step 10.2: Commit**

```bash
pnpm lint
git add src/txSubmitter.ts
git commit -m "feat(tx): signer/sender/confirmer with retries and dry-run"
```

---

## Task 11: Startup reconciler

**Files:**
- Create: `/opt/bert-mm-bot/src/reconciler.ts`
- Create: `/opt/bert-mm-bot/tests/reconciler.test.ts`

- [ ] **Step 11.1: Write failing test `tests/reconciler.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { reconcile } from '../src/reconciler.js';
import type { StoredPosition } from '../src/stateStore.js';
import type { PositionSnapshot } from '../src/types.js';

function mkStored(overrides: Partial<StoredPosition> = {}): StoredPosition {
  return {
    nftMint: 'ABC',
    lowerUsd: 0.008,
    upperUsd: 0.012,
    centerUsd: 0.01,
    openedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function mkOnchain(overrides: Partial<PositionSnapshot> = {}): PositionSnapshot {
  return {
    nftMint: 'ABC',
    range: { lowerBertUsd: 0.008, upperBertUsd: 0.012, centerBertUsd: 0.01, widthPct: 20 },
    bertAmount: 100n,
    solAmount: 100n,
    uncollectedFeesBert: 0n,
    uncollectedFeesSol: 0n,
    totalValueUsd: 2000,
    openedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('reconcile', () => {
  it('OK when both empty', () => {
    expect(reconcile(null, null).kind).toBe('OK_EMPTY');
  });
  it('OK when both match', () => {
    expect(reconcile(mkStored(), mkOnchain()).kind).toBe('OK_MATCH');
  });
  it('MISMATCH when only state has position', () => {
    expect(reconcile(mkStored(), null).kind).toBe('MISMATCH');
  });
  it('MISMATCH when only chain has position', () => {
    expect(reconcile(null, mkOnchain()).kind).toBe('MISMATCH');
  });
  it('MISMATCH when NFT mints differ', () => {
    expect(reconcile(mkStored({ nftMint: 'AAA' }), mkOnchain({ nftMint: 'BBB' })).kind).toBe(
      'MISMATCH',
    );
  });
  it('MISMATCH when ranges differ', () => {
    expect(
      reconcile(
        mkStored({ lowerUsd: 0.008 }),
        mkOnchain({
          range: { lowerBertUsd: 0.009, upperBertUsd: 0.012, centerBertUsd: 0.01, widthPct: 20 },
        }),
      ).kind,
    ).toBe('MISMATCH');
  });
  it('OK within floating-point tolerance', () => {
    expect(
      reconcile(
        mkStored({ lowerUsd: 0.008 }),
        mkOnchain({
          range: { lowerBertUsd: 0.00800001, upperBertUsd: 0.012, centerBertUsd: 0.01, widthPct: 20 },
        }),
      ).kind,
    ).toBe('OK_MATCH');
  });
});
```

- [ ] **Step 11.2: Run test, verify failure**

```bash
pnpm test reconciler.test
```

- [ ] **Step 11.3: Implement `src/reconciler.ts`**

```ts
import type { StoredPosition } from './stateStore.js';
import type { PositionSnapshot } from './types.js';

export type ReconcileResult =
  | { kind: 'OK_EMPTY' }
  | { kind: 'OK_MATCH' }
  | { kind: 'MISMATCH'; reason: string };

const TOLERANCE = 1e-6;

function approxEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < TOLERANCE;
}

export function reconcile(
  stored: StoredPosition | null,
  onchain: PositionSnapshot | null,
): ReconcileResult {
  if (stored === null && onchain === null) return { kind: 'OK_EMPTY' };
  if (stored === null) {
    return { kind: 'MISMATCH', reason: 'chain has position but state.db does not' };
  }
  if (onchain === null) {
    return { kind: 'MISMATCH', reason: 'state.db has position but chain does not' };
  }
  if (stored.nftMint !== onchain.nftMint) {
    return {
      kind: 'MISMATCH',
      reason: `nft mint differs: stored=${stored.nftMint} chain=${onchain.nftMint}`,
    };
  }
  if (!approxEqual(stored.lowerUsd, onchain.range.lowerBertUsd)) {
    return {
      kind: 'MISMATCH',
      reason: `lower price differs: stored=${stored.lowerUsd} chain=${onchain.range.lowerBertUsd}`,
    };
  }
  if (!approxEqual(stored.upperUsd, onchain.range.upperBertUsd)) {
    return { kind: 'MISMATCH', reason: 'upper price differs' };
  }
  return { kind: 'OK_MATCH' };
}
```

- [ ] **Step 11.4: Run test, verify pass**

```bash
pnpm test reconciler.test
```

- [ ] **Step 11.5: Commit**

```bash
git add src/reconciler.ts tests/reconciler.test.ts
git commit -m "feat(reconciler): startup consistency check"
```

---

## Task 12: Main orchestrator loop

**Files:**
- Create: `/opt/bert-mm-bot/src/main.ts`

- [ ] **Step 12.1: Create `src/main.ts`**

```ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';
import { loadConfigFromFile } from './config.js';
import { logger } from './logger.js';
import { StateStore } from './stateStore.js';
import { Notifier } from './notifier.js';
import { decide, StrategyParams } from './strategy.js';
import { computeTrustedMid, fetchAllSources, PriceFetchers } from './priceOracle.js';
import { RaydiumClientImpl } from './raydiumClient.js';
import { reconcile } from './reconciler.js';
import type { BotState, MidPrice } from './types.js';

const CONFIG_PATH = process.env.BERT_MM_CONFIG ?? '/etc/bert-mm-bot/config.yaml';
const MAX_HISTORY_SAMPLES = 120;

async function main(): Promise<void> {
  const cfg = loadConfigFromFile(CONFIG_PATH);
  logger.info({ dryRun: cfg.dryRun }, 'bert-mm-bot starting');

  const state = new StateStore(cfg.statePath);
  state.init();

  const notifier = new Notifier(cfg.notifier);

  const keyJson = JSON.parse(readFileSync(cfg.keyfilePath, 'utf8')) as number[];
  const payer = Keypair.fromSecretKey(Uint8Array.from(keyJson));

  const raydium = new RaydiumClientImpl(cfg.rpcPrimary, cfg.rpcFallback, cfg.poolAddress, payer);
  await raydium.init();

  const stored = state.getCurrentPosition();
  const onchain = stored ? await raydium.getPosition(stored.nftMint) : null;
  const rec = reconcile(stored, onchain);
  if (rec.kind === 'MISMATCH') {
    await notifier.send(
      'CRITICAL',
      `Startup reconciliation FAILED: ${rec.reason}. Refusing to start.`,
    );
    logger.fatal({ rec }, 'reconciliation failed');
    process.exit(2);
  }
  logger.info({ rec: rec.kind }, 'reconciliation ok');

  const params: StrategyParams = {
    rangeWidthPct: cfg.rangeWidthPct,
    sustainedMinutes: cfg.sustainedMinutes,
    minRebalanceIntervalMin: cfg.minRebalanceIntervalMin,
    maxRebalancesPerDay: cfg.maxRebalancesPerDay,
    oracleStaleMinutes: cfg.oracleStaleMinutes,
    pollIntervalSec: cfg.pollIntervalSec,
  };

  // Task 13 wires real fetchers.
  const fetchers: PriceFetchers = {
    fetchRaydium: async () => null,
    fetchJupiter: async () => null,
    fetchDexScreener: async () => null,
  };

  const priceHistory: MidPrice[] = [];
  await notifier.send('INFO', `bert-mm-bot started (dryRun=${cfg.dryRun})`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const tickStart = Date.now();
    try {
      const killSwitchTripped = existsSync(cfg.killSwitchFilePath) || !cfg.enabled;

      const samples = await fetchAllSources(fetchers);
      const solUsd = samples[0]?.solUsd ?? 150;
      const mid = computeTrustedMid(samples, solUsd, tickStart, cfg.oracleDivergenceBps);
      if (mid) {
        priceHistory.push(mid);
        if (priceHistory.length > MAX_HISTORY_SAMPLES) priceHistory.shift();
      }

      const storedPos = state.getCurrentPosition();
      const position = storedPos
        ? await raydium.getPosition(storedPos.nftMint).catch(() => null)
        : null;

      const botState: BotState = {
        price: mid,
        priceHistory: [...priceHistory],
        position,
        lastRebalanceAt: state.lastRebalanceAt(),
        rebalancesToday: state.getRebalancesToday(tickStart),
        killSwitchTripped,
        degraded: state.isDegraded(),
        now: tickStart,
      };

      const decision = decide(botState, params);
      logger.info({ decision: decision.kind, reason: decision.reason }, 'tick decision');

      if (decision.kind === 'REBALANCE') {
        // Task 13 wires the full rebalance sequence.
        await notifier.send('INFO', `REBALANCE would fire: ${decision.reason}`);
      } else if (decision.kind === 'PAUSE') {
        await notifier.send('CRITICAL', `PAUSE: ${decision.reason}`);
      } else if (decision.kind === 'ALERT_ONLY') {
        await notifier.send('WARN', `ALERT_ONLY: ${decision.reason}`);
      }

      writeFileSync(cfg.heartbeatPath, String(tickStart));
    } catch (e) {
      logger.error({ err: e }, 'tick failed');
      await notifier.send('WARN', `Tick failed: ${(e as Error).message}`);
    }

    const elapsed = Date.now() - tickStart;
    const sleep = Math.max(0, cfg.pollIntervalSec * 1000 - elapsed);
    await new Promise((r) => setTimeout(r, sleep));
  }
}

main().catch((e) => {
  logger.fatal({ err: e }, 'main crashed');
  process.exit(1);
});
```

- [ ] **Step 12.2: Verify build**

```bash
pnpm lint && pnpm build
```

Expected: no errors; `dist/main.js` exists.

- [ ] **Step 12.3: Commit**

```bash
git add src/main.ts
git commit -m "feat(main): orchestrator loop with decide/notify wiring"
```

---

## Task 13: Raydium SDK integration (real on-chain work)

This task turns Task 9's skeleton into a working client and wires Task 12's stubs to real on-chain operations. The Raydium SDK v2 API surface evolves, so **read current docs first** and keep the wrapper's interface unchanged — only the implementation changes.

**Files:**
- Modify: `/opt/bert-mm-bot/src/raydiumClient.ts`
- Modify: `/opt/bert-mm-bot/src/main.ts`

**Required before starting:**
- Review Raydium SDK v2 CLMM API via `mcp__plugin_context7_context7__query-docs` (prefer over web search per MCP instructions).
- Verify the fee tier of pool `9LkdXDXQkWC8RgqMTn2eAnzgFTNjKjJiSq4smpdKLuaH`. If unsuitable (spec §11 Q1), create a new CLMM pool at 0.25% or 1% and update `config.yaml`.

- [ ] **Step 13.1: Read Raydium SDK v2 docs**

Use context7 query: `raydium sdk v2 clmm position open close fetch fee`. Capture exact class names, method signatures, and tick-math helpers.

- [ ] **Step 13.2: Verify pool fee tier**

Create `scripts/inspect-pool.ts` that connects to mainnet, fetches pool state, and prints fee tier, liquidity, and current tick. Run it and decide: use existing pool or create a new one.

- [ ] **Step 13.3: Implement `usdToTick` / `tickToUsd`**

Replace stubs with real tick math using Raydium SDK helpers (e.g. `TickUtils.getTickWithPriceAndTickspacing`). BERT price path: `priceUsd → priceInSol = priceUsd / solUsd → tick`.

- [ ] **Step 13.4: Implement `getPoolState`**

Replace throw with a real fetch. Record `feeTier`, `sqrtPriceX64`, `currentTickIndex`, compute `bertUsd` from `sqrtPriceX64` and caller-supplied `solUsd`.

- [ ] **Step 13.5: Implement `getPosition(nftMint)`**

Fetch position account, convert tick range to USD bounds, return `PositionSnapshot`.

- [ ] **Step 13.6: Implement `buildOpenPositionTx` and `buildClosePositionTx`**

Use SDK position-manager helpers. Return unsigned `Transaction` plus new NFT mint (for open) or expected out amounts (for close).

- [ ] **Step 13.7: Implement `simulateClose`**

Use SDK simulate helpers or manual math on current tick vs. position ticks. Return expected outs and effective price.

- [ ] **Step 13.8: Implement `buildSwapToRatioTx` via Jupiter**

Call Jupiter quote + swap API to build a tx that brings wallet BERT:SOL ratio to `targetBertRatio`. Use `fetch`, no SDK.

- [ ] **Step 13.9: Real price fetchers in `main.ts`**

Replace `null`-returning fetchers with three real implementations:
- `fetchRaydium`: read pool spot from `raydium.getPoolState()`
- `fetchJupiter`: `GET https://quote-api.jup.ag/v6/quote?inputMint=<BERT>&outputMint=<SOL>&amount=1000000`, compute price
- `fetchDexScreener`: `GET https://api.dexscreener.com/latest/dex/tokens/<BERT_MINT>`, pick the Raydium v4 pool, extract `priceUsd`

Each fetcher must return `null` on error (never throw).

- [ ] **Step 13.10: Wire REBALANCE branch in `main.ts`**

Replace the stub with the full 9-step sequence from spec §5.3:
1. Pre-flight re-check (rerun oracle + decide; abort if condition changed).
2. `raydium.simulateClose(currentPos.nftMint)`. Abort if `|simulated - oracle| * 10000 > cfg.maxSlippageBps`.
3. `buildClosePositionTx` → submit.
4. Compute new `lowerUsd`/`upperUsd` from `newCenterUsd` and `rangeWidthPct`.
5. Read wallet balances, call `buildSwapToRatioTx` → submit (skip if ratio already within 1%).
6. `buildOpenPositionTx` → submit. Capture new NFT mint.
7. `state.setCurrentPosition(...)`, `state.recordRebalance(...)`.
8. `notifier.send('INFO', ...)` with full rebalance summary.
9. On any error: `state.setDegraded(true, reason)`, notifier CRITICAL, break out of rebalance path. Never auto-retry.

Also add: **drawdown breaker check** (spec §6.2 #6). Track an exponentially weighted baseline of position USD value. If value drops `> cfg.maxDrawdownPct` within `cfg.drawdownWindowMin`, set degraded and notify.

Also add: **hot-wallet SOL floor check** (spec §6.2 #11). Read SOL balance every tick. If `< cfg.hardPauseSolBalance`, set degraded. If `< cfg.minSolBalance`, notify CRITICAL but keep running.

Also add: **inventory sanity check** (spec §6.2 #7). Before any `buildOpenPositionTx`, assert `bertValueUsd + solValueUsd ≤ cfg.maxPositionUsd * 1.05`. Abort + CRITICAL if exceeded.

- [ ] **Step 13.11: Initial position opening**

On startup with `reconcile` returning `OK_EMPTY`: wait up to 5 minutes for a trusted mid, then compute range, swap to ratio, open position, persist state, notify INFO.

- [ ] **Step 13.12: Dry-run end-to-end smoke test**

With `dryRun: true` on mainnet RPC, run the bot for 5 minutes:

```bash
BERT_MM_CONFIG=/opt/bert-mm-bot/config.local.yaml pnpm start
```

Expected: oracle fetches succeed, `decide()` returns `HOLD` (no position, or price in range if position opened in dry-run), logs clean, no exceptions.

- [ ] **Step 13.13: Commit in logical chunks**

```bash
git add src/raydiumClient.ts scripts/inspect-pool.ts
git commit -m "feat(raydium): implement SDK-backed pool and position ops"
git add src/main.ts
git commit -m "feat(main): real price fetchers wired to oracle"
git add src/main.ts
git commit -m "feat(main): full rebalance sequence with slippage/drawdown/inventory guards"
git add src/main.ts
git commit -m "feat(main): initial position opening on fresh install"
```

---

## Task 14: CLI operator tool

**Files:**
- Create: `/opt/bert-mm-bot/src/cli/index.ts`
- Create: `/opt/bert-mm-bot/src/cli/status.ts`
- Create: `/opt/bert-mm-bot/src/cli/pause.ts`
- Create: `/opt/bert-mm-bot/src/cli/collect-fees.ts`
- Create: `/opt/bert-mm-bot/src/cli/emergency-exit.ts`
- Create: `/opt/bert-mm-bot/src/cli/force-rebalance.ts`
- Create: `/opt/bert-mm-bot/src/cli/report.ts`
- Create: `/opt/bert-mm-bot/src/cli/clear-degraded.ts`
- Create: `/opt/bert-mm-bot/src/cli/reconcile.ts`

- [ ] **Step 14.1: Create `src/cli/index.ts`**

```ts
import { Command } from 'commander';
import { loadConfigFromFile } from '../config.js';
import { StateStore } from '../stateStore.js';
import { runStatus } from './status.js';
import { runPause } from './pause.js';
import { runCollectFees } from './collect-fees.js';
import { runEmergencyExit } from './emergency-exit.js';
import { runForceRebalance } from './force-rebalance.js';
import { runReport } from './report.js';
import { runClearDegraded } from './clear-degraded.js';
import { runReconcile } from './reconcile.js';
import { userInfo } from 'node:os';

const program = new Command();
program.name('bert-mm').description('BERT market-maker operator CLI').version('0.1.0');

function cfg() {
  return loadConfigFromFile(process.env.BERT_MM_CONFIG ?? '/etc/bert-mm-bot/config.yaml');
}
function store(c = cfg()) {
  const s = new StateStore(c.statePath);
  s.init();
  return s;
}
function osUser(): string {
  return userInfo().username;
}

program.command('status').action(async () => runStatus(cfg(), store()));
program.command('pause').action(async () => runPause(cfg(), store(), osUser(), true));
program.command('resume').action(async () => runPause(cfg(), store(), osUser(), false));
program.command('collect-fees').action(async () => runCollectFees(cfg(), store(), osUser()));
program
  .command('emergency-exit')
  .action(async () => runEmergencyExit(cfg(), store(), osUser()));
program
  .command('rebalance')
  .option('--force', 'bypass cooldowns')
  .action(async (opts) => runForceRebalance(cfg(), store(), osUser(), Boolean(opts.force)));
program
  .command('report')
  .option('-d, --days <n>', 'days', '7')
  .action(async (opts) => runReport(cfg(), store(), Number(opts.days)));
program
  .command('clear-degraded')
  .action(async () => runClearDegraded(cfg(), store(), osUser()));
program.command('reconcile').action(async () => runReconcile(cfg(), store(), osUser()));

program.parseAsync(process.argv).catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 14.2: Create `src/cli/status.ts`**

```ts
import type { BotConfig } from '../types.js';
import type { StateStore } from '../stateStore.js';

export async function runStatus(cfg: BotConfig, state: StateStore): Promise<void> {
  const pos = state.getCurrentPosition();
  const lastReb = state.lastRebalanceAt();
  const today = state.getRebalancesToday(Date.now());
  const degraded = state.isDegraded();
  console.log(
    JSON.stringify(
      {
        enabled: cfg.enabled,
        dryRun: cfg.dryRun,
        degraded,
        rebalancesToday: today,
        lastRebalanceAt: lastReb,
        position: pos,
      },
      null,
      2,
    ),
  );
  state.close();
}
```

- [ ] **Step 14.3: Create `src/cli/pause.ts`**

```ts
import { readFileSync, writeFileSync } from 'node:fs';
import type { BotConfig } from '../types.js';
import type { StateStore } from '../stateStore.js';

export async function runPause(
  _cfg: BotConfig,
  state: StateStore,
  osUser: string,
  pause: boolean,
): Promise<void> {
  const path = process.env.BERT_MM_CONFIG ?? '/etc/bert-mm-bot/config.yaml';
  const txt = readFileSync(path, 'utf8');
  const next = txt.replace(/enabled:\s*(true|false)/, `enabled: ${pause ? 'false' : 'true'}`);
  writeFileSync(path, next);
  state.recordOperatorAction({
    ts: Date.now(),
    command: pause ? 'pause' : 'resume',
    osUser,
  });
  console.log(`enabled=${!pause} (takes effect on next poll cycle)`);
  state.close();
}
```

- [ ] **Step 14.4: Create `src/cli/clear-degraded.ts`**

```ts
import type { BotConfig } from '../types.js';
import type { StateStore } from '../stateStore.js';
import { createInterface } from 'node:readline/promises';

export async function runClearDegraded(
  _cfg: BotConfig,
  state: StateStore,
  osUser: string,
): Promise<void> {
  if (!state.isDegraded()) {
    console.log('not currently degraded; nothing to clear');
    state.close();
    return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    'Clear degraded flag? This resumes normal operation. (type YES): ',
  );
  rl.close();
  if (answer.trim() !== 'YES') {
    console.log('aborted');
    state.close();
    return;
  }
  state.setDegraded(false, `cleared by ${osUser}`);
  state.recordOperatorAction({ ts: Date.now(), command: 'clear-degraded', osUser });
  console.log('degraded flag cleared');
  state.close();
}
```

- [ ] **Step 14.5: Create `src/cli/emergency-exit.ts`**

```ts
import type { BotConfig } from '../types.js';
import type { StateStore } from '../stateStore.js';
import { createInterface } from 'node:readline/promises';
import { Keypair, Connection } from '@solana/web3.js';
import { readFileSync } from 'node:fs';
import { RaydiumClientImpl } from '../raydiumClient.js';
import { TxSubmitter } from '../txSubmitter.js';

export async function runEmergencyExit(
  cfg: BotConfig,
  state: StateStore,
  osUser: string,
): Promise<void> {
  const pos = state.getCurrentPosition();
  if (!pos) {
    console.log('no position to exit');
    state.close();
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `EMERGENCY EXIT will close position ${pos.nftMint}. Type CLOSE to confirm: `,
  );
  rl.close();
  if (answer.trim() !== 'CLOSE') {
    console.log('aborted');
    state.close();
    return;
  }

  const keyJson = JSON.parse(readFileSync(cfg.keyfilePath, 'utf8')) as number[];
  const payer = Keypair.fromSecretKey(Uint8Array.from(keyJson));
  const conn = new Connection(cfg.rpcPrimary, 'confirmed');
  const raydium = new RaydiumClientImpl(cfg.rpcPrimary, cfg.rpcFallback, cfg.poolAddress, payer);
  await raydium.init();

  const { tx } = await raydium.buildClosePositionTx(pos.nftMint);
  const submitter = new TxSubmitter(conn, payer);
  const sig = await submitter.submit(tx, { dryRun: cfg.dryRun });
  state.clearCurrentPosition();
  state.recordOperatorAction({ ts: Date.now(), command: 'emergency-exit', osUser });
  state.recordRebalance({
    ts: Date.now(),
    oldCenterUsd: pos.centerUsd,
    newCenterUsd: 0,
    feesCollectedUsd: 0,
  });
  console.log(`position closed: ${sig}`);
  state.close();
}
```

- [ ] **Step 14.6: Create remaining CLI commands**

Each follows the same pattern (≤40 lines). Full code for each:

**`src/cli/collect-fees.ts`** — load keypair, init raydium client, call `simulateClose` to read current fees, then issue a tiny transaction that collects fees without closing the position. If the SDK does not expose a standalone fee-collect path, issue `closePosition` followed immediately by `openPosition` with the same range. Log operator action, report fees collected, exit.

**`src/cli/force-rebalance.ts`** — reproduces the Task 13.10 rebalance sequence but reads `newCenterUsd` from the live oracle directly and skips only the cooldown/daily-cap checks (still honors slippage abort, drawdown breaker, and inventory cap). Logs operator action.

**`src/cli/report.ts`** — reads `rebalance_log`, `operator_actions`, and `position_state` from SQLite for the last N days; computes and prints: position value, fees collected, rebalances count, time-in-range (estimated from rebalance log gaps), WARN/CRITICAL counts from alert log. Pure read, no operator action recorded.

**`src/cli/reconcile.ts`** — re-runs startup reconciliation; if MISMATCH, prompts `"Overwrite state.db from chain? Type OVERWRITE"`. If confirmed, rewrites `position_state` from on-chain truth. Logs operator action.

- [ ] **Step 14.7: Build and smoke test**

```bash
pnpm build
BERT_MM_CONFIG=/opt/bert-mm-bot/config.local.yaml node dist/cli/index.js status
```

Expected: JSON status printed, no errors.

- [ ] **Step 14.8: Commit**

```bash
git add src/cli/
git commit -m "feat(cli): operator command tool"
```

---

## Task 15: Systemd unit, logrotate, heartbeat check

**Files:**
- Create: `/opt/bert-mm-bot/systemd/bert-mm-bot.service`
- Create: `/opt/bert-mm-bot/ops/logrotate.conf`
- Create: `/opt/bert-mm-bot/ops/heartbeat-check.sh`

- [ ] **Step 15.1: Create systemd unit**

```ini
[Unit]
Description=BERT Market-Maker Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=bertmm
Group=bertmm
WorkingDirectory=/opt/bert-mm-bot
Environment=NODE_ENV=production
Environment=BERT_MM_CONFIG=/etc/bert-mm-bot/config.yaml
EnvironmentFile=-/etc/bert-mm-bot/env
ExecStart=/usr/bin/node /opt/bert-mm-bot/dist/main.js
Restart=always
RestartSec=10
StandardOutput=append:/var/log/bert-mm-bot/bot.log
StandardError=append:/var/log/bert-mm-bot/bot.log
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/bert-mm-bot /var/log/bert-mm-bot
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 15.2: Create `ops/logrotate.conf`**

```
/var/log/bert-mm-bot/bot.log {
    daily
    rotate 30
    compress
    delaycompress
    missingok
    notifempty
    create 0640 bertmm bertmm
    sharedscripts
    postrotate
        systemctl reload-or-restart bert-mm-bot || true
    endscript
}
```

- [ ] **Step 15.3: Create `ops/heartbeat-check.sh`**

```bash
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
```

- [ ] **Step 15.4: Commit**

```bash
chmod +x ops/heartbeat-check.sh
git add systemd/ ops/
git commit -m "chore(ops): systemd unit, logrotate, heartbeat check"
```

---

## Task 16: Rescue transaction script

**Files:**
- Create: `/opt/bert-mm-bot/scripts/rescue-tx.ts`

- [ ] **Step 16.1: Create `scripts/rescue-tx.ts`**

```ts
// Usage: tsx scripts/rescue-tx.ts <SAFE_DESTINATION_ADDRESS>
// Transfers ALL SOL and ALL BERT from the bot's hot wallet to the destination.
// Intended for key-compromise scenarios.

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  SystemProgram,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAccount,
} from '@solana/spl-token';
import { readFileSync } from 'node:fs';

const BERT_MINT = new PublicKey('HgBRWfYxEfvPhtqkaeymCQtHCrKE46qQ43pKe8HCpump');
const RPC = process.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com';
const KEYFILE = process.env.KEYFILE ?? '/etc/bert-mm-bot/hot-wallet.json';

async function main() {
  const dest = process.argv[2];
  if (!dest) throw new Error('usage: rescue-tx.ts <destination>');
  const destPk = new PublicKey(dest);

  const key = JSON.parse(readFileSync(KEYFILE, 'utf8')) as number[];
  const payer = Keypair.fromSecretKey(Uint8Array.from(key));
  const conn = new Connection(RPC, 'confirmed');

  const fromAta = getAssociatedTokenAddressSync(BERT_MINT, payer.publicKey);
  const toAta = getAssociatedTokenAddressSync(BERT_MINT, destPk);

  const tx = new Transaction();

  const toAtaInfo = await conn.getAccountInfo(toAta);
  if (!toAtaInfo) {
    tx.add(createAssociatedTokenAccountInstruction(payer.publicKey, toAta, destPk, BERT_MINT));
  }

  try {
    const fromAccount = await getAccount(conn, fromAta);
    if (fromAccount.amount > 0n) {
      tx.add(createTransferInstruction(fromAta, toAta, payer.publicKey, fromAccount.amount));
    }
  } catch {
    console.warn('no BERT ATA on source wallet; skipping BERT transfer');
  }

  const balance = await conn.getBalance(payer.publicKey);
  const rentExempt = await conn.getMinimumBalanceForRentExemption(0);
  const lamportsToSend = balance - rentExempt - 5000;
  if (lamportsToSend > 0) {
    tx.add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: destPk,
        lamports: lamportsToSend,
      }),
    );
  }

  const sig = await sendAndConfirmTransaction(conn, tx, [payer]);
  console.log(`RESCUE OK: ${sig}`);
}

main().catch((e) => {
  console.error('RESCUE FAILED:', e);
  process.exit(1);
});
```

- [ ] **Step 16.2: Commit**

```bash
git add scripts/rescue-tx.ts
git commit -m "feat(ops): pre-drafted rescue transaction for key compromise"
```

---

## Task 17: README and operator runbook

**Files:**
- Create: `/opt/bert-mm-bot/README.md`

- [ ] **Step 17.1: Create `README.md`**

```markdown
# bert-mm-bot

Autonomous Raydium CLMM position manager for BERT/SOL.
See `docs/superpowers/specs/2026-04-09-bert-mm-bot-design.md` for full design.

## Quick start

1. Install: `pnpm install && pnpm build`
2. Create hot wallet: `solana-keygen new -o /etc/bert-mm-bot/hot-wallet.json`
   `chown bertmm:bertmm /etc/bert-mm-bot/hot-wallet.json && chmod 600 ...`
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
- > 90%: range well-sized or slightly wide
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
```

- [ ] **Step 17.2: Commit**

```bash
git add README.md
git commit -m "docs: runbook and operator quick-start"
```

---

## Task 18: Canary deploy (first 48 hours)

Operational gate between "built" and "real pilot."

- [ ] **Step 18.1: Final pre-flight**

```bash
cd /opt/bert-mm-bot
pnpm test
pnpm build
```

Expected: all tests pass, no type errors, `dist/` built.

- [ ] **Step 18.2: Canary config**

Create `/etc/bert-mm-bot/config.yaml` with **`maxPositionUsd: 200`** (one tenth of target). Same everywhere else.

- [ ] **Step 18.3: Canary deploy**

1. Fund hot wallet with $200-equivalent ($100 BERT + $100 SOL).
2. `systemctl start bert-mm-bot`
3. Verify initial position opened via Solscan.
4. Monitor webhook channels for 48 hours.
5. `bert-mm status` a few times daily.

Pass criteria:
- Zero CRITICAL alerts.
- Successful `HOLD` ticks throughout 48h.
- Position in-range ≥ 70% of the time (short window tolerance).
- At least one successful rebalance observed end-to-end, if price moves.
- Heartbeat check passes throughout (add to cron).

- [ ] **Step 18.4: Scale to target**

On canary pass:

1. `bert-mm emergency-exit`
2. `systemctl stop bert-mm-bot`
3. Set `maxPositionUsd: 2200` in config.
4. Treasury tops up hot wallet to ~$2k total.
5. `systemctl start bert-mm-bot`
6. Verify new $2k position opened.
7. Publish hot wallet address to community (optional, per spec §7.8).

---

## Self-review

- **Spec §1 success criteria** — Task 18.3 canary criteria map to the pilot criteria; Task 18 done-criteria #6 below maps to "time in range ≥ 80% over 7 days."
- **Spec §2 approach #2** — Tasks 1–14 build the autonomous bot.
- **Spec §3 tech stack** — Task 1 scaffolding matches exactly.
- **Spec §4 architecture** — Tasks 3-12 create the eight modules with preserved boundaries.
- **Spec §5 rebalance logic** — Pure function in Task 7; execution sequence in Task 13.10.
- **Spec §6 guardrails** — All 11 covered: #1 daily cap (strategy tests), #2 min interval (strategy tests), #3 oracle divergence (Task 6), #4 oracle stale (Task 7), #5 slippage (Task 13.10), #6 drawdown (Task 13.10), #7 inventory (Task 13.10 + config bounds), #8 RPC failover (Task 13), #9 zod schema (Task 3), #10 reconciliation (Task 11), #11 SOL floor (Task 13.10).
- **Spec §6.3 kill-switches** — config flag (Task 14 pause), kill file (Task 12), systemctl (Task 15).
- **Spec §6.5 emergency-exit** — Task 14.5, manual only, interactive confirm.
- **Spec §7 wallet topology** — Task 17 README + Task 18 canary.
- **Spec §7.5 recovery** — Task 16 rescue script.
- **Spec §7.7 VPS hardening** — Task 15 systemd unit uses NoNewPrivileges, ProtectSystem, ProtectHome, PrivateTmp, ReadWritePaths.
- **Spec §8 observability** — Task 8 notifier, Task 4 logger, Task 5 action log, Task 12 heartbeat, Task 15 cron heartbeat-check.
- **Spec §8.7 CLI commands** — All 9 in Task 14 (status, pause, resume, collect-fees, emergency-exit, rebalance --force, report, clear-degraded, reconcile).
- **Spec §9 testing** — Unit tests for config/state/oracle/strategy/notifier/reconciler across Tasks 3-11. Dry-run in Task 13.12. Canary in Task 18.
- **Spec §10 runbook** — Task 17 README.
- **Spec §11 Q1 fee tier verify** — Task 13.2 explicitly.
- **Placeholder scan** — Each step contains concrete code or concrete commands. The `throw new Error('... in Task 13')` lines in Task 9 skeleton are deliberate implementation markers the later task resolves.
- **Type consistency** — `BotState`, `Decision`, `PositionSnapshot`, `MidPrice`, `StoredPosition`, `BotConfig`, `RaydiumClient`, `StrategyParams`, `ReconcileResult`, `StoredPosition.openedAt`, `PositionSnapshot.openedAt` all match across tasks.
- **Deferred flexibility** — Task 13 intentionally does not pin Raydium SDK method names because the SDK evolves; Task 13.1 instructs reading current docs. Wrapper interface is fixed in Task 9.

---

## Done criteria

1. `pnpm test` — all green.
2. `pnpm build` — no warnings, `dist/main.js` + `dist/cli/index.js` exist.
3. `bert-mm status` works end-to-end against a real hot wallet.
4. 5-minute mainnet dry-run (Task 13.12) clean.
5. 48-hour canary at $200 (Task 18.3) with zero CRITICAL alerts.
6. 7-day pilot at $2k with **time-in-range ≥ 80%** (spec §1 success criterion).

After criterion 6 is met, the pilot is proven and the project can decide on scale-up, Meteora DLMM expansion, or key-management upgrade per spec §11.
