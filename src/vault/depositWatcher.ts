import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import type { Connection, ConfirmedSignatureInfo, ParsedTransactionWithMeta } from '@solana/web3.js';

export interface InflowEvent {
  depositAddress: string;
  inboundTxSig: string;
  solLamports: bigint;
  bertRaw: bigint;
  confirmedAt: number;
}

export interface DepositWatcherDeps {
  connection: Connection;
  bertMint: string;
  isAlreadyCredited: (sig: string) => boolean;
  onInflow: (event: InflowEvent) => Promise<void>;
}

export class DepositWatcher {
  constructor(private deps: DepositWatcherDeps) {}

  /** Poll one deposit address for new inflows. Calls onInflow() for each.
   *  Scans BOTH the main pubkey (for SOL transfers) and the user's BERT ATA
   *  (for SPL transfers — SPL txs don't touch the owner's main account, so
   *  `getSignaturesForAddress(owner)` alone misses BERT inflows). */
  async pollAddress(address: string): Promise<void> {
    const ownerPk = new PublicKey(address);
    const bertMintPk = new PublicKey(this.deps.bertMint);
    const bertAta = getAssociatedTokenAddressSync(bertMintPk, ownerPk, false);

    const [sigsMain, sigsAta] = await Promise.all([
      this.deps.connection.getSignaturesForAddress(ownerPk, { limit: 10 }),
      this.deps.connection.getSignaturesForAddress(bertAta, { limit: 10 }),
    ]);

    // Merge + dedupe by signature; a single tx can appear on both lists
    // (e.g. a deposit that sends SOL to the owner AND BERT to the ATA).
    const seen = new Set<string>();
    const sigs: ConfirmedSignatureInfo[] = [];
    for (const s of [...sigsMain, ...sigsAta]) {
      if (seen.has(s.signature)) continue;
      seen.add(s.signature);
      sigs.push(s);
    }

    for (const s of sigs) {
      if (s.err !== null) continue;
      if (this.deps.isAlreadyCredited(s.signature)) continue;
      const tx = await this.deps.connection.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
      if (!tx || !tx.meta) continue;
      const { solDelta, bertDelta } = this.computeDeltas(tx, address);
      if (solDelta === 0n && bertDelta === 0n) continue;
      await this.deps.onInflow({
        depositAddress: address,
        inboundTxSig: s.signature,
        solLamports: solDelta,
        bertRaw: bertDelta,
        confirmedAt: (s.blockTime ?? Math.floor(Date.now() / 1000)) * 1000,
      });
    }
  }

  private computeDeltas(tx: ParsedTransactionWithMeta, address: string): {
    solDelta: bigint; bertDelta: bigint;
  } {
    const meta = tx.meta!;
    const keys = tx.transaction.message.accountKeys.map(k =>
      typeof k === 'string' ? k : k.pubkey.toString()
    );
    const idx = keys.indexOf(address);
    let solDelta = 0n;
    if (idx >= 0) {
      const postBal = meta.postBalances[idx] ?? 0;
      const preBal = meta.preBalances[idx] ?? 0;
      solDelta = BigInt(postBal) - BigInt(preBal);
      if (solDelta < 0n) solDelta = 0n; // only count inflows
    }
    const pre = meta.preTokenBalances ?? [];
    const post = meta.postTokenBalances ?? [];
    const sumForAddress = (rows: readonly any[]): bigint => rows
      .filter(r => r.owner === address && r.mint === this.deps.bertMint)
      .reduce<bigint>((a, r) => a + BigInt(r.uiTokenAmount.amount), 0n);
    let bertDelta = sumForAddress(post) - sumForAddress(pre);
    if (bertDelta < 0n) bertDelta = 0n;
    return { solDelta, bertDelta };
  }
}
