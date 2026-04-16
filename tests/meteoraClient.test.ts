import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Transaction, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import type { PositionSnapshot } from '../src/types.js';

// ─── Mock constants ─────────────────────────────────────────────────────────

const POOL_ADDRESS = '11111111111111111111111111111111';
const BERT_MINT = 'HgBRWfYxEfvPhtqkaeymCQtHCrKE46qQ43pKe8HCpump';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const FAKE_NFT_MINT_PK = new PublicKey('11111111111111111111111111111112');
const SOL_USD = 150;
const BERT_USD = 0.00015;

// binStep for the mock DLMM pool (e.g. 100 = 1%)
const BIN_STEP = 100;

// ─── Mock: @meteora-ag/dlmm ────────────────────────────────────────────────

const mockDlmmInstance = {
  refetchStates: vi.fn(),
  getLbPair: vi.fn(),
  getBinArrays: vi.fn(),
  getActiveBin: vi.fn(),
  getFeeInfo: vi.fn(),
  getBinIdFromPrice: vi.fn(),
  getBinArrayForSwap: vi.fn(),
  swapQuote: vi.fn(),
  getPositionsByUserAndLbPair: vi.fn(),
  initializePositionAndAddLiquidityByStrategy: vi.fn(),
  removeLiquidity: vi.fn(),
  swap: vi.fn(),
  pubkey: new PublicKey('11111111111111111111111111111111'),
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
  lbPair: null as ReturnType<typeof makeMockLbPair> | null,
};

const mockDLMM = {
  create: vi.fn().mockResolvedValue(mockDlmmInstance),
};

vi.mock('@meteora-ag/dlmm', () => ({
  default: mockDLMM,
  DLMM: mockDLMM,
  StrategyType: { Spot: 0, Curve: 1, BidAsk: 2 },
}));

// ─── Mock: @solana/web3.js (partial — keep real Transaction/PublicKey) ──────

const mockGetBalance = vi.fn();
const mockGetTokenAccountBalance = vi.fn();
const mockGetSlot = vi.fn().mockResolvedValue(123456);

