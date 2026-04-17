import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { buildWithdrawalInstructions } from '../../src/vault/withdrawalBuilder.js';

describe('buildWithdrawalInstructions', () => {
  const bertMint = new PublicKey('HgBRWfYxEfvPhtqkaeymCQtHCrKE46qQ43pKe8HCpump');

  it('builds SOL + BERT transfers with ATA create (exact 3 ixs)', () => {
    const payer = Keypair.generate();
    const dest = Keypair.generate().publicKey;
    const ixs = buildWithdrawalInstructions({
      payer: payer.publicKey,
      destinationWallet: dest,
      solLamports: 500_000_000n,
      bertRaw: 10_000_000n,
      bertMint,
      createDestAtaIfMissing: true,
    });
    // 1 SystemProgram.transfer + 1 ATA-idempotent create + 1 BERT transferChecked
    expect(ixs.length).toBe(3);
    expect(ixs[0].programId.equals(SystemProgram.programId)).toBe(true);
    // At least one non-System ix (the BERT transfer + ATA create are SPL/ATA program)
    expect(ixs.some((ix) => !ix.programId.equals(SystemProgram.programId))).toBe(true);
  });

  it('builds SOL + BERT transfers without ATA create (exact 2 ixs)', () => {
    const payer = Keypair.generate();
    const dest = Keypair.generate().publicKey;
    const ixs = buildWithdrawalInstructions({
      payer: payer.publicKey,
      destinationWallet: dest,
      solLamports: 500_000_000n,
      bertRaw: 10_000_000n,
      bertMint,
      createDestAtaIfMissing: false,
    });
    // 1 SystemProgram.transfer + 1 BERT transferChecked (no ATA create)
    expect(ixs.length).toBe(2);
    expect(ixs[0].programId.equals(SystemProgram.programId)).toBe(true);
  });

  it('SOL-only skips BERT instruction', () => {
    const payer = Keypair.generate();
    const dest = Keypair.generate().publicKey;
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

  it('BERT-only with ATA create (exact 2 ixs)', () => {
    const payer = Keypair.generate();
    const dest = Keypair.generate().publicKey;
    const ixs = buildWithdrawalInstructions({
      payer: payer.publicKey,
      destinationWallet: dest,
      solLamports: 0n,
      bertRaw: 10_000_000n,
      bertMint,
      createDestAtaIfMissing: true,
    });
    // 1 ATA-idempotent create + 1 BERT transferChecked, no SOL transfer
    expect(ixs.length).toBe(2);
    expect(ixs.every((ix) => !ix.programId.equals(SystemProgram.programId))).toBe(true);
  });

  it('throws when both amounts are zero', () => {
    const payer = Keypair.generate();
    const dest = Keypair.generate().publicKey;
    expect(() => buildWithdrawalInstructions({
      payer: payer.publicKey,
      destinationWallet: dest,
      solLamports: 0n,
      bertRaw: 0n,
      bertMint,
      createDestAtaIfMissing: true,
    })).toThrow(/nothing to transfer/);
  });
});
