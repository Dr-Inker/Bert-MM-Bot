import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Transaction, PublicKey, Keypair } from '@solana/web3.js';
import BN from 'bn.js';
import Decimal from 'decimal.js';
import { createRequire } from 'node:module';
import Module from 'node:module';
import type { PositionSnapshot } from '../src/types.js';

// ─── Mock constants ─────────────────────────────────────────────────────────

const POOL_ADDRESS = '11111111111111111111111111111111';
const BERT_MINT = 'HgBRWfYxEfvPhtqkaeymCQtHCrKE46qQ43pKe8HCpump';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const FAKE_POSITION_PK = new PublicKey('11111111111111111111111111111112');
const SOL_USD = 150;
const BERT_USD = 0.01; // $0.01 per BERT

// binStep = 20 (matching our target pool config)
const BIN_STEP = 20;

// BERT is tokenX, SOL is tokenY. Price = SOL per BERT = 0.01/150 ≈ 0.0000667
const PRICE_SOL_PER_BERT = BERT_USD / SOL_USD; // ~0.0000667

// ─── Mock: @meteora-ag/dlmm ────────────────────────────────────────────────

function makeMockLbPair() {
  return {
    activeId: -4800,
    binStep: BIN_STEP,
    tokenXMint: new PublicKey(BERT_MINT),
    tokenYMint: new PublicKey(SOL_MINT),
    reserveX: new BN('500000000000'),
    reserveY: new BN('5000000000'),
  };
}

function makeMockPosition() {
  return {
    publicKey: FAKE_POSITION_PK,
    positionData: {
      lowerBinId: -4850,
      upperBinId: -4750,
      totalXAmount: new BN('100000000'),   // 100 BERT (6 dec)
      totalYAmount: new BN('1000000000'),  // 1 SOL (9 dec)
      feeX: new BN('500000'),              // 0.5 BERT in fees
      feeY: new BN('5000000'),             // 0.005 SOL in fees
      rewardOne: new BN('0'),
      rewardTwo: new BN('0'),
      lastUpdatedAt: new BN(Math.floor(Date.now() / 1000)),
      positionBinData: [],
    },
  };
}

const mockDlmmInstance = {
  refetchStates: vi.fn(),
  getActiveBin: vi.fn(),
  getFeeInfo: vi.fn(),
  getBinIdFromPrice: vi.fn(),
  getBinArrayForSwap: vi.fn(),
  swapQuote: vi.fn(),
  getPositionsByUserAndLbPair: vi.fn(),
  initializePositionAndAddLiquidityByStrategy: vi.fn(),
  removeLiquidity: vi.fn(),
  swap: vi.fn(),
  pubkey: new PublicKey(POOL_ADDRESS),
  tokenX: {
    publicKey: new PublicKey(BERT_MINT),
    reserve: new PublicKey('11111111111111111111111111111111'),
    mint: { decimals: 6 },
    amount: BigInt(0),
    owner: new PublicKey('11111111111111111111111111111111'),
    transferHookAccountMetas: [],
  },
  tokenY: {
    publicKey: new PublicKey(SOL_MINT),
    reserve: new PublicKey('11111111111111111111111111111111'),
    mint: { decimals: 9 },
    amount: BigInt(0),
    owner: new PublicKey('11111111111111111111111111111111'),
    transferHookAccountMetas: [],
  },
  lbPair: makeMockLbPair(),
};

const mockDLMM = {
  create: vi.fn().mockResolvedValue(mockDlmmInstance),
};

// Mock getPriceOfBinByBinId as a named export
const mockGetPriceOfBinByBinId = vi.fn().mockImplementation(
  (binId: number, binStep: number) => new Decimal(Math.pow(1 + binStep / 10_000, binId)),
);

