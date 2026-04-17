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
    const fromAta = getAssociatedTokenAddressSync(p.bertMint, p.fromKeypair.publicKey, false);
    const toAta = getAssociatedTokenAddressSync(p.bertMint, p.toWallet, false);
    ixs.push(createTransferCheckedInstruction(
      fromAta, p.bertMint, toAta, p.fromKeypair.publicKey,
      p.bertRaw, BERT_DECIMALS,
    ));
  }

  return ixs;
}
