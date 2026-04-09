import { Connection } from '@solana/web3.js';
import { Raydium } from '@raydium-io/raydium-sdk-v2';

const RPC = process.env.BERT_MM_RPC ?? 'https://api.mainnet-beta.solana.com';
const POOL_ID = process.argv[2] ?? '9LkdXDXQkWC8RgqMTn2eAnzgFTNjKjJiSq4smpdKLuaH';

async function main() {
  const connection = new Connection(RPC, 'confirmed');
  const raydium = await Raydium.load({ connection, cluster: 'mainnet', disableLoadToken: true });

  const { poolInfo, poolKeys, computePoolInfo } = await raydium.clmm.getPoolInfoFromRpc(POOL_ID);

  console.log(
    JSON.stringify(
      {
        poolId: POOL_ID,
        mintA: {
          address: poolInfo.mintA.address,
          symbol: poolInfo.mintA.symbol,
          decimals: poolInfo.mintA.decimals,
        },
        mintB: {
          address: poolInfo.mintB.address,
          symbol: poolInfo.mintB.symbol,
          decimals: poolInfo.mintB.decimals,
        },
        feeRate: poolInfo.feeRate,
        tickSpacing: (poolInfo.config as { tickSpacing: number }).tickSpacing,
        currentPrice: poolInfo.price,
        tvlUsd: poolInfo.tvl,
        computePoolInfo: {
          tickCurrent: computePoolInfo.tickCurrent,
          sqrtPriceX64: computePoolInfo.sqrtPriceX64.toString(),
          currentPrice: computePoolInfo.currentPrice.toString(),
        },
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