// Preseed Node's CJS require cache so that `createRequire(import.meta.url)`
// inside `src/meteoraClient.ts` returns our mock instead of the real package.
// This is required because vi.mock only intercepts ESM imports and the source
// deliberately uses createRequire to work around @meteora-ag/dlmm's broken ESM
// entry. Without this, `DLMM.create` runs against the real SDK and blows up on
// `connection.getMultipleAccountsInfo is not a function` during `init()`.
const __meteoraMockExports = {
  default: mockDLMM,
  DLMM: mockDLMM,
  StrategyType: { Spot: 0, Curve: 1, BidAsk: 2 },
  getPriceOfBinByBinId: mockGetPriceOfBinByBinId,
};
{
  const req = createRequire(import.meta.url);
  const resolved = req.resolve('@meteora-ag/dlmm');
  const m = new Module(resolved);
  m.filename = resolved;
  m.loaded = true;
  m.exports = __meteoraMockExports;
  req.cache[resolved] = m;
}

// Also keep the ESM vi.mock in case any future refactor uses `await import(...)`.
vi.mock('@meteora-ag/dlmm', () => __meteoraMockExports);

// ─── Mock: @solana/web3.js (partial — keep real Transaction/PublicKey) ──────

const mockGetBalance = vi.fn();
const mockGetTokenAccountBalance = vi.fn();

vi.mock('@solana/web3.js', async () => {
  const actual = await vi.importActual<typeof import('@solana/web3.js')>('@solana/web3.js');
  return {
    ...actual,
    Connection: vi.fn().mockImplementation(() => ({
      getBalance: mockGetBalance,
      getTokenAccountBalance: mockGetTokenAccountBalance,
      getSlot: vi.fn().mockResolvedValue(123456),
      commitment: 'confirmed',
    })),
  };
});

// ─── Mock: @solana/spl-token ────────────────────────────────────────────────

vi.mock('@solana/spl-token', () => ({
  getAssociatedTokenAddressSync: vi.fn().mockReturnValue(
    new PublicKey('11111111111111111111111111111113'),
  ),
  TOKEN_PROGRAM_ID: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
}));

// ─── Mock payer keypair ─────────────────────────────────────────────────────

const mockPayer = {
  publicKey: new PublicKey('11111111111111111111111111111114'),
  secretKey: new Uint8Array(64),
};

// ─── Import the module under test (after mocks are set up) ──────────────────

let MeteoraClientImpl: any;

