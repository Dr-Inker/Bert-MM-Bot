import { Connection, Keypair, PublicKey, Signer, Transaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  Raydium,
  SqrtPriceMath,
  LiquidityMath,
  PoolUtils,
  TickMath,
  TxVersion,
  type ApiV3PoolInfoConcentratedItem,
  type ClmmKeys,
  type ComputeClmmPoolInfo,
  type ReturnTypeFetchMultiplePoolTickArrays,
} from '@raydium-io/raydium-sdk-v2';
import BN from 'bn.js';
import Decimal from 'decimal.js';
import { logger } from './logger.js';
import type { PositionSnapshot } from './types.js';
import type { VenueClient, OpenPositionParams, PoolState } from './venueClient.js';

// Re-export shared types so existing consumers don't break
export type { VenueClient, OpenPositionParams, PoolState };
/** @deprecated Use VenueClient instead */
export type RaydiumClient = VenueClient;

// CLMM program ID for Raydium Concentrated Liquidity
const CLMM_PROGRAM_ID = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';

// Pool-specific constants (confirmed by inspect-pool Stage A)
const TICK_SPACING = 120;
const SLIPPAGE_BPS = 300; // 3% slippage tolerance (micro-cap tokens need wider buffer)

export class RaydiumClientImpl implements VenueClient {
  private connection!: Connection;
  private raydium!: Raydium;

  // Cached pool data, populated by getPoolState()
  private _poolInfo?: ApiV3PoolInfoConcentratedItem;
  private _poolKeys?: ClmmKeys;
  private _computePoolInfo?: ComputeClmmPoolInfo;
  private _tickData?: ReturnTypeFetchMultiplePoolTickArrays;

  constructor(
    private readonly rpcPrimary: string,
    private readonly rpcFallback: string,
    private readonly poolAddress: string,
    private readonly bertMint: string,
    private readonly payer?: Keypair,
  ) {}

  getConnection(): Connection {
    return this.connection;
  }

  async init(): Promise<void> {
    this.connection = new Connection(this.rpcPrimary, 'confirmed');
    const slot = await this.connection.getSlot();
    this.raydium = await Raydium.load({
      connection: this.connection,
      cluster: 'mainnet',
      disableLoadToken: true,
      owner: this.payer ? this.payer.publicKey : undefined,
    });
    // H1 fix: redact API key from log output
    const rpcHost = new URL(this.rpcPrimary).hostname;
    logger.info({ slot, rpc: rpcHost, pool: this.poolAddress }, 'raydium client initialized');
  }

  async getPoolState(): Promise<PoolState> {
    const { poolInfo, poolKeys, computePoolInfo, tickData } =
      await this.raydium.clmm.getPoolInfoFromRpc(this.poolAddress);

    // Cache for use by getPosition() and write methods
    this._poolInfo = poolInfo;
    this._poolKeys = poolKeys;
    this._computePoolInfo = computePoolInfo;
    this._tickData = tickData;

    // feeTier: poolInfo.feeRate is a raw integer (e.g. 10000 = 1%).
    // Convert to fraction: 10000 / 1_000_000 = 0.01
    const feeTier = poolInfo.feeRate / 1_000_000;

    const tickCurrent = computePoolInfo.tickCurrent;
    if (tickCurrent === undefined) {
      logger.warn({ pool: this.poolAddress }, 'tickCurrent not available in computePoolInfo');
    }
    const currentTickIndex: number = tickCurrent ?? 0;

    const sqrtPriceX64BN = computePoolInfo.sqrtPriceX64;
    const sqrtPriceX64: bigint =
      sqrtPriceX64BN != null ? BigInt(sqrtPriceX64BN.toString()) : 0n;

    // tvl comes from poolInfo.tvl — may be 0 if the RPC path doesn't populate it
    const tvlUsd = poolInfo.tvl ?? 0;

    return {
      address: this.poolAddress,
      feeTier,
      currentTickIndex,
      sqrtPriceX64,
      // bertUsd and solUsd are 0 here; the oracle (Jupiter/DexScreener) provides real USD prices
      bertUsd: 0,
      solUsd: 0,
      tvlUsd,
    };
  }

