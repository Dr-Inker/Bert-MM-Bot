import { Connection, Keypair, Transaction } from '@solana/web3.js';
import { logger } from './logger.js';
import type { PositionSnapshot } from './types.js';

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
  getPosition(nftMint: string): Promise<PositionSnapshot | null>;
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

  constructor(
    private readonly rpcPrimary: string,
    private readonly rpcFallback: string,
    private readonly poolAddress: string,
    private readonly payer: Keypair,
  ) {}

  async init(): Promise<void> {
    this.connection = new Connection(this.rpcPrimary, 'confirmed');
    const slot = await this.connection.getSlot();
    logger.info({ slot, rpc: this.rpcPrimary }, 'raydium client initialized');
  }

  async getPoolState(): Promise<PoolState> {
    throw new Error('getPoolState: wire to Raydium SDK in Task 13');
  }
  async getPosition(_nftMint: string): Promise<PositionSnapshot | null> {
    throw new Error('getPosition: wire to Raydium SDK in Task 13');
  }
  async buildOpenPositionTx(
    _params: OpenPositionParams,
  ): Promise<{ tx: Transaction; nftMint: string }> {
    throw new Error('buildOpenPositionTx: wire to Raydium SDK in Task 13');
  }
  async buildClosePositionTx(
    _nftMint: string,
  ): Promise<{ tx: Transaction; expectedBertOut: bigint; expectedSolOut: bigint }> {
    throw new Error('buildClosePositionTx: wire to Raydium SDK in Task 13');
  }
  async buildSwapToRatioTx(_params: {
    haveBertRaw: bigint;
    haveSolLamports: bigint;
    targetBertRatio: number;
  }): Promise<Transaction> {
    throw new Error('buildSwapToRatioTx: wire to Raydium SDK in Task 13');
  }
  async simulateClose(
    _nftMint: string,
  ): Promise<{ effectivePriceUsd: number; bertOut: bigint; solOut: bigint }> {
    throw new Error('simulateClose: wire to Raydium SDK in Task 13');
  }
}
