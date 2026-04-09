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
