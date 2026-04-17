import type { DepositorStore } from './depositorStore.js';
import { computeSharesForDeposit, SOL_DECIMALS, BERT_DECIMALS } from './shareMath.js';

export interface CreditParams {
  telegramId: number;
  inboundTxSig: string;
  sweepTxSig: string;
  solLamports: bigint;
  bertRaw: bigint;
  solUsd: number;
  bertUsd: number;
  navPerShareAtDeposit: number;
  confirmedAt: number;
  sweptAt: number;
  now: number;
}

export class CreditEngine {
  constructor(private deps: { store: DepositorStore }) {}

  /**
   * Credit a sweep-confirmed deposit: mint shares, write audit + NAV snapshot.
   * Atomic: all-or-nothing. Lets the DB UNIQUE(inbound_tx_sig) constraint
   * surface as an error if the sig has already been credited.
   */
  credit(p: CreditParams): void {
    const depositUsd =
      (Number(p.solLamports) / 10 ** SOL_DECIMALS) * p.solUsd +
      (Number(p.bertRaw) / 10 ** BERT_DECIMALS) * p.bertUsd;
    const sharesMinted = computeSharesForDeposit({
      depositUsd,
      navPerShare: p.navPerShareAtDeposit,
    });

    this.deps.store.withTransaction(() => {
      this.deps.store.creditDeposit({
        telegramId: p.telegramId,
        inboundTxSig: p.inboundTxSig,
        sweepTxSig: p.sweepTxSig,
        solLamports: p.solLamports,
        bertRaw: p.bertRaw,
        solUsd: p.solUsd,
        bertUsd: p.bertUsd,
        navPerShareAt: p.navPerShareAtDeposit,
        sharesMinted,
        confirmedAt: p.confirmedAt,
        sweptAt: p.sweptAt,
      });
      const totalShares = this.deps.store.totalShares();
      this.deps.store.insertNavSnapshot({
        ts: p.now,
        totalValueUsd: totalShares * p.navPerShareAtDeposit,
        totalShares,
        navPerShare: p.navPerShareAtDeposit,
        source: 'deposit',
      });
      this.deps.store.writeAudit({
        ts: p.now,
        telegramId: p.telegramId,
        event: 'deposit_credited',
        detailsJson: JSON.stringify({
          inboundTxSig: p.inboundTxSig,
          depositUsd,
          sharesMinted,
          navPerShare: p.navPerShareAtDeposit,
        }),
      });
    });
  }
}
