# Meteora DLMM Integration Design

**Date:** 2026-04-16 | **Status:** Approved

## Goal

Add Meteora DLMM support alongside existing Raydium CLMM, switchable via config (`venue: "raydium" | "meteora"`). Then create a BERT/SOL DLMM pool at 0.10% base fee and migrate the canary.

## Architecture

### Approach: Interface Adapter

The codebase already has a clean `RaydiumClient` interface (46-70 in raydiumClient.ts) that the rebalancer, main loop, and CLI commands consume. We:

1. Rename `RaydiumClient` → `VenueClient` (generic interface)
2. Keep `RaydiumClientImpl` unchanged (implements `VenueClient`)
3. Add `MeteoraClientImpl` (implements `VenueClient`)
4. Factory function selects implementation based on `config.venue`

No changes needed to `rebalancer.ts`, `strategy.ts`, `main.ts` logic, or CLI commands — they all talk to the `VenueClient` interface.

### VenueClient Interface (unchanged from current RaydiumClient)

```typescript
export interface VenueClient {
  init(): Promise<void>;
  getConnection(): Connection;
  getPoolState(): Promise<PoolState>;
  getPosition(nftMint: string, solUsd: number): Promise<PositionSnapshot | null>;
  buildOpenPositionTx(params: OpenPositionParams): Promise<{ tx: Transaction; nftMint: string; signers: Signer[] }>;
  buildClosePositionTx(nftMint: string): Promise<{ tx: Transaction; expectedBertOut: bigint; expectedSolOut: bigint }>;
  buildSwapToRatioTx(params: { haveBertRaw: bigint; haveSolLamports: bigint; targetBertRatio: number }): Promise<Transaction>;
  getWalletBalances(): Promise<{ solLamports: bigint; bertRaw: bigint }>;
  simulateClose(nftMint: string, solUsd: number): Promise<{ effectivePriceUsd: number; bertOut: bigint; solOut: bigint }>;
}
```

### Config Changes

```yaml
# New field
venue: "meteora"  # or "raydium" (default for backwards compat)

# Existing poolAddress field reused — points to Meteora DLMM pool address
poolAddress: "<new-meteora-dlmm-pool-address>"
```

No new config fields needed. The DLMM pool's bin_step and base_fee are immutable on-chain — the client reads them from the pool account, not config.

## MeteoraClientImpl

### Dependencies
- `@meteora-ag/dlmm` — official Meteora DLMM TypeScript SDK
- Reuses existing `@solana/web3.js`, `@solana/spl-token`

### Method Mapping

| VenueClient Method | Meteora SDK Call | Notes |
|---|---|---|
| `init()` | `DLMM.create(connection, poolAddress)` | Loads pool state, bin arrays |
| `getConnection()` | Return stored connection | Same as Raydium |
| `getPoolState()` | `dlmmPool.refetchStates()` then read `activeBin`, `feeInfo` | Map to existing `PoolState` type |
| `getPosition(nftMint)` | `dlmmPool.getPositionsByUserAndLbPair(wallet)` | DLMM uses wallet-based lookup, not NFT mint. NFT mint maps to position pubkey. Return first matching position |
| `buildOpenPositionTx()` | `dlmmPool.initializePositionAndAddLiquidityByStrategy()` | Uses "Spot" strategy (uniform distribution). Converts USD range to bin IDs |
| `buildClosePositionTx()` | `dlmmPool.removeLiquidity()` with 100% of all bins, then `dlmmPool.closePosition()` | Two-step: remove liq + close account. Combine into single tx if possible |
| `buildSwapToRatioTx()` | `dlmmPool.swap()` | DLMM has native swap. Compute direction + amount to reach target ratio |
| `getWalletBalances()` | `getTokenAccountBalance()` + `getBalance()` | Same as Raydium — pure SPL/SOL reads |
| `simulateClose()` | `dlmmPool.getPositionsByUserAndLbPair()` → read amounts per bin, sum | Compute effective USD from bin positions |

### Key Differences from Raydium

1. **Position identification**: DLMM positions are identified by a position pubkey derived from (wallet, pool, lower_bin_id, width). Not an NFT mint. We store the position pubkey in stateStore but still use the `nftMint` field name for backwards compat.

2. **Range as bins, not ticks**: `lowerUsd`/`upperUsd` from the rebalancer are converted to bin IDs using:
   ```
   bin_id = floor(log(price_in_base_token) / log(1 + bin_step/10000))
   ```

3. **No swap-to-ratio needed for single-sided deposits**: DLMM can accept single-sided deposits into out-of-range bins. However, for in-range bins we still need roughly 50/50, so we keep the swap step for now and optimize later.

4. **Fee collection**: Fees are claimed via `dlmmPool.claimAllRewards()` during position close. Same effective behavior as Raydium (fees collected on rebalance).

## Pool Creation Script

One-time script `scripts/create-meteora-pool.ts`:

1. Connect to Solana mainnet via Helius RPC
2. Create DLMM pool with:
   - Token pair: BERT / SOL
   - bin_step: 20
   - base_factor: 5000 (→ 0.10% base fee)
   - Activation type: instant
3. Output the pool address
4. No initial liquidity (bot handles that on startup)

Cost: ~0.25 SOL in rent.

## File Changes

| File | Change | Scope |
|---|---|---|
| `src/venueClient.ts` | **NEW** — Extract interface + factory function + types | Small |
| `src/meteoraClient.ts` | **NEW** — `MeteoraClientImpl` | Large (core new code) |
| `src/raydiumClient.ts` | Rename `RaydiumClient` → re-export as `VenueClient`, keep impl | Small rename |
| `src/main.ts` | Import factory instead of `RaydiumClientImpl` directly | 3-line change |
| `src/config.ts` | Add `venue` field to schema (default "raydium") | 2-line change |
| `src/types.ts` | Add `venue` to `BotConfig` | 1 line |
| `src/rebalancer.ts` | Change type import from `RaydiumClient` to `VenueClient` | 1-line rename |
| `src/priceFetchers.ts` | Change type import | 1-line rename |
| `src/cli/*.ts` | Change type imports | Renames only |
| `scripts/create-meteora-pool.ts` | **NEW** — Pool creation script | Medium |
| `tests/meteoraClient.test.ts` | **NEW** — Unit tests for MeteoraClientImpl | Medium |
| `package.json` | Add `@meteora-ag/dlmm` dependency | 1 line |

## Testing Strategy

1. Unit tests for `MeteoraClientImpl` with mocked DLMM SDK (same pattern as existing raydiumClient tests)
2. Existing rebalancer tests should pass unchanged (they mock the client interface)
3. Integration test: create pool on devnet, open/close position
4. Canary: deploy with `venue: "meteora"`, maxPositionUsd: 200

## Migration Steps

1. Install `@meteora-ag/dlmm`
2. Build `meteoraClient.ts` + `venueClient.ts`
3. Run pool creation script
4. Emergency-exit current Raydium position
5. Update config: `venue: "meteora"`, `poolAddress: <new>`
6. Restart service

## Risks

- **DLMM SDK maturity**: Less battle-tested than Raydium SDK. Mitigated by keeping Raydium as fallback.
- **Bin array rent**: DLMM positions require bin array accounts (~0.25 SOL). Accounted for in SOL floor.
- **Position lookup**: DLMM doesn't use NFT mints. We adapt the stateStore to store position pubkeys in the same field.
