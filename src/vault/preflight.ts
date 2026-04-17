import {
  Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';

export interface PreflightResult {
  ata: string;
  created: boolean;
}

export interface PreflightArgs {
  connection: Connection;
  payer: Keypair;
  bertMint: PublicKey;
  /**
   * Submit + confirm a transaction. Defaults to sendAndConfirmTransaction from
   * @solana/web3.js. Tests can inject a stub to avoid mocking the full
   * Connection RPC surface.
   */
  submit?: (connection: Connection, tx: Transaction, signers: Keypair[]) => Promise<string>;
}

const defaultSubmit = (c: Connection, tx: Transaction, signers: Keypair[]): Promise<string> =>
  sendAndConfirmTransaction(c, tx, signers, { commitment: 'confirmed' });

/**
 * N9: Ensure the main wallet's BERT ATA exists before the sweeper runs.
 *
 * Every deposit sweep appends an SPL transfer to the main wallet's BERT ATA.
 * If that account does not exist, every sweep fails CPI and deposits loop
 * forever, filling the audit log with `deposit_sweep_failed` rows.
 *
 * At startup, if the ATA is missing we create it with the idempotent
 * instruction (so a concurrent startup from another operator instance — a
 * race we don't expect, but defence in depth — doesn't error out). Rent is
 * paid by the payer keypair.
 *
 * Fails closed: callers should throw on any error so the bot does not start
 * with a broken sweeper path.
 */
export async function preflightVaultAta(args: PreflightArgs): Promise<PreflightResult> {
  const ata = getAssociatedTokenAddressSync(args.bertMint, args.payer.publicKey, false);
  const existing = await args.connection.getAccountInfo(ata);
  if (existing !== null) {
    return { ata: ata.toBase58(), created: false };
  }
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      args.payer.publicKey,
      ata,
      args.payer.publicKey,
      args.bertMint,
    ),
  );
  const submit = args.submit ?? defaultSubmit;
  await submit(args.connection, tx, [args.payer]);
  return { ata: ata.toBase58(), created: true };
}
