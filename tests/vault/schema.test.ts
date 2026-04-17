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
