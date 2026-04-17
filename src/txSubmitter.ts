import {
  Connection,
  Keypair,
  Transaction,
  TransactionSignature,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { logger } from './logger.js';
import type { JitoClient } from './jitoClient.js';

export interface SubmitOptions {
  priorityFeeMicroLamports?: number;
  maxRetries?: number;
  dryRun?: boolean;
  extraSigners?: import('@solana/web3.js').Signer[];
}

export class TxSubmitter {
  constructor(
    private readonly connection: Connection,
    private readonly payer: Keypair,
    private readonly jito?: JitoClient,
  ) {}

  async submit(tx: Transaction, opts: SubmitOptions = {}): Promise<TransactionSignature> {
    const priority = opts.priorityFeeMicroLamports ?? 10_000;
    tx.instructions.unshift(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priority }),
    );

    if (opts.dryRun) {
      logger.info({ dryRun: true, ixs: tx.instructions.length }, 'DRY RUN: would submit tx');
      return 'DRY_RUN_SIGNATURE';
    }

    const maxRetries = opts.maxRetries ?? 3;
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const allSigners = [this.payer, ...(opts.extraSigners ?? [])];
        const sig = await sendAndConfirmTransaction(this.connection, tx, allSigners, {
          commitment: 'confirmed',
          maxRetries: 1,
        });
        logger.info({ sig, attempt }, 'tx confirmed');
        return sig;
      } catch (e) {
        lastErr = e;
        logger.warn({ attempt, err: e }, 'tx submit failed, will retry');
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    throw new Error(`tx submit failed after ${maxRetries} attempts: ${String(lastErr)}`);
  }

  /**
   * MEV-protected submission. Routes through Jito block engine (private
   * mempool, no sandwich/frontrun exposure) when configured; falls back
   * to regular RPC submission if Jito isn't configured, times out, or
   * rejects. Use this for any tx that crosses thin pool liquidity —
   * swap-to-ratio is the prime target.
   */
  async submitProtected(
    tx: Transaction,
    opts: SubmitOptions = {},
  ): Promise<TransactionSignature> {
    if (!this.jito) {
      return this.submit(tx, opts);
    }

    if (opts.dryRun) {
      logger.info({ dryRun: true, protected: true }, 'DRY RUN: would submit protected tx');
      return 'DRY_RUN_SIGNATURE';
    }

    // Attempt Jito first; fall back to regular RPC on null return (timeout /
    // not landed) or any throw (rejected / transport error).
    try {
      const sig = await this.jito.submitProtected(tx, opts.extraSigners ?? []);
      if (sig) return sig;
      logger.warn('jito submission did not land — falling back to public RPC');
    } catch (e) {
      logger.warn({ err: e }, 'jito submission threw — falling back to public RPC');
    }

    return this.submit(tx, opts);
  }
}
