import type { StateStore } from '../stateStore.js';
import type { BotConfig } from '../types.js';

export interface StatusOutput {
  timestamp: string;
  enabled: boolean;
  degraded: boolean;
  currentPosition: ReturnType<StateStore['getCurrentPosition']>;
  lastRebalanceAt: number | null;
  rebalancesToday: number;
  recentOperatorActions: ReturnType<StateStore['listOperatorActions']>;
}

export function runStatus(cfg: BotConfig, state: StateStore): void {
  const now = Date.now();
  const out: StatusOutput = {
    timestamp: new Date(now).toISOString(),
    enabled: cfg.enabled,
    degraded: state.isDegraded(),
    currentPosition: state.getCurrentPosition(),
    lastRebalanceAt: state.lastRebalanceAt(),
    rebalancesToday: state.getRebalancesToday(now),
    recentOperatorActions: state.listOperatorActions(10),
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}
