import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import {
  Raydium,
  SqrtPriceMath,
  type ApiV3PoolInfoConcentratedItem,
  type ClmmKeys,
  type ComputeClmmPoolInfo,
} from '@raydium-io/raydium-sdk-v2';
import { logger } from './logger.js';
import type { PositionSnapshot } from './types.js';

// CLMM program ID for Raydium Concentrated Liquidity
const CLMM_PROGRAM_ID = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';

export interface OpenPositionParams {
  lowerUsd: number;
  upperUsd: number;
  bertAmountRaw: bigint;
  solAmountLamports: bigint;
}

export interface PoolState {
  address: string;
  feeTier: number;
  currentTickIndex: number;
  sqrtPriceX64: bigint;
  bertUsd: number;
  solUsd: number;
  tvlUsd: number;
}

export interface RaydiumClient {
  init(): Promise<void>;
  getPoolState(): Promise<PoolState>;
  /**
   * Fetch the on-chain position identified by `nftMint`.
   * `solUsd` is required to convert tick-based price bounds to USD values.
   * Pass `mid?.solUsd ?? 0` from the orchestrator; a value of 0 yields zero USD bounds.
   */
  getPosition(nftMint: string, solUsd: number): Promise<PositionSnapshot | null>;
  buildOpenPositionTx(params: OpenPositionParams): Promise<{ tx: Transaction; nftMint: string }>;
  buildClosePositionTx(
    nftMint: string,
  ): Promise<{ tx: Transaction; expectedBertOut: bigint; expectedSolOut: bigint }>;
  buildSwapToRatioTx(params: {
    haveBertRaw: bigint;
    haveSolLamports: bigint;
    targetBertRatio: number;
  }): Promise<Transaction>;
  simulateClose(
    nftMint: string,
  ): Promise<{ effectivePriceUsd: number; bertOut: bigint; solOut: bigint }>;
}

export class RaydiumClientImpl implements RaydiumClient {
  private connection!: Connection;
  private raydium!: Raydium;

  // Cached pool data, populated by getPoolState()
  private _poolInfo?: ApiV3PoolInfoConcentratedItem;
  private _poolKeys?: ClmmKeys;
  private _computePoolInfo?: ComputeClmmPoolInfo;

  constructor(
    private readonly rpcPrimary: string,
    private readonly rpcFallback: string,
    private readonly poolAddress: string,
    private readonly bertMint: string,
    private readonly payer?: Keypair,
  ) {}

  async init(): Promise<void> {
    this.connection = new Connection(this.rpcPrimary, 'confirmed');
    const slot = await this.connection.getSlot();
    this.raydium = await Raydium.load({
      connection: this.connection,
      cluster: 'mainnet',
      disableLoadToken: true,
      owner: this.payer ? this.payer.publicKey : undefined,
    });
    logger.info({ slot, rpc: this.rpcPrimary, pool: this.poolAddress }, 'raydium client initialized');
  }

  async getPoolState(): Promise<PoolState> {
    const { poolInfo, poolKeys, computePoolInfo } =
      await this.raydium.clmm.getPoolInfoFromRpc(this.poolAddress);

    // Cache for use by getPosition()
    this._poolInfo = poolInfo;
    this._poolKeys = poolKeys;
    this._computePoolInfo = computePoolInfo;

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

    // Token amounts from liquidity: set to 0n for now (Stage B will compute properly)
    // TODO(Stage B): use LiquidityMath.getAmountsFromLiquidity to compute actual amounts
    const bertAmount = 0n;
    const solAmount = 0n;

    const totalValueUsd = 0; // Can't compute without amounts

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

  async buildOpenPositionTx(
    _params: OpenPositionParams,
  ): Promise<{ tx: Transaction; nftMint: string }> {
    throw new Error('buildOpenPositionTx: wire to Raydium SDK in Task 13 Stage B');
  }
  async buildClosePositionTx(
    _nftMint: string,
  ): Promise<{ tx: Transaction; expectedBertOut: bigint; expectedSolOut: bigint }> {
    throw new Error('buildClosePositionTx: wire to Raydium SDK in Task 13 Stage B');
  }
  async buildSwapToRatioTx(_params: {
    haveBertRaw: bigint;
    haveSolLamports: bigint;
    targetBertRatio: number;
  }): Promise<Transaction> {
    throw new Error('buildSwapToRatioTx: wire to Raydium SDK in Task 13 Stage B');
  }
  async simulateClose(
    _nftMint: string,
  ): Promise<{ effectivePriceUsd: number; bertOut: bigint; solOut: bigint }> {
    throw new Error('simulateClose: wire to Raydium SDK in Task 13 Stage B');
  }
}