beforeEach(async () => {
  vi.clearAllMocks();

  const lbPair = makeMockLbPair();
  mockDlmmInstance.lbPair = lbPair;

  mockDlmmInstance.refetchStates.mockResolvedValue(undefined);
  mockDlmmInstance.getActiveBin.mockResolvedValue({
    binId: lbPair.activeId,
    price: String(PRICE_SOL_PER_BERT),
    xAmount: new BN('500000000000'),
    yAmount: new BN('5000000000'),
  });
  mockDlmmInstance.getFeeInfo.mockReturnValue({
    baseFeeRatePercentage: { toNumber: () => 0.1 },
    maxFeeRatePercentage: { toNumber: () => 5.0 },
    protocolFeePercentage: { toNumber: () => 5.0 },
  });
  mockDlmmInstance.getBinIdFromPrice.mockImplementation((price: number, _min: boolean) => {
    return Math.round(Math.log(price) / Math.log(1 + BIN_STEP / 10_000));
  });
  mockDlmmInstance.getBinArrayForSwap.mockResolvedValue([]);
  mockDlmmInstance.swapQuote.mockReturnValue({
    consumedInAmount: new BN('1000000'),
    outAmount: new BN('1000000000'),
    fee: new BN('1000'),
    protocolFee: new BN('50'),
    minOutAmount: new BN('990000000'),
    priceImpact: { toNumber: () => 0.001 },
    binArraysPubkey: [],
  });
  mockDlmmInstance.getPositionsByUserAndLbPair.mockResolvedValue({
    userPositions: [makeMockPosition()],
  });
  // SDK returns Transaction directly from initializePositionAndAddLiquidityByStrategy
  mockDlmmInstance.initializePositionAndAddLiquidityByStrategy.mockResolvedValue(
    new Transaction(),
  );
  // SDK returns Transaction[] from removeLiquidity
  mockDlmmInstance.removeLiquidity.mockResolvedValue([new Transaction()]);
  mockDlmmInstance.swap.mockResolvedValue(new Transaction());

  mockGetBalance.mockResolvedValue(5_000_000_000); // 5 SOL
  mockGetTokenAccountBalance.mockResolvedValue({
    value: { amount: '100000000000', decimals: 6, uiAmount: 100000 },
  });

  const mod = await import('../src/meteoraClient.js');
  MeteoraClientImpl = mod.MeteoraClientImpl;
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('MeteoraClientImpl', () => {
  function createClient() {
    return new MeteoraClientImpl(
      'https://rpc.example.com/primary',
      'https://rpc.example.com/fallback',
      POOL_ADDRESS,
      BERT_MINT,
      mockPayer,
    );
  }

  describe('1. init()', () => {
    it('creates DLMM instance and detects BERT as tokenX', async () => {
      const client = createClient();
      await client.init();

      expect(mockDLMM.create).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(PublicKey),
      );
      expect(client.getConnection()).toBeDefined();
    });
  });

  describe('2. getPoolState()', () => {
    it('returns PoolState with correct feeTier and binId', async () => {
      const client = createClient();
      await client.init();

      const state = await client.getPoolState();

      expect(state.address).toBe(POOL_ADDRESS);
      expect(state.feeTier).toBeCloseTo(0.001, 5); // 0.1% / 100 = 0.001
      expect(state.currentTickIndex).toBe(-4800);
      expect(state.sqrtPriceX64).toBe(0n); // Not applicable for DLMM
      expect(mockDlmmInstance.refetchStates).toHaveBeenCalled();
    });
  });

  describe('3. getPosition() with valid position', () => {
    it('returns PositionSnapshot with correct amounts and fees', async () => {
      const client = createClient();
      await client.init();

      const nftMint = FAKE_POSITION_PK.toBase58();
      const snap = await client.getPosition(nftMint, SOL_USD);

      expect(snap).not.toBeNull();
      const pos = snap as PositionSnapshot;

      expect(pos.nftMint).toBe(nftMint);

      // BERT is tokenX, so bertAmount = totalXAmount, solAmount = totalYAmount
      expect(pos.bertAmount).toBe(100_000_000n);
      expect(pos.solAmount).toBe(1_000_000_000n);

      // Fees: feeX → BERT fees, feeY → SOL fees
      expect(pos.uncollectedFeesBert).toBe(500_000n);
      expect(pos.uncollectedFeesSol).toBe(5_000_000n);

      // Range should have valid bounds
      expect(pos.range.lowerBertUsd).toBeLessThan(pos.range.upperBertUsd);
      expect(pos.range.widthPct).toBeGreaterThan(0);
      expect(pos.totalValueUsd).toBeGreaterThan(0);
    });
  });

  describe('4. getPosition() with no position', () => {
    it('returns null when position pubkey not found', async () => {
      const client = createClient();
      await client.init();

      // Return empty positions array
      mockDlmmInstance.getPositionsByUserAndLbPair.mockResolvedValue({
        userPositions: [],
      });

      // Use a valid base58 pubkey that doesn't match any position
      const snap = await client.getPosition('11111111111111111111111111111115', SOL_USD);
      expect(snap).toBeNull();
    });
  });

  describe('5. buildOpenPositionTx()', () => {
    it('builds transaction with Spot strategy and returns position pubkey', async () => {
      const client = createClient();
      await client.init();

      const result = await client.buildOpenPositionTx({
        lowerUsd: BERT_USD * 0.9,
        upperUsd: BERT_USD * 1.1,
        bertAmountRaw: 100_000_000n,
        solAmountLamports: 1_000_000_000n,
        solUsd: SOL_USD,
      });

      // Returns a Transaction (SDK returns Transaction directly)
      expect(result.tx).toBeInstanceOf(Transaction);
      // nftMint is the generated position keypair pubkey (not predictable, just check it's a string)
      expect(result.nftMint).toBeTypeOf('string');
      expect(result.nftMint.length).toBeGreaterThan(30);
      // signers contains the position keypair
      expect(result.signers.length).toBe(1);

      // Verify SDK was called with StrategyType.Spot
      expect(mockDlmmInstance.initializePositionAndAddLiquidityByStrategy).toHaveBeenCalledWith(
        expect.objectContaining({
          strategy: expect.objectContaining({
            strategyType: 0, // Spot
          }),
        }),
      );
    });
  });

  describe('6. buildClosePositionTx()', () => {
    it('builds close transaction with expected outputs including fees', async () => {
      const client = createClient();
      await client.init();

      const nftMint = FAKE_POSITION_PK.toBase58();
      const result = await client.buildClosePositionTx(nftMint);

      expect(result.tx).toBeInstanceOf(Transaction);

      // Expected outputs = position amounts + fees
      // BERT (X): 100_000_000 + 500_000 = 100_500_000
      expect(result.expectedBertOut).toBe(100_500_000n);
      // SOL (Y): 1_000_000_000 + 5_000_000 = 1_005_000_000
      expect(result.expectedSolOut).toBe(1_005_000_000n);

      expect(mockDlmmInstance.removeLiquidity).toHaveBeenCalledWith(
        expect.objectContaining({
          bps: expect.any(BN),
          shouldClaimAndClose: true,
        }),
      );
    });
  });

  describe('7. buildSwapToRatioTx() — swap needed', () => {
    it('swaps when BERT/SOL ratio is far from target', async () => {
      const client = createClient();
      await client.init();

      // Have lots of SOL, little BERT → should swap SOL → BERT
      const result = await client.buildSwapToRatioTx({
        haveBertRaw: 1_000_000n,           // 1 BERT = ~$0.01
        haveSolLamports: 10_000_000_000n,  // 10 SOL = $1500
        targetBertRatio: 0.5,
      });

      expect(result).toBeInstanceOf(Transaction);
      expect(mockDlmmInstance.swap).toHaveBeenCalled();
    });
  });

  describe('8. buildSwapToRatioTx() — no swap needed', () => {
    it('returns empty transaction when delta < 1 BERT', async () => {
      const client = createClient();
      await client.init();

      // bertPerSol (for bertIsX) = 1/priceYPerX = 1/0.0000667 ≈ 15000
      // bertHuman = 7_500_000_000_000 / 1e6 = 7_500_000 BERT
      // solHuman = 5_000_000_000 / 1e9 = 5 SOL
      // totalInBert = 7_500_000 + 5 * 15000 = 7_500_000 + 75_000 = 7_575_000
      // targetBert = 7_575_000 * 0.5 = 3_787_500
      // deltaBert = 3_787_500 - 7_500_000 = -3_712_500 → NOT small
      // We need deltaBert < 1 BERT. That means bertHuman ≈ totalInBert * 0.5
      // Set values so they're already balanced
      const bertPerSol = 1 / PRICE_SOL_PER_BERT; // ~15000
      const solHuman = 5; // 5 SOL
      const solValueInBert = solHuman * bertPerSol;
      const bertHuman = solValueInBert; // perfectly balanced
      const haveBertRaw = BigInt(Math.round(bertHuman * 1e6));
      const haveSolLamports = BigInt(Math.round(solHuman * 1e9));

      const result = await client.buildSwapToRatioTx({
        haveBertRaw,
        haveSolLamports,
        targetBertRatio: 0.5,
      });

      expect(result).toBeInstanceOf(Transaction);
      expect(mockDlmmInstance.swap).not.toHaveBeenCalled();
    });
  });

  describe('9. getWalletBalances()', () => {
    it('returns SOL and BERT balances as bigint', async () => {
      const client = createClient();
      await client.init();

      const balances = await client.getWalletBalances();

      expect(balances.solLamports).toBe(5_000_000_000n);
      expect(balances.bertRaw).toBe(100_000_000_000n);
      expect(mockGetBalance).toHaveBeenCalledWith(mockPayer.publicKey);
    });
  });

  describe('10. simulateClose()', () => {
    it('computes effective USD value from position data without executing', async () => {
      const client = createClient();
      await client.init();

      const nftMint = FAKE_POSITION_PK.toBase58();
      const result = await client.simulateClose(nftMint, SOL_USD);

      // bertOut = totalXAmount + feeX = 100_000_000 + 500_000 = 100_500_000
      expect(result.bertOut).toBe(100_500_000n);
      // solOut = totalYAmount + feeY = 1_000_000_000 + 5_000_000 = 1_005_000_000
      expect(result.solOut).toBe(1_005_000_000n);

      expect(result.effectivePriceUsd).toBeGreaterThan(0);

      // simulateClose should NOT call removeLiquidity
      expect(mockDlmmInstance.removeLiquidity).not.toHaveBeenCalled();
    });
  });
});