  async getPosition(nftMint: string, solUsd: number): Promise<PositionSnapshot | null> {
    if (!this.payer) {
      throw new Error('getPosition requires payer to be set (read-only mode not supported)');
    }

    const positions = await this.raydium.clmm.getOwnerPositionInfo({
      programId: new PublicKey(CLMM_PROGRAM_ID),
    });

    const pos = positions.find((p) => p.nftMint.toBase58() === nftMint);
    if (!pos) return null;

    // Ensure pool info is cached
    if (!this._poolInfo || !this._computePoolInfo) {
      await this.getPoolState();
    }
    const poolInfo = this._poolInfo!;
    const computePoolInfo = this._computePoolInfo!;

    // Determine mint ordering: SOL=mintA, BERT=mintB (confirmed by inspect-pool)
    const isBertMintA = poolInfo.mintA.address === this.bertMint;
    const decimalsA = poolInfo.mintA.decimals;
    const decimalsB = poolInfo.mintB.decimals;

    // Compute price at lower/upper ticks: price = mintB per mintA
    const sqrtLower = SqrtPriceMath.getSqrtPriceX64FromTick(pos.tickLower);
    const sqrtUpper = SqrtPriceMath.getSqrtPriceX64FromTick(pos.tickUpper);

    // priceAtTick = mintB per mintA
    const priceLower = SqrtPriceMath.sqrtPriceX64ToPrice(sqrtLower, decimalsA, decimalsB).toNumber();
    const priceUpper = SqrtPriceMath.sqrtPriceX64ToPrice(sqrtUpper, decimalsA, decimalsB).toNumber();

    let lowerBertUsd: number;
    let upperBertUsd: number;

    if (isBertMintA) {
      // BERT=mintA, SOL=mintB: price = SOL per BERT → bertPerSol = price, bertUsd = solUsd / (1/price)
      // bertUsd = price * solUsd (SOL/BERT * USD/SOL = USD/BERT)
      // Note: price here = mintB(SOL) per mintA(BERT)
      lowerBertUsd = priceLower * solUsd;
      upperBertUsd = priceUpper * solUsd;
    } else {
      // SOL=mintA, BERT=mintB: price = BERT per SOL
      // bertPerSol = price, bertUsd = solUsd / bertPerSol
      // Lower tick price → smaller BERT per SOL → higher bertUsd
      // Upper tick price → larger BERT per SOL → lower bertUsd
      lowerBertUsd = priceUpper > 0 ? solUsd / priceUpper : 0;
      upperBertUsd = priceLower > 0 ? solUsd / priceLower : 0;
    }

    const centerBertUsd = (lowerBertUsd + upperBertUsd) / 2;
    const widthPct = centerBertUsd > 0 ? ((upperBertUsd - lowerBertUsd) / centerBertUsd) * 100 : 0;

    // Uncollected fees: tokenFeesOwedA / B maps to SOL/BERT depending on mint order
    let uncollectedFeesBert: bigint;
    let uncollectedFeesSol: bigint;
    if (isBertMintA) {
      uncollectedFeesBert = BigInt(pos.tokenFeesOwedA.toString());
      uncollectedFeesSol = BigInt(pos.tokenFeesOwedB.toString());
    } else {
      // SOL=mintA, BERT=mintB
      uncollectedFeesSol = BigInt(pos.tokenFeesOwedA.toString());
      uncollectedFeesBert = BigInt(pos.tokenFeesOwedB.toString());
    }

    // Compute actual token amounts from position liquidity using LiquidityMath
    const sqrtCurrent = computePoolInfo.sqrtPriceX64;
    const { amountA, amountB } = LiquidityMath.getAmountsFromLiquidity(
      sqrtCurrent,
      sqrtLower,
      sqrtUpper,
      pos.liquidity,
      /* roundUp */ true,
    );

    // Map amountA/amountB to BERT/SOL based on mint ordering
    let bertAmount: bigint;
    let solAmount: bigint;
    if (isBertMintA) {
      bertAmount = BigInt(amountA.toString());
      solAmount = BigInt(amountB.toString());
    } else {
      // SOL=mintA, BERT=mintB
      solAmount = BigInt(amountA.toString());
      bertAmount = BigInt(amountB.toString());
    }

    // totalValueUsd: BERT value + SOL value
    const bertValueUsd =
      centerBertUsd > 0
        ? (Number(bertAmount) / Math.pow(10, isBertMintA ? decimalsA : decimalsB)) * centerBertUsd
        : 0;
    const solValueUsd =
      solUsd > 0
        ? (Number(solAmount) / 1e9) * solUsd
        : 0;
    const totalValueUsd = bertValueUsd + solValueUsd;

    // openedAt: not available on-chain; the orchestrator prefers state.db's openedAt.
    // We return Date.now() as a fallback.
    const openedAt = Date.now();

    return {
      nftMint,
      range: {
        lowerBertUsd,
        upperBertUsd,
        centerBertUsd,
        widthPct,
      },
      bertAmount,
      solAmount,
      uncollectedFeesBert,
      uncollectedFeesSol,
      totalValueUsd,
      openedAt,
    };
  }