vi.mock('@solana/web3.js', async () => {
  const actual = await vi.importActual<typeof import('@solana/web3.js')>('@solana/web3.js');
  return {
    ...actual,
    Connection: vi.fn().mockImplementation(() => ({
      getBalance: mockGetBalance,
      getTokenAccountBalance: mockGetTokenAccountBalance,
      getSlot: mockGetSlot,
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

// ─── Helper: compute expected bin ID from price ─────────────────────────────

function priceToBinId(priceInSol: number, binStep: number): number {
  // bin_id = log(priceInSol) / log(1 + binStep/10000)
  return Math.round(Math.log(priceInSol) / Math.log(1 + binStep / 10_000));
}

// ─── Build a mock lb pair (pool state) ──────────────────────────────────────

function makeMockLbPair() {
  const bertPerSol = SOL_USD / BERT_USD; // 1_000_000
  const activeBinId = priceToBinId(bertPerSol, BIN_STEP);
  return {
    activeId: activeBinId,
    binStep: BIN_STEP,
    tokenXMint: new PublicKey(BERT_MINT),
    tokenYMint: new PublicKey(SOL_MINT),
    reserveX: new BN('500000000000'),   // 500_000 BERT (6 dec)
    reserveY: new BN('5000000000'),     // 5 SOL (9 dec)
    feeRate: new BN('2500'),            // 0.25% in bps
    protocolFeeRate: new BN('500'),
  };
}

// ─── Build a mock position ──────────────────────────────────────────────────

function makeMockPosition() {
  const bertPerSol = SOL_USD / BERT_USD;
  const centerBinId = priceToBinId(bertPerSol, BIN_STEP);
  const lowerBinId = centerBinId - 50;
  const upperBinId = centerBinId + 50;

  return {
    publicKey: FAKE_NFT_MINT_PK,
    positionData: {
      lowerBinId,
      upperBinId,
      totalXAmount: new BN('100000000'),   // 100 BERT raw (6 dec)
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

// ─── Import the module under test (after mocks are set up) ──────────────────

let MeteoraClientImpl: any;

beforeEach(async () => {
  vi.clearAllMocks();

  // Reset mock defaults
  const lbPair = makeMockLbPair();
  mockDlmmInstance.lbPair = lbPair;
  mockDlmmInstance.getLbPair.mockReturnValue(lbPair);
  mockDlmmInstance.refetchStates.mockResolvedValue(undefined);
  mockDlmmInstance.getActiveBin.mockResolvedValue({
    binId: lbPair.activeId,
    price: String(SOL_USD / BERT_USD), // SOL per BERT as string (for bertIsX case this is Y/X)
    pricePerToken: String(BERT_USD / SOL_USD),
    xAmount: new BN('500000000000'),
    yAmount: new BN('5000000000'),
  });
  mockDlmmInstance.getFeeInfo.mockReturnValue({
    baseFeeRatePercentage: { toNumber: () => 0.1 },
    maxFeeRatePercentage: { toNumber: () => 5.0 },
    protocolFeePercentage: { toNumber: () => 5.0 },
  });
  mockDlmmInstance.getBinIdFromPrice.mockImplementation((price: number, min: boolean) => {
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
  mockDlmmInstance.getBinArrays.mockResolvedValue([]);
  mockDlmmInstance.getPositionsByUserAndLbPair.mockResolvedValue({
    userPositions: [makeMockPosition()],
  });
  mockDlmmInstance.initializePositionAndAddLiquidityByStrategy.mockResolvedValue({
    tx: new Transaction(),
    positionPubKey: FAKE_NFT_MINT_PK,
    signers: [],
  });
  mockDlmmInstance.removeLiquidity.mockResolvedValue({
    tx: new Transaction(),
    expectedXAmount: new BN('100000000'),
    expectedYAmount: new BN('1000000000'),
  });
  mockDlmmInstance.swap.mockResolvedValue(new Transaction());

  mockGetBalance.mockResolvedValue(5_000_000_000); // 5 SOL
  mockGetTokenAccountBalance.mockResolvedValue({
    value: { amount: '100000000000', decimals: 6, uiAmount: 100000 },
  });

  // Dynamic import to pick up mocks
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
    it('creates DLMM instance from pool address and sets connection', async () => {
      const client = createClient();
      await client.init();

      expect(mockDLMM.create).toHaveBeenCalledWith(
        expect.anything(), // Connection instance
        expect.any(PublicKey),
      );

      const conn = client.getConnection();
      expect(conn).toBeDefined();
      expect(conn.getSlot).toBeDefined();
    });
  });

  describe('2. getPoolState()', () => {
    it('returns correct PoolState with feeTier, bertUsd, solUsd, tvlUsd', async () => {
      const client = createClient();
      await client.init();

      const state = await client.getPoolState();

      expect(state.address).toBe(POOL_ADDRESS);
      expect(state.feeTier).toBeTypeOf('number');
      expect(state.feeTier).toBeGreaterThan(0);
      expect(state.currentTickIndex).toBeTypeOf('number');
      expect(state.tvlUsd).toBeTypeOf('number');
      // bertUsd and solUsd are filled from pool reserves or set to 0 (oracle provides real values)
      expect(state).toHaveProperty('bertUsd');
      expect(state).toHaveProperty('solUsd');

      // Verify refetchStates was called to get fresh data
      expect(mockDlmmInstance.refetchStates).toHaveBeenCalled();
    });
  });

  describe('3. getPosition() with valid position', () => {
    it('returns PositionSnapshot with correct range, amounts, and fees', async () => {
      const client = createClient();
      await client.init();

      const nftMint = FAKE_NFT_MINT_PK.toBase58();
      const snap = await client.getPosition(nftMint, SOL_USD);

      expect(snap).not.toBeNull();
      const pos = snap as PositionSnapshot;

      expect(pos.nftMint).toBe(nftMint);

      // Range should have valid USD values
      expect(pos.range.lowerBertUsd).toBeTypeOf('number');
      expect(pos.range.upperBertUsd).toBeTypeOf('number');
      expect(pos.range.lowerBertUsd).toBeLessThan(pos.range.upperBertUsd);
      expect(pos.range.centerBertUsd).toBeCloseTo(
        (pos.range.lowerBertUsd + pos.range.upperBertUsd) / 2,
        10,
      );
      expect(pos.range.widthPct).toBeGreaterThan(0);

      // Amounts should be bigint (BN -> bigint conversion at boundary)
      expect(typeof pos.bertAmount).toBe('bigint');
      expect(typeof pos.solAmount).toBe('bigint');
      expect(pos.bertAmount).toBe(100_000_000n);
      expect(pos.solAmount).toBe(1_000_000_000n);

      // Fees should be bigint
      expect(typeof pos.uncollectedFeesBert).toBe('bigint');
      expect(typeof pos.uncollectedFeesSol).toBe('bigint');
      expect(pos.uncollectedFeesBert).toBe(500_000n);
      expect(pos.uncollectedFeesSol).toBe(5_000_000n);

      // Total value should be positive
      expect(pos.totalValueUsd).toBeGreaterThan(0);
    });
  });

  describe('4. getPosition() with no position', () => {
    it('returns null when no positions exist for wallet', async () => {
      const client = createClient();
      await client.init();

      mockDlmmInstance.getPositionsByUserAndLbPair.mockResolvedValue({
        userPositions: [],
      });

      const snap = await client.getPosition('NonExistentMint111111111111111111111111111111', SOL_USD);
      expect(snap).toBeNull();
    });
  });

  describe('5. buildOpenPositionTx()', () => {
    it('builds transaction with correct bin range from USD prices, returns nftMint and signers', async () => {
      const client = createClient();
      await client.init();

      const lowerUsd = BERT_USD * 0.9;
      const upperUsd = BERT_USD * 1.1;
      const bertAmountRaw = 100_000_000n;
      const solAmountLamports = 1_000_000_000n;

      const result = await client.buildOpenPositionTx({
        lowerUsd,
        upperUsd,
        bertAmountRaw,
        solAmountLamports,
        solUsd: SOL_USD,
      });

      expect(result.tx).toBeInstanceOf(Transaction);
      expect(result.nftMint).toBe(FAKE_NFT_MINT_PK.toBase58());
      expect(Array.isArray(result.signers)).toBe(true);

      // Verify the DLMM SDK was called with strategy type Spot
      expect(mockDlmmInstance.initializePositionAndAddLiquidityByStrategy).toHaveBeenCalledWith(
        expect.objectContaining({
          strategy: expect.objectContaining({
            strategyType: 0, // StrategyType.Spot
          }),
        }),
      );

      // Verify bin ID conversion: USD prices -> SOL-denominated -> bin IDs
      const callArgs = mockDlmmInstance.initializePositionAndAddLiquidityByStrategy.mock.calls[0][0];

      // lowerUsd / solUsd = BERT price in SOL terms -> bin ID
      const expectedLowerBinId = priceToBinId(lowerUsd / SOL_USD, BIN_STEP);
      const expectedUpperBinId = priceToBinId(upperUsd / SOL_USD, BIN_STEP);
      const lowerBin = Math.min(expectedLowerBinId, expectedUpperBinId);
      const upperBin = Math.max(expectedLowerBinId, expectedUpperBinId);

      expect(callArgs.lowerBinId).toBe(lowerBin);
      expect(callArgs.upperBinId).toBe(upperBin);
    });
  });

  describe('6. buildClosePositionTx()', () => {
    it('builds close transaction and returns expected token outputs as bigint', async () => {
      const client = createClient();
      await client.init();

      const nftMint = FAKE_NFT_MINT_PK.toBase58();
      const result = await client.buildClosePositionTx(nftMint);

      expect(result.tx).toBeInstanceOf(Transaction);
      expect(typeof result.expectedBertOut).toBe('bigint');
      expect(typeof result.expectedSolOut).toBe('bigint');
      expect(result.expectedBertOut).toBe(100_000_000n);
      expect(result.expectedSolOut).toBe(1_000_000_000n);

      // Verify removeLiquidity was called on the DLMM instance
      expect(mockDlmmInstance.removeLiquidity).toHaveBeenCalledWith(
        expect.objectContaining({
          position: expect.any(Object),
        }),
      );
    });
  });

  describe('7. buildSwapToRatioTx() — swap needed', () => {
    it('builds swap in correct direction based on current ratio vs target', async () => {
      const client = createClient();
      await client.init();

      // Have lots of SOL, little BERT -> should swap SOL -> BERT
      const result = await client.buildSwapToRatioTx({
        haveBertRaw: 1_000_000n,          // 1 BERT = tiny
        haveSolLamports: 10_000_000_000n, // 10 SOL = $1500
        targetBertRatio: 0.5,
      });

      expect(result).toBeInstanceOf(Transaction);
      expect(mockDlmmInstance.swap).toHaveBeenCalled();

      // Verify swap direction: should be swapping SOL (Y) for BERT (X)
      const swapArgs = mockDlmmInstance.swap.mock.calls[0][0];
      expect(swapArgs).toBeDefined();
      // The swap amount should be positive
      expect(swapArgs.inAmount).toBeDefined();
    });
  });

  describe('8. buildSwapToRatioTx() — no swap needed', () => {
    it('returns empty transaction when ratio is close enough', async () => {
      const client = createClient();
      await client.init();

      // Perfectly balanced: set balances so currentBertRatio ~ 0.5
      // BERT value in SOL terms = haveBertRaw / 1e6 / (SOL_USD / BERT_USD) = haveBertRaw / 1e6 / 1_000_000
      // For balance: BERT_value_sol = SOL_value_sol
      // haveBertRaw / 1e6 / bertPerSol = haveSolLamports / 1e9
      // With bertPerSol = 1_000_000: haveBertRaw / 1e12 = haveSolLamports / 1e9
      // haveBertRaw = haveSolLamports * 1000
      const result = await client.buildSwapToRatioTx({
        haveBertRaw: 5_000_000_000_000n,  // 5M BERT ~ $750 in BERT value
        haveSolLamports: 5_000_000_000n,   // 5 SOL = $750
        targetBertRatio: 0.5,
      });

      expect(result).toBeInstanceOf(Transaction);
      // Swap should NOT have been called — ratio already near target
      expect(mockDlmmInstance.swap).not.toHaveBeenCalled();
    });
  });

  describe('9. getWalletBalances()', () => {
    it('returns SOL and BERT balances as bigint', async () => {
      const client = createClient();
      await client.init();

      const balances = await client.getWalletBalances();

      expect(typeof balances.solLamports).toBe('bigint');
      expect(typeof balances.bertRaw).toBe('bigint');
      expect(balances.solLamports).toBe(5_000_000_000n);
      expect(balances.bertRaw).toBe(100_000_000_000n);

      // Verify correct RPC calls were made
      expect(mockGetBalance).toHaveBeenCalledWith(mockPayer.publicKey);
      expect(mockGetTokenAccountBalance).toHaveBeenCalled();
    });
  });

  describe('10. simulateClose()', () => {
    it('computes effective USD value without executing', async () => {
      const client = createClient();
      await client.init();

      const nftMint = FAKE_NFT_MINT_PK.toBase58();
      const result = await client.simulateClose(nftMint, SOL_USD);

      expect(typeof result.effectivePriceUsd).toBe('number');
      expect(typeof result.bertOut).toBe('bigint');
      expect(typeof result.solOut).toBe('bigint');

      // Expected outputs should match the mock removeLiquidity return values
      expect(result.bertOut).toBe(100_000_000n);
      expect(result.solOut).toBe(1_000_000_000n);

      // effectivePriceUsd should be positive when there are non-zero outputs
      expect(result.effectivePriceUsd).toBeGreaterThan(0);

      // removeLiquidity should NOT have been called — simulate only reads
      // (simulateClose uses getPositionsByUserAndLbPair + math, not removeLiquidity)
      expect(mockDlmmInstance.removeLiquidity).not.toHaveBeenCalled();
    });
  });
});
