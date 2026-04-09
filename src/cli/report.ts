import type { StateStore } from '../stateStore.js';
import type { BotConfig } from '../types.js';

export function runReport(cfg: BotConfig, state: StateStore, days: number): void {
  void cfg; // cfg available for future enrichment
  const sinceMs = Date.now() - days * 86_400_000;

  const rebalances = state.listRebalancesSince(sinceMs);
  const actions = state.listOperatorActionsSince(sinceMs);

  const totalFees = rebalances.reduce((sum, r) => sum + r.feesCollectedUsd, 0);
  const drifts = rebalances.map((r) => Math.abs(r.newCenterUsd - r.oldCenterUsd));
  const avgDrift = drifts.length > 0 ? drifts.reduce((a, b) => a + b, 0) / drifts.length : 0;

  const report = {
    period: `last ${days} day(s)`,
    since: new Date(sinceMs).toISOString(),
    rebalances: {
      count: rebalances.length,
      totalFeesCollectedUsd: Number(totalFees.toFixed(6)),
      avgCenterDriftUsd: Number(avgDrift.toFixed(8)),
      records: rebalances.map((r) => ({
        ts: new Date(r.ts).toISOString(),
        oldCenterUsd: r.oldCenterUsd,
        newCenterUsd: r.newCenterUsd,
        feesCollectedUsd: r.feesCollectedUsd,
      })),
    },
    operatorActions: actions.map((a) => ({
      ts: new Date(a.ts).toISOString(),
      command: a.command,
      osUser: a.osUser,
    })),
  };

  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
