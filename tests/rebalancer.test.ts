import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeRebalance, RebalancerDeps } from '../src/rebalancer.js';
import type { MidPrice, PositionSnapshot, BotConfig } from '../src/types.js';
import { Transaction } from '@solana/web3.js';

// ─── Shared test fixtures ──────────────────────────────────────────────────────

const MID: MidPrice = {
  bertPerSol: 10000,
  bertUsd: 0.00015,
  solUsd: 150,
  ts: Date.now(),
  sources: ['test'],
};

const POSITION: PositionSnapshot = {
  nftMint: 'OldNft111111111111111111111111111111111111111',
  range: { lowerBertUsd: 0.0001, upperBertUsd: 0.0002, centerBertUsd: 0.00015, widthPct: 20 },
  bertAmount: 1_000_000n,
  solAmount: 1_000_000_000n,
  uncollectedFeesBert: 0n,
  uncollectedFeesSol: 0n,
  totalValueUsd: 1000,
  openedAt: Date.now() - 3600_000,
};

const BASE_CFG: BotConfig = {
  enabled: true,
  poolAddress: '9LkdXDXQkWC8RgqMTn2eAnzgFTNjKjJiSq4smpdKLuaH',
  bertMint: 'HgBRWfYxEfvPhtqkaeymCQtHCrKE46qQ43pKe8HCpump',
  rangeWidthPct: 20,
  sustainedMinutes: 10,
  minRebalanceIntervalMin: 60,
  maxRebalancesPerDay: 6,
  maxSlippageBps: 100,
  maxDrawdownPct: 5,
  drawdownWindowMin: 30,
  maxPositionUsd: 2200,
  oracleDivergenceBps: 150,
  oracleStaleMinutes: 15,
  rpcOutageMinutes: 5,
  minSolBalance: 0.1,
  hardPauseSolBalance: 0.03,
  minSolFloorLamports: 100_000_000,
  priorityFeeMicroLamports: 10_000,
  pollIntervalSec: 30,
  feeCollectionMode: 'on_rebalance',
  feeHandling: 'compound',
  rpcPrimary: 'https://rpc.example.com/primary',
  rpcFallback: 'https://rpc.example.com/fallback',
  keyfilePath: '/etc/bert-mm-bot/hot-wallet.json',
  statePath: '/var/lib/bert-mm-bot/state.db',
  killSwitchFilePath: '/var/lib/bert-mm-bot/KILLSWITCH',
  heartbeatPath: '/var/lib/bert-mm-bot/heartbeat.txt',
  notifier: {
    discord: {
      webhookInfo: 'https://discord.com/api/webhooks/info',
      webhookCritical: 'https://discord.com/api/webhooks/critical',
    },
  },
  dryRun: false,
};

const FAKE_CLOSE_TX = new Transaction();
const FAKE_OPEN_TX = new Transaction();
const FAKE_NFT_MINT = 'NewNft2222222222222222222222222222222222222222';
const CLOSE_SIG = 'close-sig-abc';
const OPEN_SIG = 'open-sig-xyz';

// ─── Helper to build mock deps ─────────────────────────────────────────────────