  // -------------------------------------------------------------------------
  // Write-side helpers
  // -------------------------------------------------------------------------

  /**
   * Convert a USD price for BERT to the nearest valid tick (multiple of tickSpacing).
   * Pool is SOL=mintA (9 dec), BERT=mintB (6 dec), so pool price = BERT per SOL.
   * bertPerSol = bertUsd / solUsd → higher bertUsd = lower tick (less BERT per SOL).
   */
  private _usdToTick(bertUsd: number, solUsd: number): number {
    if (solUsd <= 0 || bertUsd <= 0) {
      throw new Error(`Invalid USD prices: bertUsd=${bertUsd}, solUsd=${solUsd}`);
    }
    const poolInfo = this._poolInfo!;
    const isBertMintA = poolInfo.mintA.address === this.bertMint;

    let priceDec: Decimal;
    if (isBertMintA) {
      // BERT=mintA, SOL=mintB: pool price = mintB/mintA = SOL per BERT = bertUsd / solUsd
      priceDec = new Decimal(bertUsd).div(solUsd);
    } else {
      // SOL=mintA, BERT=mintB: pool price = mintB/mintA = BERT per SOL = solUsd / bertUsd
      priceDec = new Decimal(solUsd).div(bertUsd);
    }

    return TickMath.getTickWithPriceAndTickspacing(
      priceDec,
      TICK_SPACING,
      poolInfo.mintA.decimals,
      poolInfo.mintB.decimals,
    );
  }

  /**
   * Ensure pool data is populated; if not, refresh it.
   */
  private async _ensurePoolData(): Promise<void> {
    if (!this._poolInfo || !this._computePoolInfo || !this._tickData) {
      await this.getPoolState();
    }
  }

  async buildOpenPositionTx(
    params: OpenPositionParams,
  ): Promise<{ tx: Transaction; nftMint: string; signers: Signer[] }> {
    const { lowerUsd, upperUsd, bertAmountRaw, solAmountLamports, solUsd } = params;
    await this._ensurePoolData();
    const poolInfo = this._poolInfo!;
    const poolKeys = this._poolKeys;
    const computePoolInfo = this._computePoolInfo!;
    const isBertMintA = poolInfo.mintA.address === this.bertMint;

    // Convert USD bounds to ticks using the oracle-provided solUsd
    const tick1 = this._usdToTick(lowerUsd, solUsd);
    const tick2 = this._usdToTick(upperUsd, solUsd);
    // Ensure tick ordering (lower < upper)
    const tickLower = Math.min(tick1, tick2);
    const tickUpper = Math.max(tick1, tick2);

    // Compute liquidity from the input amounts
    // amountA and amountB must match the pool's mint ordering
    const amountA = new BN(
      isBertMintA ? bertAmountRaw.toString() : solAmountLamports.toString(),
    );
    const amountB = new BN(
      isBertMintA ? solAmountLamports.toString() : bertAmountRaw.toString(),
    );

    const sqrtLower = SqrtPriceMath.getSqrtPriceX64FromTick(tickLower);
    const sqrtUpper = SqrtPriceMath.getSqrtPriceX64FromTick(tickUpper);

    const liquidity = LiquidityMath.getLiquidityFromTokenAmounts(
      computePoolInfo.sqrtPriceX64,
      sqrtLower,
      sqrtUpper,
      amountA,
      amountB,
    );

    // amountMax with 1% slippage buffer (add=true direction for open)
    const slippageFactor = 1 + SLIPPAGE_BPS / 10_000;
    const amountMaxA = new BN(Math.ceil(Number(amountA.toString()) * slippageFactor).toString());
    const amountMaxB = new BN(Math.ceil(Number(amountB.toString()) * slippageFactor).toString());

    logger.info(
      { tickLower, tickUpper, liquidity: liquidity.toString(), amountMaxA: amountMaxA.toString(), amountMaxB: amountMaxB.toString() },
      'buildOpenPositionTx: computed params',
    );

    const result = await this.raydium.clmm.openPositionFromLiquidity({
      poolInfo,
      poolKeys,
      ownerInfo: { useSOLBalance: true },
      tickLower,
      tickUpper,
      liquidity,
      amountMaxA,
      amountMaxB,
      withMetadata: 'create',
      txVersion: TxVersion.LEGACY,
      computeBudgetConfig: undefined,
    });

    const tx = result.transaction as Transaction;
    const nftMint = result.extInfo.address.nftMint.toBase58();
    const signers = (result as any).signers as Signer[] ?? [];

    return { tx, nftMint, signers };
  }

