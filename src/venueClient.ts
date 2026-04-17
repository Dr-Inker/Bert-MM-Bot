/**
 * VenueClient — generic interface for DEX pool interactions.
 *
 * Implementations: RaydiumClientImpl (CLMM), MeteoraClientImpl (DLMM).
 * Selected at startup via config.venue.
 */

import type { Connection, Keypair, Signer, Transaction } from '@solana/web3.js';
import type { PositionSnapshot } from './types.js';

export interface OpenPositionParams {
  lowerUsd: number;
  upperUsd: number;
  bertAmountRaw: bigint;
  solAmountLamports: bigint;
  /** Trusted oracle SOL/USD price — required for tick/bin conversion. */
  solUsd: number;
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

export interface VenueClient {
  init(): Promise<void>;
  getConnection(): Connection;
  getPoolState(): Promise<PoolState>;
  /**
   * Fetch the on-chain position identified by `positionId`.
   * For Raydium this is an NFT mint; for Meteora this is a position pubkey.
   * `solUsd` is required to convert price bounds to USD values.
   */
  getPosition(positionId: string, solUsd: number): Promise<PositionSnapshot | null>;
  buildOpenPositionTx(params: OpenPositionParams): Promise<{
    tx: Transaction;
    /** For Raydium: NFT mint pubkey. For Meteora: position keypair pubkey. */
    nftMint: string;
    signers: Signer[];
  }>;
  buildClosePositionTx(
    positionId: string,
  ): Promise<{ tx: Transaction; expectedBertOut: bigint; expectedSolOut: bigint }>;
  /**
   * Remove liquidity from an existing position to free up target amounts of
   * SOL and/or BERT. Implementation chooses which bins to remove from:
   * - To free SOL: remove bins below active (they hold quote = SOL when BERT is base).
   * - To free BERT: remove bins above active.
   * Returns the tx signature. After confirmation, free balances will have
   * increased by approximately the requested amounts.
   */
  buildPartialCloseTx(args: {
    positionId: string;
    needSolLamports: bigint;
    needBertRaw: bigint;
  }): Promise<Transaction>;
  buildSwapToRatioTx(params: {
    haveBertRaw: bigint;
    haveSolLamports: bigint;
    targetBertRatio: number;
  }): Promise<Transaction>;
  getWalletBalances(): Promise<{ solLamports: bigint; bertRaw: bigint }>;
  simulateClose(
    positionId: string,
    solUsd: number,
  ): Promise<{ effectivePriceUsd: number; bertOut: bigint; solOut: bigint }>;
}

export type Venue = 'raydium' | 'meteora';

/**
 * Create the appropriate VenueClient based on config.
 */
export async function createVenueClient(
  venue: Venue,
  rpcPrimary: string,
  rpcFallback: string,
  poolAddress: string,
  bertMint: string,
  payer: Keypair,
): Promise<VenueClient> {
  if (venue === 'meteora') {
    const { MeteoraClientImpl } = await import('./meteoraClient.js');
    return new MeteoraClientImpl(rpcPrimary, rpcFallback, poolAddress, bertMint, payer);
  }
  const { RaydiumClientImpl } = await import('./raydiumClient.js');
  return new RaydiumClientImpl(rpcPrimary, rpcFallback, poolAddress, bertMint, payer);
}
