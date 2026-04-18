import { describe, it, expect, vi } from 'vitest';
import { DepositWatcher, type InflowEvent } from '../../src/vault/depositWatcher.js';

const TEST_ADDR = '11111111111111111111111111111111';

describe('DepositWatcher', () => {
  const mockConnection = (solDelta: number, bertDelta: number, sig: string) => ({
    getSignaturesForAddress: vi.fn().mockResolvedValue([{
      signature: sig, slot: 1, blockTime: 1700000000, err: null, confirmationStatus: 'confirmed',
    }]),
    getParsedTransaction: vi.fn().mockResolvedValue({
      meta: {
        preBalances: [0, 0],
        postBalances: [solDelta, 0],
        preTokenBalances: [{ owner: TEST_ADDR, mint: 'HgBRWfYxEfvPhtqkaeymCQtHCrKE46qQ43pKe8HCpump', uiTokenAmount: { amount: '0', decimals: 6 } }],
        postTokenBalances: [{ owner: TEST_ADDR, mint: 'HgBRWfYxEfvPhtqkaeymCQtHCrKE46qQ43pKe8HCpump', uiTokenAmount: { amount: String(bertDelta), decimals: 6 } }],
      },
      transaction: { message: { accountKeys: [{ pubkey: TEST_ADDR, signer: false, writable: true }] } },
    }),
    getSlot: vi.fn().mockResolvedValue(2),
  });

  it('detects a SOL-only inflow', async () => {
    const events: InflowEvent[] = [];
    const conn = mockConnection(1_500_000_000, 0, 'sig1');
    const watcher = new DepositWatcher({
      connection: conn as any,
      bertMint: 'HgBRWfYxEfvPhtqkaeymCQtHCrKE46qQ43pKe8HCpump',
      isAlreadyCredited: () => false,
      onInflow: async (e) => { events.push(e); },
    });
    await watcher.pollAddress(TEST_ADDR);
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({
      depositAddress: TEST_ADDR,
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
      bertMint: 'HgBRWfYxEfvPhtqkaeymCQtHCrKE46qQ43pKe8HCpump',
      isAlreadyCredited: () => false,
      onInflow: async (e) => { events.push(e); },
    });
    await watcher.pollAddress(TEST_ADDR);
    expect(events[0].bertRaw).toBe(250_000_000n);
    expect(events[0].solLamports).toBe(0n);
  });

  it('skips already-credited sigs', async () => {
    const events: InflowEvent[] = [];
    const conn = mockConnection(1_000_000, 0, 'sigC');
    const watcher = new DepositWatcher({
      connection: conn as any,
      bertMint: 'HgBRWfYxEfvPhtqkaeymCQtHCrKE46qQ43pKe8HCpump',
      isAlreadyCredited: (sig) => sig === 'sigC',
      onInflow: async (e) => { events.push(e); },
    });
    await watcher.pollAddress(TEST_ADDR);
    expect(events.length).toBe(0);
  });

  it('skips zero-delta txs', async () => {
    const events: InflowEvent[] = [];
    const conn = mockConnection(0, 0, 'sigD');
    const watcher = new DepositWatcher({
      connection: conn as any,
      bertMint: 'HgBRWfYxEfvPhtqkaeymCQtHCrKE46qQ43pKe8HCpump',
      isAlreadyCredited: () => false,
      onInflow: async (e) => { events.push(e); },
    });
    await watcher.pollAddress(TEST_ADDR);
    expect(events.length).toBe(0);
  });
});