  async buildClosePositionTx(
    nftMint: string,
  ): Promise<{ tx: Transaction; expectedBertOut: bigint; expectedSolOut: bigint }> {
    await this._ensurePoolData();
    const poolInfo = this._poolInfo!;
    const poolKeys = this._poolKeys;
    const isBertMintA = poolInfo.mintA.address === this.bertMint;

    // Fetch the position
    const positions = await this.raydium.clmm.getOwnerPositionInfo({
      programId: new PublicKey(CLMM_PROGRAM_ID),
    });
    const pos = positions.find((p) => p.nftMint.toBase58() === nftMint);
    if (!pos) throw new Error(`buildClosePositionTx: position not found for nftMint=${nftMint}`);

    // Fetch epochInfo for fee-aware amount computation
    const epochInfo = await this.connection.getEpochInfo();

    // Compute expected output amounts with 1% slippage (add=false = remove liquidity)
    const slippage = SLIPPAGE_BPS / 10_000;
    const amounts = await PoolUtils.getAmountsFromLiquidity({
      poolInfo,
      tickLower: pos.tickLower,
      tickUpper: pos.tickUpper,
      liquidity: pos.liquidity,
      slippage,
      add: false,
      epochInfo,
    });

    // amountSlippageA/B are the minimum amounts after slippage
    const amountMinA = amounts.amountSlippageA.amount;
    const amountMinB = amounts.amountSlippageB.amount;

    logger.info(
      {
        nftMint,
        liquidity: pos.liquidity.toString(),
        amountMinA: amountMinA.toString(),
        amountMinB: amountMinB.toString(),
      },
      'buildClosePositionTx: computed close params',
    );

    const result = await this.raydium.clmm.decreaseLiquidity({
      poolInfo,
      poolKeys,
      ownerPosition: pos,
      ownerInfo: { useSOLBalance: true, closePosition: true },
      liquidity: pos.liquidity,
      amountMinA,
      amountMinB,
      txVersion: TxVersion.LEGACY,
    });

    const tx = result.transaction as Transaction;

    // Map amountA/B to BERT/SOL based on mint ordering
    const expectedBertOut = isBertMintA
      ? BigInt(amounts.amountA.amount.toString())
      : BigInt(amounts.amountB.amount.toString());
    const expectedSolOut = isBertMintA
      ? BigInt(amounts.amountB.amount.toString())
      : BigInt(amounts.amountA.amount.toString());

    return { tx, expectedBertOut, expectedSolOut };
  }

