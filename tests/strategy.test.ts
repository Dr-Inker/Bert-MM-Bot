import { describe, it, expect } from 'vitest';
import { decide, StrategyParams } from '../src/strategy.js';
import type { BotState, MidPrice, PositionSnapshot } from '../src/types.js';

const PARAMS: StrategyParams = {
  rangeWidthPct: 20,
  sustainedMinutes: 10,
  minRebalanceIntervalMin: 60,
  maxRebalancesPerDay: 6,
  oracleStaleMinutes: 15,
  pollIntervalSec: 30,
};

const MIN = 60_000;
const NOW = 1_700_000_000_000;

function mkPrice(bertUsd: number, ts: number): MidPrice {
  return { bertUsd, solUsd: 150, bertPerSol: 150 / bertUsd, ts, sources: ['a', 'b', 'c'] };
}

function mkPosition(centerUsd: number): PositionSnapshot {
  return {
    nftMint: 'NFT',
    range: {
      centerBertUsd: centerUsd,
      lowerBertUsd: centerUsd * 0.8,
      upperBertUsd: centerUsd * 1.2,
      widthPct: 20,
    },
    bertAmount: 0n,
    solAmount: 0n,
    uncollectedFeesBert: 0n,
    uncollectedFeesSol: 0n,
    totalValueUsd: 2000,
    openedAt: NOW - 3 * 3600 * 1000,
  };
}

function mkState(overrides: Partial<BotState> = {}): BotState {
  return {
    price: mkPrice(0.01, NOW),
    priceHistory: [],
    position: mkPosition(0.01),
    lastRebalanceAt: NOW - 3 * 3600 * 1000,
    rebalancesToday: 0,
    killSwitchTripped: false,
    degraded: false,
    now: NOW,
    ...overrides,
  };
}

describe('strategy.decide', () => {
  it('HOLD when price is inside range', () => {
    expect(decide(mkState(), PARAMS).kind).toBe('HOLD');
  });

  it('HOLD when no position yet', () => {
    expect(decide(mkState({ position: null }), PARAMS).kind).toBe('HOLD');
  });

  it('PAUSE when killSwitchTripped', () => {
    expect(decide(mkState({ killSwitchTripped: true }), PARAMS).kind).toBe('PAUSE');
  });

  it('PAUSE when degraded', () => {
    expect(decide(mkState({ degraded: true }), PARAMS).kind).toBe('PAUSE');
  });

  it('PAUSE when oracle stale', () => {
    const stale = mkPrice(0.01, NOW - 20 * MIN);
    expect(decide(mkState({ price: stale }), PARAMS).kind).toBe('PAUSE');
  });

  it('HOLD when price is null (divergent oracle)', () => {
    expect(decide(mkState({ price: null }), PARAMS).kind).toBe('HOLD');
  });

  it('HOLD when price briefly out of range', () => {
    const history: MidPrice[] = [];
    for (let i = 5; i >= 0; i--) history.push(mkPrice(0.013, NOW - i * MIN));
    expect(
      decide(mkState({ price: mkPrice(0.013, NOW), priceHistory: history }), PARAMS).kind,
    ).toBe('HOLD');
  });

  it('REBALANCE when sustained out-of-range and cooldowns clear', () => {
    const history: MidPrice[] = [];
    for (let i = 11; i >= 0; i--) history.push(mkPrice(0.013, NOW - i * MIN));
    const d = decide(
      mkState({
        price: mkPrice(0.013, NOW),
        priceHistory: history,
        lastRebalanceAt: NOW - 2 * 3600 * 1000,
      }),
      PARAMS,
    );
    expect(d.kind).toBe('REBALANCE');
    if (d.kind === 'REBALANCE') expect(d.newCenterUsd).toBeCloseTo(0.013);
  });

  it('ALERT_ONLY when trigger fires within min interval', () => {
    const history: MidPrice[] = [];
    for (let i = 11; i >= 0; i--) history.push(mkPrice(0.013, NOW - i * MIN));
    expect(
      decide(
        mkState({
          price: mkPrice(0.013, NOW),
          priceHistory: history,
          lastRebalanceAt: NOW - 10 * MIN,
        }),
        PARAMS,
      ).kind,
    ).toBe('ALERT_ONLY');
  });

  it('ALERT_ONLY when daily cap reached', () => {
    const history: MidPrice[] = [];
    for (let i = 11; i >= 0; i--) history.push(mkPrice(0.013, NOW - i * MIN));
    expect(
      decide(
        mkState({
          price: mkPrice(0.013, NOW),
          priceHistory: history,
          lastRebalanceAt: NOW - 2 * 3600 * 1000,
          rebalancesToday: 6,
        }),
        PARAMS,
      ).kind,
    ).toBe('ALERT_ONLY');
  });

  it('REBALANCE on low-side sustained out-of-range', () => {
    const history: MidPrice[] = [];
    for (let i = 11; i >= 0; i--) history.push(mkPrice(0.007, NOW - i * MIN));
    const d = decide(
      mkState({
        price: mkPrice(0.007, NOW),
        priceHistory: history,
        lastRebalanceAt: NOW - 2 * 3600 * 1000,
      }),
      PARAMS,
    );
    expect(d.kind).toBe('REBALANCE');
  });

  it('does not trigger on mixed in/out history (needs continuous out)', () => {
    const history: MidPrice[] = [];
    for (let i = 11; i >= 0; i--) {
      history.push(mkPrice(i === 5 ? 0.010 : 0.013, NOW - i * MIN));
    }
    expect(
      decide(
        mkState({
          price: mkPrice(0.013, NOW),
          priceHistory: history,
          lastRebalanceAt: NOW - 2 * 3600 * 1000,
        }),
        PARAMS,
      ).kind,
    ).toBe('HOLD');
  });
});
