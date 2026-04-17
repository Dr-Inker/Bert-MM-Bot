export type Usd = number;
export type SolLamports = bigint;
export type BertRaw = bigint;

export interface MidPrice {
  bertPerSol: number;
  bertUsd: number;
  solUsd: number;
  ts: number;
  sources: string[];
}

export interface Range {
  lowerBertUsd: number;
  upperBertUsd: number;
  centerBertUsd: number;
  widthPct: number;
}

export interface PositionSnapshot {
  nftMint: string;
  range: Range;
  bertAmount: BertRaw;
  solAmount: SolLamports;
  uncollectedFeesBert: BertRaw;
  uncollectedFeesSol: SolLamports;
  totalValueUsd: Usd;
  openedAt: number;
}

export interface BotState {
  price: MidPrice | null;
  priceHistory: MidPrice[];
  position: PositionSnapshot | null;
  lastRebalanceAt: number | null;
  rebalancesToday: number;
  killSwitchTripped: boolean;
  degraded: boolean;
  now: number;
}

export type Decision =
  | { kind: 'HOLD'; reason: string }
  | { kind: 'REBALANCE'; reason: string; newCenterUsd: number }
  | { kind: 'PAUSE'; reason: string }
  | { kind: 'ALERT_ONLY'; reason: string };

export interface MevProtectionConfig {
  enabled: boolean;
  blockEngineUrl: string;
  tipLamports: number;
  bundleTimeoutMs: number;
}

export interface BotConfig {
  venue: 'raydium' | 'meteora';
  enabled: boolean;
  mevProtection?: MevProtectionConfig;
  poolAddress: string;
  bertMint: string;
  rangeWidthPct: number;
  sustainedMinutes: number;
  minRebalanceIntervalMin: number;
  maxRebalancesPerDay: number;
  maxSlippageBps: number;
  maxDrawdownPct: number;
  drawdownWindowMin: number;
  maxPositionUsd: number;
  oracleDivergenceBps: number;
  oracleStaleMinutes: number;
  rpcOutageMinutes: number;
  minSolBalance: number;
  hardPauseSolBalance: number;
  minSolFloorLamports: number;
  priorityFeeMicroLamports: number;
  pollIntervalSec: number;
  feeCollectionMode: 'on_rebalance' | 'scheduled';
  feeHandling: 'compound' | 'sweep';
  rpcPrimary: string;
  rpcFallback: string;
  keyfilePath: string;
  statePath: string;
  killSwitchFilePath: string;
  heartbeatPath: string;
  notifier?: {
    telegram?: { botToken: string; chatIdInfo: string; chatIdCritical: string };
    discord?: { webhookInfo: string; webhookCritical: string };
  };
  dryRun: boolean;
}