  async simulateClose(
    nftMint: string,
    solUsd: number,
  ): Promise<{ effectivePriceUsd: number; bertOut: bigint; solOut: bigint }> {
    await this._ensurePoolData();
    const poolInfo = this._poolInfo!;
    const isBertMintA = poolInfo.mintA.address === this.bertMint;

    // Fetch the position
    const positions = await this.raydium.clmm.getOwnerPositionInfo({
      programId: new PublicKey(CLMM_PROGRAM_ID),
    });
    const pos = positions.find((p) => p.nftMint.toBase58() === nftMint);
    if (!pos) throw new Error(`simulateClose: position not found for nftMint=${nftMint}`);

    const epochInfo = await this.connection.getEpochInfo();
    const slippage = SLIPPAGE_BPS / 10_000;

    const amounts = await PoolUtils.getAmountsFromLiquidity({
      poolInfo,
      tickLower: pos.tickLower,
      tickUpper: pos.tickUpper,
      liquidity: pos.liquidity,
      slippage,
      add: false,
      epochInfo,
    });

    const bertOut = isBertMintA
      ? BigInt(amounts.amountA.amount.toString())
      : BigInt(amounts.amountB.amount.toString());
    const solOut = isBertMintA
      ? BigInt(amounts.amountB.amount.toString())
      : BigInt(amounts.amountA.amount.toString());

    const bertDecimals = isBertMintA ? poolInfo.mintA.decimals : poolInfo.mintB.decimals;
    const bertOutHuman = Number(bertOut) / Math.pow(10, bertDecimals);
    const solOutHuman = Number(solOut) / 1e9;

    // effectivePriceUsd: implied BERT/USD price derived from current pool price + solUsd.
    // Returned as a convenience metric for callers — not used for slippage calculations.
    let effectivePriceUsd = 0;
    if (bertOutHuman > 0 && solUsd > 0) {
      const computePoolInfo = this._computePoolInfo!;
      const poolPrice = SqrtPriceMath.sqrtPriceX64ToPrice(
        computePoolInfo.sqrtPriceX64,
        poolInfo.mintA.decimals,
        poolInfo.mintB.decimals,
      ).toNumber();
      // poolPrice = BERT per SOL (isBertMintA=false) or SOL per BERT (isBertMintA=true)
      effectivePriceUsd = isBertMintA
        ? poolPrice * solUsd
        : poolPrice > 0 ? solUsd / poolPrice : 0;
    }

    return { effectivePriceUsd, bertOut, solOut };
  }

