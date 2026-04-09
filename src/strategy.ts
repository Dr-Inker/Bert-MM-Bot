import type { BotState, Decision } from './types.js';

export interface StrategyParams {
  rangeWidthPct: number;
  sustainedMinutes: number;
  minRebalanceIntervalMin: number;
  maxRebalancesPerDay: number;
  oracleStaleMinutes: number;
  pollIntervalSec: number;
}

export function decide(state: BotState, params: StrategyParams): Decision {
  if (state.killSwitchTripped) return { kind: 'PAUSE', reason: 'kill switch tripped' };
  if (state.degraded) return { kind: 'PAUSE', reason: 'degraded flag set' };

  if (state.price && state.now - state.price.ts > params.oracleStaleMinutes * 60_000) {
    return {
      kind: 'PAUSE',
      reason: `oracle stale by ${Math.round((state.now - state.price.ts) / 60_000)} min`,
    };
  }

  if (!state.price) return { kind: 'HOLD', reason: 'oracle returned null (divergent sources)' };
  if (!state.position) return { kind: 'HOLD', reason: 'no position yet (initial state)' };

  const { lowerBertUsd, upperBertUsd } = state.position.range;
  const currentPrice = state.price.bertUsd;
  const inRange = currentPrice >= lowerBertUsd && currentPrice <= upperBertUsd;
  if (inRange) return { kind: 'HOLD', reason: 'price in range' };

  const requiredMinutes = params.sustainedMinutes;
  const cutoff = state.now - requiredMinutes * 60_000;
  const recent = state.priceHistory.filter((s) => s.ts >= cutoff);
  if (recent.length < requiredMinutes) {
    return { kind: 'HOLD', reason: 'not enough history yet' };
  }
  const allOutOfRange = recent.every((s) => s.bertUsd < lowerBertUsd || s.bertUsd > upperBertUsd);
  if (!allOutOfRange) return { kind: 'HOLD', reason: 'not sustained out-of-range' };

  if (state.lastRebalanceAt !== null) {
    const sinceMin = (state.now - state.lastRebalanceAt) / 60_000;
    if (sinceMin < params.minRebalanceIntervalMin) {
      return {
        kind: 'ALERT_ONLY',
        reason: `out-of-range but cooldown active (${sinceMin.toFixed(1)}/${params.minRebalanceIntervalMin} min)`,
      };
    }
  }

  if (state.rebalancesToday >= params.maxRebalancesPerDay) {
    return {
      kind: 'ALERT_ONLY',
      reason: `out-of-range but daily cap reached (${state.rebalancesToday}/${params.maxRebalancesPerDay})`,
    };
  }

  return {
    kind: 'REBALANCE',
    reason: 'sustained out-of-range; triggers cleared',
    newCenterUsd: currentPrice,
  };
}