function makeDeps(overrides: Partial<RebalancerDeps> = {}): RebalancerDeps {
  // Default balances: ~50/50 split (5 SOL @ $150 = $750 SOL, 100M BERT @ $0.00015 = $15 BERT)
  // After floor: usableSol = 5_000_000_000 - 100_000_000 = 4_900_000_000 lamports
  // usableSolUsd = 4.9 * 150 = $735, usableBertUsd = 100 * 0.00015 = $0.015
  // Ratio heavily SOL-biased — will trigger swap attempt (currentBertRatio ≈ 0.002 vs 0.5)
  // We use a near-50/50 balance to avoid triggering swap in most tests:
  // 5 SOL = $750, 5_000_000 BERT raw = 5 BERT = $0.00075 → still SOL-heavy
  // Use: solLamports=1_000_000_000 (1 SOL = $150), bertRaw=500_000_000 (500 BERT @ $0.00015 = $75)
  // After floor: usableSol=900_000_000 (0.9 SOL = $135), usableBertUsd=$75 → total=$210
  // currentBertRatio = 75/210 ≈ 0.357, targetBertRatio=0.5 → diff=0.143 > 0.01 → swap triggered
  // To avoid swap being called in non-swap tests: provide perfectly balanced wallet
  // 1 SOL - floor: usable=900_000_000 lamports = $135, bertRaw=900_000 raw = 0.9 BERT @ $0.00015=$0.000135 → not balanced
  // Easiest: provide exact 50/50 so swap isn't triggered:
  // usableSolUsd = usableBertUsd → (sol-floor)/1e9 * 150 = bert/1e6 * 0.00015
  // sol-floor = bert * (0.00015/150) * 1e9/1e6 = bert * 0.001
  // With bertRaw=100_000_000_000 (100000 BERT = $15), usableSolUsd=(sol-floor)/1e9*150=$15
  // sol-floor = 15/150 * 1e9 = 100_000_000 → sol = 200_000_000 lamports = 0.2 SOL
  // So: solLamports=300_000_000 (0.3 SOL), bertRaw=100_000_000_000 (100000 BERT)
  // After floor: usableSol=200_000_000 → $30 SOL, $15 BERT → not balanced either
  // Simplest for tests: use balanced enough that swap IS triggered but mock buildSwapToRatioTx
  // to return empty tx (no instructions) so submitter isn't called for swap.
  const raydium = {
    init: vi.fn(),
    getConnection: vi.fn(),
    getPoolState: vi.fn().mockResolvedValue({}),
    getPosition: vi.fn(),
    buildOpenPositionTx: vi.fn().mockResolvedValue({ tx: FAKE_OPEN_TX, nftMint: FAKE_NFT_MINT, signers: [] }),
    buildClosePositionTx: vi.fn().mockResolvedValue({
      tx: FAKE_CLOSE_TX,
      expectedBertOut: 500_000n,
      expectedSolOut: 5_000_000_000n,
    }),
    // Default: return empty transaction (no instructions) → swap step is skipped by submitter
    buildSwapToRatioTx: vi.fn().mockResolvedValue(new Transaction()),
    getWalletBalances: vi.fn().mockResolvedValue({
      solLamports: 5_000_000_000n,   // 5 SOL
      bertRaw: 100_000_000n,          // 100 BERT (6 dec) = 0.1 BERT @ $0.00015 = $0.000015
    }),
    simulateClose: vi.fn().mockResolvedValue({
      // Default: healthy position — effectiveValueUsd ≈ $1000 (passes drawdown at 95%)
      // effectiveValueUsd = (0 / 1e6) * 0 + (6_700_000_000 / 1e9) * $150 ≈ $1005
      effectivePriceUsd: 0,
      bertOut: 0n,
      solOut: 6_700_000_000n,  // 6.7 SOL * $150 = $1005 > $950 (95% of $1000)
    }),
  };

  const submitter = {
    submit: vi.fn().mockImplementation(async (_tx: Transaction, opts?: { dryRun?: boolean }) => {
      if (opts?.dryRun) return 'DRY_RUN_SIGNATURE';
      // Alternate between close and open sigs based on call count
      const calls = (submitter.submit as ReturnType<typeof vi.fn>).mock.calls.length;
      return calls === 1 ? CLOSE_SIG : OPEN_SIG;
    }),
  };

  const state = {
    getCurrentPosition: vi.fn().mockReturnValue(null),
    setCurrentPosition: vi.fn(),
    clearCurrentPosition: vi.fn(),
    recordRebalance: vi.fn(),
    getRebalancesToday: vi.fn().mockReturnValue(0),
    lastRebalanceAt: vi.fn().mockReturnValue(null),
    setDegraded: vi.fn(),
    isDegraded: vi.fn().mockReturnValue(false),
    recordOperatorAction: vi.fn(),
    listOperatorActions: vi.fn(),
    init: vi.fn(),
    close: vi.fn(),
    path: ':memory:',
  };

  const notifier = {
    send: vi.fn().mockResolvedValue(undefined),
  };

  return {
    raydium: raydium as unknown as RebalancerDeps['raydium'],
    submitter: submitter as unknown as RebalancerDeps['submitter'],
    state: state as unknown as RebalancerDeps['state'],
    notifier: notifier as unknown as RebalancerDeps['notifier'],
    config: BASE_CFG,
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('executeRebalance', () => {
  describe('1. Happy path — no current position', () => {
    it('opens a new position and persists state', async () => {
      const deps = makeDeps();
      const result = await executeRebalance(deps, MID, null, 'price out of range');

      expect(result.kind).toBe('OK');
      expect(result.newNftMint).toBe(FAKE_NFT_MINT);

      // buildClosePositionTx should NOT be called — there's no existing position
      expect(deps.raydium.buildClosePositionTx).not.toHaveBeenCalled();

      // buildOpenPositionTx should be called with oracle solUsd
      expect(deps.raydium.buildOpenPositionTx).toHaveBeenCalledWith(
        expect.objectContaining({ solUsd: MID.solUsd }),
      );

      // State writes should happen
      expect(deps.state.setCurrentPosition).toHaveBeenCalledWith(
        expect.objectContaining({ nftMint: FAKE_NFT_MINT }),
      );
      expect(deps.state.recordRebalance).toHaveBeenCalledWith(
        expect.objectContaining({ newCenterUsd: MID.bertUsd }),
      );

      // Notifier INFO sent
      expect(deps.notifier.send).toHaveBeenCalledWith('INFO', expect.stringContaining('OK'));
    });

    it('includes lowerUsd and upperUsd derived from rangeWidthPct', async () => {
      const deps = makeDeps();
      await executeRebalance(deps, MID, null, 'test');

      const halfWidth = MID.bertUsd * (BASE_CFG.rangeWidthPct / 100) / 2;
      expect(deps.raydium.buildOpenPositionTx).toHaveBeenCalledWith(
        expect.objectContaining({
          lowerUsd: MID.bertUsd - halfWidth,
          upperUsd: MID.bertUsd + halfWidth,
        }),
      );
    });
  });

  describe('2. Dry-run mode', () => {
    it('does not mutate state but does notify and returns OK', async () => {
      const deps = makeDeps({ config: { ...BASE_CFG, dryRun: true } });
      const result = await executeRebalance(deps, MID, null, 'test dry run');

      expect(result.kind).toBe('OK');
      expect(result.newNftMint).toBe(FAKE_NFT_MINT);

      // Submitter called with dryRun=true
      expect(deps.submitter.submit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ dryRun: true }),
      );

      // State MUST NOT be mutated in dry-run
      expect(deps.state.setCurrentPosition).not.toHaveBeenCalled();
      expect(deps.state.recordRebalance).not.toHaveBeenCalled();

      // Notifier MUST still be called
      expect(deps.notifier.send).toHaveBeenCalledWith('INFO', expect.stringContaining('DRY RUN'));
    });
  });

  describe('3. Drawdown breaker trips', () => {
    it('returns SKIPPED, marks degraded, sends CRITICAL', async () => {
      const deps = makeDeps();

      // Simulate close returns amounts worth only ~$600 — well below 95% of $1000
      // effectiveValueUsd = (0 / 1e6) * 0 + (4_000_000_000 / 1e9) * $150 = 4 * $150 = $600
      (deps.raydium.simulateClose as ReturnType<typeof vi.fn>).mockResolvedValue({
        effectivePriceUsd: 0,
        bertOut: 0n,
        solOut: 4_000_000_000n,    // 4 SOL * $150 = $600 < $950 (95% of $1000)
      });

      // Position entry value = $1000
      const position: PositionSnapshot = { ...POSITION, totalValueUsd: 1000 };

      const result = await executeRebalance(deps, MID, position, 'test drawdown');

      expect(result.kind).toBe('SKIPPED');
      expect(result.detail).toMatch(/drawdown/i);

      // setDegraded should be called with true
      expect(deps.state.setDegraded).toHaveBeenCalledWith(true, expect.stringContaining('drawdown'));

      // CRITICAL notification
      expect(deps.notifier.send).toHaveBeenCalledWith('CRITICAL', expect.stringContaining('DRAWDOWN'));

      // No open/close should happen
      expect(deps.raydium.buildClosePositionTx).not.toHaveBeenCalled();
      expect(deps.raydium.buildOpenPositionTx).not.toHaveBeenCalled();
    });
  });

  describe('4. Close fails', () => {
    it('returns FAILED and does NOT mark degraded', async () => {
      const deps = makeDeps();

      (deps.raydium.buildClosePositionTx as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('RPC timeout'),
      );

      const result = await executeRebalance(deps, MID, POSITION, 'test close fail');

      expect(result.kind).toBe('FAILED');
      expect(result.detail).toMatch(/buildClosePositionTx failed/i);

      // No degraded state — no partial state was created
      expect(deps.state.setDegraded).not.toHaveBeenCalled();
      expect(deps.state.setCurrentPosition).not.toHaveBeenCalled();
      expect(deps.state.recordRebalance).not.toHaveBeenCalled();

      // Notification sent
      expect(deps.notifier.send).toHaveBeenCalledWith('CRITICAL', expect.stringContaining('close'));
    });
  });

  describe('5. Open fails after close succeeds', () => {
    it('returns FAILED with "close ok", marks degraded, sends CRITICAL', async () => {
      const deps = makeDeps();

      // Close succeeds — submitter first call returns close sig fine
      (deps.submitter.submit as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(CLOSE_SIG)
        .mockRejectedValueOnce(new Error('open tx simulation failed'));

      const result = await executeRebalance(deps, MID, POSITION, 'test open fail');

      expect(result.kind).toBe('FAILED');
      expect(result.detail).toMatch(/close ok.*open failed/i);

      // Bot goes degraded — we closed the position but couldn't open a new one
      expect(deps.state.setDegraded).toHaveBeenCalledWith(
        true,
        expect.stringContaining('close ok'),
      );

      // CRITICAL notification with reference to partial failure
      expect(deps.notifier.send).toHaveBeenCalledWith(
        'CRITICAL',
        expect.stringContaining('PARTIALLY FAILED'),
      );

      // State should NOT record a new position
      expect(deps.state.setCurrentPosition).not.toHaveBeenCalled();
    });
  });

  describe('6. Swap step failure after close success', () => {
    it('returns FAILED, marks degraded, sends CRITICAL', async () => {
      const deps = makeDeps();

      // Close succeeds
      (deps.submitter.submit as ReturnType<typeof vi.fn>).mockResolvedValueOnce(CLOSE_SIG);

      // getWalletBalances throws (simulating RPC failure mid-flow)
      (deps.raydium.getWalletBalances as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('RPC connection refused'),
      );

      const result = await executeRebalance(deps, MID, POSITION, 'test swap fail');

      expect(result.kind).toBe('FAILED');
      expect(result.detail).toMatch(/swap-to-ratio failed after close/i);

      // Bot goes degraded — we closed but have unbalanced inventory
      expect(deps.state.setDegraded).toHaveBeenCalledWith(
        true,
        expect.stringContaining('swap-to-ratio failed'),
      );

      // CRITICAL notification
      expect(deps.notifier.send).toHaveBeenCalledWith(
        'CRITICAL',
        expect.stringContaining('FAILED (swap-to-ratio)'),
      );

      // No new position opened
      expect(deps.state.setCurrentPosition).not.toHaveBeenCalled();
      expect(deps.raydium.buildOpenPositionTx).not.toHaveBeenCalled();
    });
  });

  describe('7. Balanced inventory skips swap', () => {
    it('does not invoke submitter for swap when wallet is already near 50/50', async () => {
      const deps = makeDeps();

      // Provide perfectly balanced wallet:
      // After floor (100_000_000 lamports): usableSol = 1_100_000_000 lamports = 1.1 SOL = $165
      // bertRaw = 1_100_000_000_000 raw BERT = 1_100_000 BERT @ $0.00015 = $165
      // currentBertRatio = 165 / (165+165) = 0.5 → no swap needed
      (deps.raydium.getWalletBalances as ReturnType<typeof vi.fn>).mockResolvedValue({
        solLamports: 1_200_000_000n,          // 1.2 SOL; usable = 1.1 SOL after floor
        bertRaw: 1_100_000_000_000n,           // 1,100,000 BERT (6 dec) = $165
      });

      const result = await executeRebalance(deps, MID, null, 'balanced inventory test');

      expect(result.kind).toBe('OK');

      // buildSwapToRatioTx should NOT be called (ratio within 1% threshold)
      expect(deps.raydium.buildSwapToRatioTx).not.toHaveBeenCalled();

      // Submitter called once only — for the open tx (no close, no swap)
      const submitCalls = (deps.submitter.submit as ReturnType<typeof vi.fn>).mock.calls;
      expect(submitCalls).toHaveLength(1);
    });
  });
});
