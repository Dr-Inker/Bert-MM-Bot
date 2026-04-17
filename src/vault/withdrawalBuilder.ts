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
  /** Main pool wallet paying out the withdrawal (signer on the tx). */
  payer: PublicKey;
  /** Depositor's destination wallet. Caller MUST validate this is a real user address. */
  destinationWallet: PublicKey;
  solLamports: bigint;
  bertRaw: bigint;
  bertMint: PublicKey;
  /** Prepend an idempotent ATA-create ix for the destination's BERT ATA. */
  createDestAtaIfMissing: boolean;
}

/**
 * Build (but do not submit) the instructions to send SOL and/or BERT from the
 * main pool wallet to a depositor's destination address.
 *
 * Caller responsibilities:
 *   - Build the Transaction, set recent blockhash, and sign with the payer keypair.
 *   - Validate `destinationWallet` is a real wallet pubkey (see notes below on
 *     `allowOwnerOffCurve`).
 *
 * Throws if both amounts are zero (nothing to transfer).
 */
export function buildWithdrawalInstructions(p: WithdrawalParams): TransactionInstruction[] {
  if (p.solLamports === 0n && p.bertRaw === 0n) {
    throw new Error('buildWithdrawalInstructions: nothing to transfer');
  }

  const ixs: TransactionInstruction[] = [];

  if (p.solLamports > 0n) {
    ixs.push(SystemProgram.transfer({
      fromPubkey: p.payer,
      toPubkey: p.destinationWallet,
      lamports: Number(p.solLamports),
    }));
  }

  if (p.bertRaw > 0n) {
    // NOTE: `allowOwnerOffCurve=true` per plan — permits PDA destinations (e.g.
    // a smart-wallet user). The caller MUST validate destinationWallet at a
    // higher layer; otherwise funds can be sent to an unreachable pubkey.
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
