import { describe, it, expect, vi } from 'vitest';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { preflightVaultAta } from '../../src/vault/preflight.js';

describe('preflightVaultAta (N9)', () => {
  it('returns existing ata without creating when getAccountInfo is non-null', async () => {
    const payer = Keypair.generate();
    const bertMint = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    const expectedAta = getAssociatedTokenAddressSync(bertMint, payer.publicKey, false).toBase58();

    const getAccountInfo = vi.fn(async () => ({
      lamports: 2_039_280,
      owner: new PublicKey('11111111111111111111111111111111'),
      data: Buffer.alloc(0),
      executable: false,
      rentEpoch: 0,
    }));
    const submit = vi.fn(async () => 'NOT_CALLED');
    const connection = { getAccountInfo } as any;

    const res = await preflightVaultAta({ connection, payer, bertMint, submit });

    expect(res.ata).toBe(expectedAta);
    expect(res.created).toBe(false);
    expect(getAccountInfo).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
  });

  it('creates ata when getAccountInfo returns null', async () => {
    const payer = Keypair.generate();
    const bertMint = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    const expectedAta = getAssociatedTokenAddressSync(bertMint, payer.publicKey, false).toBase58();

    const getAccountInfo = vi.fn(async () => null);
    const submit = vi.fn(async () => 'FAKE_ATA_SIG');
    const connection = { getAccountInfo } as any;

    const res = await preflightVaultAta({ connection, payer, bertMint, submit });

    expect(res.ata).toBe(expectedAta);
    expect(res.created).toBe(true);
    expect(getAccountInfo).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledOnce();

    // Confirm we submitted a Transaction with exactly the idempotent-create
    // instruction (spl-token program ixn). Defensive — a caller mistake
    // could end up calling the wrong program.
    const submittedArgs = submit.mock.calls[0];
    const tx: Transaction = submittedArgs[1];
    expect(tx.instructions).toHaveLength(1);
    // AssociatedTokenProgram id:
    expect(tx.instructions[0].programId.toBase58()).toBe(
      'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
    );
  });
});
