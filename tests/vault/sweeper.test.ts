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
    expect(ixs.length).toBe(1);
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
    expect(ixs.length).toBe(1);
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
    expect(ixs.length).toBe(1);
    const transferIx = ixs.find(ix => ix.programId.equals(SystemProgram.programId))!;
    const lamports = transferIx.data.readBigUInt64LE(4);
    expect(lamports).toBe(8_000_000n);  // 10_000_000 - 2_000_000 rent reserve
  });

  it('builds both SOL + BERT transfers when both > 0', () => {
    const from = Keypair.generate();
    const to = Keypair.generate().publicKey;
    const ixs = buildSweepInstructions({
      fromKeypair: from,
      toWallet: to,
      solLamports: 500_000_000n,
      bertRaw: 100_000_000n,
      bertMint: new PublicKey('HgBRWfYxEfvPhtqkaeymCQtHCrKE46qQ43pKe8HCpump'),
      rentReserveLamports: 2_000_000n,
    });
    expect(ixs.length).toBe(2);
    expect(ixs.some(ix => ix.programId.equals(SystemProgram.programId))).toBe(true);
    // SPL Token program id (TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA)
    expect(ixs.some(ix => !ix.programId.equals(SystemProgram.programId))).toBe(true);
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
