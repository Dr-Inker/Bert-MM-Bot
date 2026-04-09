import {
  Connection,
  Keypair,
  Transaction,
  TransactionSignature,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { logger } from './logger.js';

export interface SubmitOptions {
  priorityFeeMicroLamports?: number;
  maxRetries?: number;
  dryRun?: boolean;
}

export class TxSubmitter {
  constructor(
    private readonly connection: Connection,
    private readonly payer: Keypair,
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
        const sig = await sendAndConfirmTransaction(this.connection, tx, [this.payer], {
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
}