  async buildSwapToRatioTx(params: {
    haveBertRaw: bigint;
    haveSolLamports: bigint;
    targetBertRatio: number;
  }): Promise<Transaction> {
    const { haveBertRaw, haveSolLamports, targetBertRatio } = params;
    await this._ensurePoolData();
    const poolInfo = this._poolInfo!;
    const poolKeys = this._poolKeys;
    const computePoolInfo = this._computePoolInfo!;
    const tickData = this._tickData!;
    const isBertMintA = poolInfo.mintA.address === this.bertMint;

    // Pool price = BERT per SOL (when isBertMintA=false) or SOL per BERT (when isBertMintA=true)
    const poolPrice = SqrtPriceMath.sqrtPriceX64ToPrice(
      computePoolInfo.sqrtPriceX64,
      poolInfo.mintA.decimals,
      poolInfo.mintB.decimals,
    ).toNumber();

    // Convert to common unit: BERT per SOL
    const bertPerSol = isBertMintA
      ? poolPrice > 0 ? 1 / poolPrice : 0  // poolPrice = SOL per BERT → bertPerSol = 1/poolPrice
      : poolPrice;                           // poolPrice = BERT per SOL already

    // Total value in "BERT units" (for ratio calculation)
    // haveBertRaw is in raw BERT (6 dec), haveSolLamports is in lamports (9 dec)
    const bertDecimals = isBertMintA ? poolInfo.mintA.decimals : poolInfo.mintB.decimals;
    const bertHuman = Number(haveBertRaw) / Math.pow(10, bertDecimals);
    const solHuman = Number(haveSolLamports) / 1e9;

    // targetBertRatio is fraction of total value to hold as BERT (0..1)
    // currentBertValue = bertHuman, currentSolValueInBert = solHuman * bertPerSol
    const totalInBert = bertHuman + solHuman * bertPerSol;
    const targetBertHuman = totalInBert * targetBertRatio;
    const deltaBert = targetBertHuman - bertHuman; // positive = need more BERT (buy BERT, sell SOL)

    const SLIPPAGE_FACTOR = 1 - SLIPPAGE_BPS / 10_000;

    // Get the per-pool tick array cache
    const poolTickCache = tickData[this.poolAddress] ?? {};

    let inputMint: PublicKey;
    let amountIn: BN;
    let amountOutMin: BN;

    if (deltaBert > 0) {
      // Need more BERT → sell SOL, buy BERT
      const deltaSolHuman = deltaBert / bertPerSol;
      const deltaSolLamports = Math.round(deltaSolHuman * 1e9);
      amountIn = new BN(deltaSolLamports.toString());
      inputMint = new PublicKey(poolInfo.mintA.address); // SOL = mintA

      // Compute expected output
      const { expectedAmountOut, remainingAccounts } =
        PoolUtils.getOutputAmountAndRemainAccounts(
          computePoolInfo,
          poolTickCache,
          inputMint,
          amountIn,
        );
      amountOutMin = new BN(
        Math.floor(Number(expectedAmountOut.toString()) * SLIPPAGE_FACTOR).toString(),
      );

      logger.info(
        { direction: 'SOL→BERT', amountIn: amountIn.toString(), expectedOut: expectedAmountOut.toString() },
        'buildSwapToRatioTx',
      );

      const result = await this.raydium.clmm.swap({
        poolInfo,
        poolKeys,
        inputMint,
        amountIn,
        amountOutMin,
        observationId: new PublicKey(poolKeys!.observationId),
        ownerInfo: { useSOLBalance: true },
        remainingAccounts,
        txVersion: TxVersion.LEGACY,
      });
      return result.transaction as Transaction;
    } else if (deltaBert < 0) {
      // Have too much BERT → sell BERT, buy SOL
      const excessBertHuman = -deltaBert;
      const excessBertRaw = Math.round(excessBertHuman * Math.pow(10, bertDecimals));
      amountIn = new BN(excessBertRaw.toString());
      inputMint = new PublicKey(poolInfo.mintB.address); // BERT = mintB (assuming isBertMintA=false)
      if (isBertMintA) {
        inputMint = new PublicKey(poolInfo.mintA.address);
      }

      const { expectedAmountOut, remainingAccounts } =
        PoolUtils.getOutputAmountAndRemainAccounts(
          computePoolInfo,
          poolTickCache,
          inputMint,
          amountIn,
        );
      amountOutMin = new BN(
        Math.floor(Number(expectedAmountOut.toString()) * SLIPPAGE_FACTOR).toString(),
      );

      logger.info(
        { direction: 'BERT→SOL', amountIn: amountIn.toString(), expectedOut: expectedAmountOut.toString() },
        'buildSwapToRatioTx',
      );

      const result = await this.raydium.clmm.swap({
        poolInfo,
        poolKeys,
        inputMint,
        amountIn,
        amountOutMin,
        observationId: new PublicKey(poolKeys!.observationId),
        ownerInfo: { useSOLBalance: true },
        remainingAccounts,
        txVersion: TxVersion.LEGACY,
      });
      return result.transaction as Transaction;
    } else {
      // Already at target ratio — return empty transaction
      logger.info('buildSwapToRatioTx: already at target ratio, no swap needed');
      return new Transaction();
    }
  }

  async getWalletBalances(): Promise<{ solLamports: bigint; bertRaw: bigint }> {
    if (!this.payer) {
      throw new Error('getWalletBalances requires payer to be set (read-only mode not supported)');
    }

    // Fetch SOL balance
    const solBalance = await this.connection.getBalance(this.payer.publicKey);
    const solLamports = BigInt(solBalance);

    // Fetch BERT token account balance
    let bertRaw = 0n;
    try {
      const ata = getAssociatedTokenAddressSync(
        new PublicKey(this.bertMint),
        this.payer.publicKey,
      );
      const tokenBalance = await this.connection.getTokenAccountBalance(ata);
      bertRaw = BigInt(tokenBalance.value.amount);
    } catch (e: unknown) {
      // If the ATA doesn't exist, return 0 rather than throwing
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.toLowerCase().includes('account not found') || msg.toLowerCase().includes('could not find account')) {
        logger.info({ bertMint: this.bertMint }, 'BERT ATA not found, returning 0 balance');
      } else {
        throw e;
      }
    }

    return { solLamports, bertRaw };
  }
}
