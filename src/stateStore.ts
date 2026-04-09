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

  listRebalancesSince(sinceMs: number): RebalanceRecord[] {
    const rows = this.db
      .prepare(
        'SELECT ts, old_center_usd, new_center_usd, fees_collected_usd FROM rebalance_log WHERE ts >= ? ORDER BY ts DESC',
      )
      .all(sinceMs) as Array<{
      ts: number;
      old_center_usd: number;
      new_center_usd: number;
      fees_collected_usd: number;
    }>;
    return rows.map((r) => ({
      ts: r.ts,
      oldCenterUsd: r.old_center_usd,
      newCenterUsd: r.new_center_usd,
      feesCollectedUsd: r.fees_collected_usd,
    }));
  }

  listOperatorActionsSince(sinceMs: number): OperatorAction[] {
    const rows = this.db
      .prepare('SELECT ts, command, os_user FROM operator_actions WHERE ts >= ? ORDER BY ts DESC')
      .all(sinceMs) as Array<{ ts: number; command: string; os_user: string }>;
    return rows.map((r) => ({ ts: r.ts, command: r.command, osUser: r.os_user }));
  }

  close(): void {
    this.db.close();
  }
}
