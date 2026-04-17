export interface VaultUser {
  telegramId: number;
  role: 'operator' | 'depositor';
  depositAddress: string;
  totpEnrolledAt: number | null;
  totpLastUsedCounter: number | null;
  whitelistAddress: string | null;
  whitelistSetAt: number | null;
  disclaimerAt: number;
  createdAt: number;
}

export interface VaultDeposit {
  id: number;
  telegramId: number;
  inboundTxSig: string;
  sweepTxSig: string | null;
  solLamports: bigint;
  bertRaw: bigint;
  solUsd: number;
  bertUsd: number;
  navPerShareAt: number;
  sharesMinted: number;
  confirmedAt: number;
  sweptAt: number | null;
}

export type WithdrawalStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface VaultWithdrawal {
  id: number;
  telegramId: number;
  status: WithdrawalStatus;
  destination: string;
  sharesBurned: number;
  feeShares: number;
  navPerShareAt: number | null;
  solLamportsOut: bigint | null;
  bertRawOut: bigint | null;
  txSig: string | null;
  failureReason: string | null;
  queuedAt: number;
  processedAt: number | null;
}

export interface PendingWhitelistChange {
  id: number;
  telegramId: number;
  oldAddress: string | null;
  newAddress: string;
  requestedAt: number;
  activatesAt: number;
  status: 'pending' | 'activated' | 'cancelled';
  cancelReason: string | null;
}

export interface NavSnapshotRow {
  ts: number;
  totalValueUsd: number;
  totalShares: number;
  navPerShare: number;
  source: 'hourly' | 'deposit' | 'withdrawal' | 'bootstrap';
}
