import { Connection, Keypair, PublicKey, Signer, Transaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { createRequire } from 'node:module';
import BN from 'bn.js';
import Decimal from 'decimal.js';
import { logger } from './logger.js';
import type { PositionSnapshot } from './types.js';
import type {
  OpenPositionParams,
  PoolState,
  VenueClient,
} from './venueClient.js';

// ---------------------------------------------------------------------------
// DLMM import workaround
//
// @meteora-ag/dlmm's ESM entry tries to import a directory from @coral-xyz/anchor
// which Node's ESM resolver rejects (ERR_UNSUPPORTED_DIR_IMPORT). Loading via
// createRequire forces CJS resolution and avoids the issue.
// ---------------------------------------------------------------------------
const require = createRequire(import.meta.url);
const dlmmModule = require('@meteora-ag/dlmm') as {
  default?: any;
  DLMM?: any;
  getPriceOfBinByBinId: (binId: number, binStep: number) => Decimal;
  StrategyType: { Spot: number; Curve: number; BidAsk: number };
};
const DLMM = dlmmModule.default ?? dlmmModule.DLMM ?? dlmmModule;
const getPriceOfBinByBinId = dlmmModule.getPriceOfBinByBinId;
const StrategyType = dlmmModule.StrategyType;

const BERT_DECIMALS = 6;
const SOL_DECIMALS = 9;
const SLIPPAGE_BPS = 300; // 3% slippage tolerance
const FULL_BPS = new BN(10_000); // 100% in basis points

export class MeteoraClientImpl implements VenueClient {
  private connection!: Connection;
  private dlmmPool!: any;

  /** true when BERT is tokenX in the pool, false when BERT is tokenY */
  private bertIsX!: boolean;

  constructor(
    private readonly rpcPrimary: string,
    private readonly _rpcFallback: string,
    private readonly poolAddress: string,
    private readonly bertMint: string,
    private readonly payer?: Keypair,
  ) {}

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  getConnection(): Connection {
    return this.connection;
  }

  async init(): Promise<void> {
    this.connection = new Connection(this.rpcPrimary, 'confirmed');
    const poolPubkey = new PublicKey(this.poolAddress);
    this.dlmmPool = await DLMM.create(this.connection, poolPubkey);

    // Determine token ordering
    const tokenXMint = this.dlmmPool.tokenX.publicKey.toBase58();
    this.bertIsX = tokenXMint === this.bertMint;

    const rpcHost = new URL(this.rpcPrimary).hostname;
    logger.info(
      {
        rpc: rpcHost,
        pool: this.poolAddress,
        bertIsX: this.bertIsX,
        tokenX: tokenXMint,
        tokenY: this.dlmmPool.tokenY.publicKey.toBase58(),
      },
      'meteora client initialized',
    );
  }

  // ---------------------------------------------------------------------------
  // Read-side
  // ---------------------------------------------------------------------------

  async getPoolState(): Promise<PoolState> {
    await this.dlmmPool.refetchStates();
    const activeBin = await this.dlmmPool.getActiveBin();
    const feeInfo = this.dlmmPool.getFeeInfo();

    // activeBin.price is token-Y-per-token-X as a string
    const priceYPerX = parseFloat(activeBin.price);

    // Convert to bertUsd = 0 (oracle provides real USD prices, matching Raydium pattern)
    const feeTier = feeInfo.baseFeeRatePercentage.toNumber() / 100; // percentage -> fraction

    return {
      address: this.poolAddress,
      feeTier,
      currentTickIndex: activeBin.binId,
      sqrtPriceX64: 0n, // Not applicable for DLMM
      bertUsd: 0,
      solUsd: 0,
      tvlUsd: 0,
    };
  }

  async getPosition(nftMint: string, solUsd: number): Promise<PositionSnapshot | null> {
    if (!this.payer) {
      throw new Error('getPosition requires payer to be set');
    }

    // In DLMM, nftMint stores the position pubkey
    const positionPubkey = new PublicKey(nftMint);

    const { userPositions } = await this.dlmmPool.getPositionsByUserAndLbPair(
      this.payer.publicKey,
    );

    const pos = userPositions.find(
      (p: any) => p.publicKey.toBase58() === nftMint,
    );
    if (!pos) return null;

    const data = pos.positionData;

    // Token amounts
    const rawX = BigInt(data.totalXAmount.toString());
    const rawY = BigInt(data.totalYAmount.toString());
    const bertAmount = this.bertIsX ? rawX : rawY;
    const solAmount = this.bertIsX ? rawY : rawX;

    // Fees
    const feeX = BigInt(data.feeX.toString());
    const feeY = BigInt(data.feeY.toString());
    const uncollectedFeesBert = this.bertIsX ? feeX : feeY;
    const uncollectedFeesSol = this.bertIsX ? feeY : feeX;

    // Price range from bin IDs
    const binStep = this.dlmmPool.lbPair.binStep;
    const lowerBinId = data.lowerBinId;
    const upperBinId = data.upperBinId;

    // DLMM.getPriceOfBinByBinId returns the price as a string (tokenY per tokenX)
    const lowerPriceYPerX = getPriceOfBinByBinId(lowerBinId, binStep).toNumber();
    const upperPriceYPerX = getPriceOfBinByBinId(upperBinId, binStep).toNumber();

    // Convert SOL-per-BERT price to USD
    let lowerBertUsd: number;
    let upperBertUsd: number;
    if (this.bertIsX) {
      // price = SOL per BERT -> bertUsd = price * solUsd
      lowerBertUsd = lowerPriceYPerX * solUsd;
      upperBertUsd = upperPriceYPerX * solUsd;
    } else {
      // price = BERT per SOL -> bertUsd = solUsd / price
      // Lower bin = lower BERT-per-SOL = higher bertUsd (inverse)
      lowerBertUsd = upperPriceYPerX > 0 ? solUsd / upperPriceYPerX : 0;
      upperBertUsd = lowerPriceYPerX > 0 ? solUsd / lowerPriceYPerX : 0;
    }

    // Ensure lower <= upper
    if (lowerBertUsd > upperBertUsd) {
      [lowerBertUsd, upperBertUsd] = [upperBertUsd, lowerBertUsd];
    }

    const centerBertUsd = (lowerBertUsd + upperBertUsd) / 2;
    const widthPct = centerBertUsd > 0 ? ((upperBertUsd - lowerBertUsd) / centerBertUsd) * 100 : 0;

    // Total value
    const bertHuman = Number(bertAmount) / 10 ** BERT_DECIMALS;
    const solHuman = Number(solAmount) / 10 ** SOL_DECIMALS;
    const totalValueUsd = bertHuman * centerBertUsd + solHuman * solUsd;

    return {
      nftMint,
      range: { lowerBertUsd, upperBertUsd, centerBertUsd, widthPct },
      bertAmount,
      solAmount,
      uncollectedFeesBert,
      uncollectedFeesSol,
      totalValueUsd,
      openedAt: Date.now(), // Fallback; orchestrator prefers stateStore's openedAt
    };
  }

  // ---------------------------------------------------------------------------
  // Write-side
  // ---------------------------------------------------------------------------

  /**
   * Convert a BERT USD price to a DLMM bin ID.
   * Pool price is tokenY per tokenX.
   */
  private _usdToBinId(bertUsd: number, solUsd: number, roundDown: boolean): number {
    if (solUsd <= 0 || bertUsd <= 0) {
      throw new Error(`Invalid USD prices: bertUsd=${bertUsd}, solUsd=${solUsd}`);
    }

    let priceYPerX: number;
    if (this.bertIsX) {
      // tokenX=BERT, tokenY=SOL -> price = SOL per BERT = bertUsd / solUsd
      priceYPerX = bertUsd / solUsd;
    } else {
      // tokenX=SOL, tokenY=BERT -> price = BERT per SOL = solUsd / bertUsd
      priceYPerX = solUsd / bertUsd;
    }

    // getBinIdFromPrice expects the price and a boolean for min (floor vs ceil)
    return this.dlmmPool.getBinIdFromPrice(priceYPerX, roundDown);
  }

  async buildOpenPositionTx(
    params: OpenPositionParams,
  ): Promise<{ tx: Transaction; nftMint: string; signers: Signer[] }> {
    const { lowerUsd, upperUsd, bertAmountRaw, solAmountLamports, solUsd } = params;

    await this.dlmmPool.refetchStates();

    const minBinId = this._usdToBinId(lowerUsd, solUsd, true);
    const maxBinId = this._usdToBinId(upperUsd, solUsd, false);

    // Ensure correct ordering
    const actualMinBin = Math.min(minBinId, maxBinId);
    const actualMaxBin = Math.max(minBinId, maxBinId);

    // Position keypair (stored via nftMint field in stateStore)
    const positionKeypair = Keypair.generate();

    const totalXAmount = new BN(
      (this.bertIsX ? bertAmountRaw : solAmountLamports).toString(),
    );
    const totalYAmount = new BN(
      (this.bertIsX ? solAmountLamports : bertAmountRaw).toString(),
    );

    logger.info(
      {
        minBinId: actualMinBin,
        maxBinId: actualMaxBin,
        totalXAmount: totalXAmount.toString(),
        totalYAmount: totalYAmount.toString(),
        positionPubkey: positionKeypair.publicKey.toBase58(),
      },
      'buildOpenPositionTx: computed params',
    );

    const tx = await this.dlmmPool.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: positionKeypair.publicKey,
      totalXAmount,
      totalYAmount,
      strategy: {
        maxBinId: actualMaxBin,
        minBinId: actualMinBin,
        strategyType: StrategyType.Spot,
      },
      user: this.payer!.publicKey,
      slippage: SLIPPAGE_BPS,
    });

    return {
      tx: tx as Transaction,
      nftMint: positionKeypair.publicKey.toBase58(),
      signers: [positionKeypair],
    };
  }

  async buildClosePositionTx(
    nftMint: string,
  ): Promise<{ tx: Transaction; expectedBertOut: bigint; expectedSolOut: bigint }> {
    if (!this.payer) {
      throw new Error('buildClosePositionTx requires payer');
    }

    await this.dlmmPool.refetchStates();

    const { userPositions } = await this.dlmmPool.getPositionsByUserAndLbPair(
      this.payer.publicKey,
    );

    const pos = userPositions.find((p: any) => p.publicKey.toBase58() === nftMint);
    if (!pos) throw new Error(`buildClosePositionTx: position not found for ${nftMint}`);

    const data = pos.positionData;

    // Expected outputs before close
    const rawX = BigInt(data.totalXAmount.toString());
    const rawY = BigInt(data.totalYAmount.toString());
    const feeX = BigInt(data.feeX.toString());
    const feeY = BigInt(data.feeY.toString());

    const expectedBertOut = this.bertIsX ? rawX + feeX : rawY + feeY;
    const expectedSolOut = this.bertIsX ? rawY + feeY : rawX + feeX;

    logger.info(
      {
        nftMint,
        fromBinId: data.lowerBinId,
        toBinId: data.upperBinId,
        expectedBertOut: expectedBertOut.toString(),
        expectedSolOut: expectedSolOut.toString(),
      },
      'buildClosePositionTx: removing all liquidity',
    );

    // removeLiquidity returns Transaction[] — we combine them
    const txs = await this.dlmmPool.removeLiquidity({
      user: this.payer.publicKey,
      position: pos.publicKey,
      fromBinId: data.lowerBinId,
      toBinId: data.upperBinId,
      bps: FULL_BPS,
      shouldClaimAndClose: true,
    });

    // Merge all transactions into one
    const merged = new Transaction();
    for (const t of txs) {
      if (t instanceof Transaction && t.instructions.length > 0) {
        merged.add(...t.instructions);
      }
    }

    return { tx: merged, expectedBertOut, expectedSolOut };
  }

  /**
   * Remove liquidity from targeted bins to free up approximately the requested
   * amounts of SOL and/or BERT.
   *
   * Bin classification in Meteora DLMM (token Y per token X pricing):
   *   - bins with binId < activeBin hold only tokenY
   *   - bins with binId > activeBin hold only tokenX
   *   - the active bin is mixed
   *
   * To free SOL, we remove from bins holding SOL; to free BERT we remove
   * from bins holding BERT. The caller may request either or both.
   *
   * Implementation: we issue a separate removeLiquidity call per side (SOL side
   * and/or BERT side). Each side's call passes the contiguous min..max range
   * spanning that side's selected bins, with bps=10_000 (100% of each bin in
   * range). Splitting is required because a single min..max range covering
   * both sides would span the active bin and any intermediate bins on the
   * opposite side, causing a full position drain rather than a partial close.
   *
   * The active bin (mixed) is never included because side-selection filters
   * use strict `<` / `>`. Overshooting within a side is explicitly OK —
   * surplus remains in the wallet for the caller's next use.
   */
  async buildPartialCloseTx(args: {
    positionId: string;
    needSolLamports: bigint;
    needBertRaw: bigint;
  }): Promise<Transaction> {
    if (!this.payer) {
      throw new Error('buildPartialCloseTx requires payer');
    }

    await this.dlmmPool.refetchStates();

    const { userPositions } = await this.dlmmPool.getPositionsByUserAndLbPair(
      this.payer.publicKey,
    );
    const pos = userPositions.find(
      (p: any) => p.publicKey.toBase58() === args.positionId,
    );
    if (!pos) {
      throw new Error(`buildPartialCloseTx: position ${args.positionId} not found`);
    }

    const activeBin = (await this.dlmmPool.getActiveBin()).binId;
    const binData: Array<any> = pos.positionData.positionBinData;

    // Classify bins relative to active. The Y side holds the quote token, X
    // holds the base token. "solBins" = bins that hold SOL; "bertBins" = bins
    // that hold BERT.
    const binsBelow = binData
      .filter((b) => b.binId < activeBin)
      .sort((a, b) => b.binId - a.binId); // nearest (closest to active) first
    const binsAbove = binData
      .filter((b) => b.binId > activeBin)
      .sort((a, b) => a.binId - b.binId); // nearest first

    // When BERT is tokenX, below-active bins hold tokenY = SOL, above-active
    // bins hold tokenX = BERT. When BERT is tokenY, the mapping inverts.
    const solBins = this.bertIsX ? binsBelow : binsAbove;
    const bertBins = this.bertIsX ? binsAbove : binsBelow;
    // When BERT=X: SOL amount in a bin is positionYAmount, BERT is positionXAmount
    // When BERT=Y: SOL amount in a bin is positionXAmount, BERT is positionYAmount
    const solAmountField = this.bertIsX ? 'positionYAmount' : 'positionXAmount';
    const bertAmountField = this.bertIsX ? 'positionXAmount' : 'positionYAmount';

    // Build per-side selections. Each side's bins are sorted nearest-active
    // first, so selecting prefix bins yields a contiguous range in practice.
    const solSide: number[] = [];
    if (args.needSolLamports > 0n) {
      let collected = 0n;
      for (const b of solBins) {
        if (collected >= args.needSolLamports) break;
        solSide.push(b.binId);
        collected += BigInt(b[solAmountField].toString());
      }
    }

    const bertSide: number[] = [];
    if (args.needBertRaw > 0n) {
      let collected = 0n;
      for (const b of bertBins) {
        if (collected >= args.needBertRaw) break;
        bertSide.push(b.binId);
        collected += BigInt(b[bertAmountField].toString());
      }
    }

    if (solSide.length === 0 && bertSide.length === 0) {
      throw new Error(
        'buildPartialCloseTx: no bins selected (need amounts may be 0 or position has no eligible bins)',
      );
    }

    // Assemble side ranges to remove. Each non-empty side becomes one
    // removeLiquidity call with its own contiguous [min, max] range. Because
    // both strict `<` and `>` filters exclude the active bin, no side's range
    // will include the mixed active bin.
    const sideRanges: Array<{ label: 'sol' | 'bert'; fromBinId: number; toBinId: number }> = [];
    if (solSide.length > 0) {
      sideRanges.push({
        label: 'sol',
        fromBinId: Math.min(...solSide),
        toBinId: Math.max(...solSide),
      });
    }
    if (bertSide.length > 0) {
      sideRanges.push({
        label: 'bert',
        fromBinId: Math.min(...bertSide),
        toBinId: Math.max(...bertSide),
      });
    }

    logger.info(
      {
        positionId: args.positionId,
        activeBin,
        needSolLamports: args.needSolLamports.toString(),
        needBertRaw: args.needBertRaw.toString(),
        sideRanges: sideRanges.map((s) => ({
          label: s.label,
          fromBinId: s.fromBinId,
          toBinId: s.toBinId,
        })),
        solBinsSelected: solSide.length,
        bertBinsSelected: bertSide.length,
      },
      'buildPartialCloseTx: removing targeted bins per side',
    );

    // Issue one removeLiquidity call per side, merging all returned txs'
    // instructions into a single Transaction. This mirrors buildClosePositionTx.
    const merged = new Transaction();
    for (const side of sideRanges) {
      const txs = await this.dlmmPool.removeLiquidity({
        user: this.payer.publicKey,
        position: pos.publicKey,
        fromBinId: side.fromBinId,
        toBinId: side.toBinId,
        bps: FULL_BPS, // 100% of each bin in this side's range
        shouldClaimAndClose: false,
      });

      for (const t of txs) {
        if (t instanceof Transaction && t.instructions.length > 0) {
          merged.add(...t.instructions);
        }
      }
    }

    return merged;
  }

  async simulateClose(
    nftMint: string,
    solUsd: number,
  ): Promise<{ effectivePriceUsd: number; bertOut: bigint; solOut: bigint }> {
    if (!this.payer) {
      throw new Error('simulateClose requires payer');
    }

    await this.dlmmPool.refetchStates();

    const { userPositions } = await this.dlmmPool.getPositionsByUserAndLbPair(
      this.payer.publicKey,
    );

    const pos = userPositions.find((p: any) => p.publicKey.toBase58() === nftMint);
    if (!pos) throw new Error(`simulateClose: position not found for ${nftMint}`);

    const data = pos.positionData;
    const rawX = BigInt(data.totalXAmount.toString());
    const rawY = BigInt(data.totalYAmount.toString());
    const feeX = BigInt(data.feeX.toString());
    const feeY = BigInt(data.feeY.toString());

    const bertOut = this.bertIsX ? rawX + feeX : rawY + feeY;
    const solOut = this.bertIsX ? rawY + feeY : rawX + feeX;

    // Compute effective BERT/USD price from active bin
    let effectivePriceUsd = 0;
    if (solUsd > 0) {
      const activeBin = await this.dlmmPool.getActiveBin();
      const priceYPerX = parseFloat(activeBin.price);
      if (this.bertIsX) {
        // price = SOL per BERT
        effectivePriceUsd = priceYPerX * solUsd;
      } else {
        // price = BERT per SOL
        effectivePriceUsd = priceYPerX > 0 ? solUsd / priceYPerX : 0;
      }
    }

    return { effectivePriceUsd, bertOut, solOut };
  }

  async buildSwapToRatioTx(params: {
    haveBertRaw: bigint;
    haveSolLamports: bigint;
    targetBertRatio: number;
  }): Promise<Transaction> {
    const { haveBertRaw, haveSolLamports, targetBertRatio } = params;

    await this.dlmmPool.refetchStates();

    // Get current pool price to compute value ratio
    const activeBin = await this.dlmmPool.getActiveBin();
    const priceYPerX = parseFloat(activeBin.price);

    // Convert to bertPerSol for value calculations
    let bertPerSol: number;
    if (this.bertIsX) {
      // price = SOL per BERT -> bertPerSol = 1/price
      bertPerSol = priceYPerX > 0 ? 1 / priceYPerX : 0;
    } else {
      // price = BERT per SOL
      bertPerSol = priceYPerX;
    }

    if (bertPerSol <= 0) {
      logger.warn('buildSwapToRatioTx: zero pool price, returning empty tx');
      return new Transaction();
    }

    const bertHuman = Number(haveBertRaw) / 10 ** BERT_DECIMALS;
    const solHuman = Number(haveSolLamports) / 10 ** SOL_DECIMALS;
    const totalInBert = bertHuman + solHuman * bertPerSol;
    const targetBertHuman = totalInBert * targetBertRatio;
    const deltaBert = targetBertHuman - bertHuman;

    if (Math.abs(deltaBert) < 1) {
      // Less than 1 BERT of imbalance -- skip
      logger.info('buildSwapToRatioTx: already at target ratio, no swap needed');
      return new Transaction();
    }

    const slippageBN = new BN(SLIPPAGE_BPS);

    if (deltaBert > 0) {
      // Need more BERT -> sell SOL, buy BERT
      const deltaSolHuman = deltaBert / bertPerSol;
      const deltaSolLamports = Math.round(deltaSolHuman * 10 ** SOL_DECIMALS);
      const inAmount = new BN(deltaSolLamports.toString());

      // swapForY: are we swapping X for Y? If BERT is X, swapping SOL(Y) for BERT(X) = swapForY=false
      const swapForY = this.bertIsX ? false : true;
      const inToken = this.bertIsX
        ? this.dlmmPool.tokenY.publicKey
        : this.dlmmPool.tokenX.publicKey;
      const outToken = this.bertIsX
        ? this.dlmmPool.tokenX.publicKey
        : this.dlmmPool.tokenY.publicKey;

      const binArrays = await this.dlmmPool.getBinArrayForSwap(swapForY);
      const quote = await this.dlmmPool.swapQuote(inAmount, swapForY, slippageBN, binArrays);

      logger.info(
        {
          direction: 'SOL->BERT',
          inAmount: inAmount.toString(),
          minOutAmount: quote.minOutAmount.toString(),
        },
        'buildSwapToRatioTx',
      );

      const tx = await this.dlmmPool.swap({
        inToken,
        outToken,
        inAmount,
        minOutAmount: quote.minOutAmount,
        lbPair: this.dlmmPool.pubkey,
        user: this.payer!.publicKey,
        binArraysPubkey: quote.binArraysPubkey,
      });

      return tx as Transaction;
    } else {
      // Have too much BERT -> sell BERT, buy SOL
      const excessBertHuman = -deltaBert;
      const excessBertRaw = Math.round(excessBertHuman * 10 ** BERT_DECIMALS);
      const inAmount = new BN(excessBertRaw.toString());

      // swapForY: selling BERT. If BERT is X, swapping X for Y = swapForY=true
      const swapForY = this.bertIsX ? true : false;
      const inToken = this.bertIsX
        ? this.dlmmPool.tokenX.publicKey
        : this.dlmmPool.tokenY.publicKey;
      const outToken = this.bertIsX
        ? this.dlmmPool.tokenY.publicKey
        : this.dlmmPool.tokenX.publicKey;

      const binArrays = await this.dlmmPool.getBinArrayForSwap(swapForY);
      const quote = await this.dlmmPool.swapQuote(inAmount, swapForY, slippageBN, binArrays);

      logger.info(
        {
          direction: 'BERT->SOL',
          inAmount: inAmount.toString(),
          minOutAmount: quote.minOutAmount.toString(),
        },
        'buildSwapToRatioTx',
      );

      const tx = await this.dlmmPool.swap({
        inToken,
        outToken,
        inAmount,
        minOutAmount: quote.minOutAmount,
        lbPair: this.dlmmPool.pubkey,
        user: this.payer!.publicKey,
        binArraysPubkey: quote.binArraysPubkey,
      });

      return tx as Transaction;
    }
  }

  async getWalletBalances(): Promise<{ solLamports: bigint; bertRaw: bigint }> {
    if (!this.payer) {
      throw new Error('getWalletBalances requires payer');
    }

    const solBalance = await this.connection.getBalance(this.payer.publicKey);
    const solLamports = BigInt(solBalance);

    let bertRaw = 0n;
    try {
      const ata = getAssociatedTokenAddressSync(
        new PublicKey(this.bertMint),
        this.payer.publicKey,
      );
      const tokenBalance = await this.connection.getTokenAccountBalance(ata);
      bertRaw = BigInt(tokenBalance.value.amount);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (
        msg.toLowerCase().includes('account not found') ||
        msg.toLowerCase().includes('could not find account')
      ) {
        logger.info({ bertMint: this.bertMint }, 'BERT ATA not found, returning 0 balance');
      } else {
        throw e;
      }
    }

    return { solLamports, bertRaw };
  }
}
