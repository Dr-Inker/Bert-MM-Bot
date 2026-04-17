import type { Logger } from 'pino';
import type { StateStore } from '../stateStore.js';
import type { DepositorStore } from './depositorStore.js';
import type { PendingWhitelistChange } from './types.js';
import { isVaultPaused } from './flags.js';

export interface VaultTickDeps {
  store: DepositorStore;
  state: StateStore;
  isDegraded: () => boolean;
  isKilled: () => boolean;
  /** Polls one deposit address for new inflows (delegates to DepositWatcher). */
  pollAddress: (address: string) => Promise<void>;
  /** Drains queued withdrawals (delegates to WithdrawalExecutor). */
  drain: () => Promise<void>;
  /** Activates any whitelist changes whose cooldown has elapsed. */
  activateDue: (args: { now: number }) => PendingWhitelistChange[];
  now: () => number;
  log: Logger;
}

/**
 * Run one vault tick. Ordering matters:
 *
 *   1. Poll each enrolled deposit address for new inflows (cheap RPC calls;
 *      safe to run outside the rebalance mutex).
 *   2. Drain queued withdrawals (skipped when degraded / killed / paused —
 *      the rebalancer's safety gates mirror this).
 *   3. Activate any due whitelist changes (tiny DB ops, always runs).
 *
 * Errors in any step are logged and swallowed so one bad address or one bad
 * withdrawal cannot take down the whole bot tick.
 *
 * NOTE: the surrounding rebalance call is NOT part of this function. The main
 * loop runs `rebalance()` between step 1 and step 2 — that's the plan-
 * specified ordering (deposit-watcher → rebalance → withdrawal-drain).
 */
export async function runVaultTick(deps: VaultTickDeps): Promise<void> {
  // Step 1 (pre-rebalance): poll deposit addresses for every enrolled user.
  const users = deps.store.listUsers();
  for (const u of users) {
    try {
      await deps.pollAddress(u.depositAddress);
    } catch (e) {
      deps.log.warn({ err: e, telegramId: u.telegramId }, 'vault: deposit poll failed');
    }
  }

  // Step 2 (post-rebalance in main loop): drain withdrawals when healthy.
  const paused = isVaultPaused((k) => deps.state.getFlag(k));
  if (!deps.isDegraded() && !deps.isKilled() && !paused) {
    try {
      await deps.drain();
    } catch (e) {
      deps.log.error({ err: e }, 'vault: withdrawal drain failed');
    }
  }

  // Step 3: activate any cooldown-elapsed whitelist changes.
  try {
    const activated = deps.activateDue({ now: deps.now() });
    for (const row of activated) {
      deps.store.writeAudit({
        ts: deps.now(),
        telegramId: row.telegramId,
        event: 'whitelist_activated',
        detailsJson: JSON.stringify({
          id: row.id,
          oldAddress: row.oldAddress,
          newAddress: row.newAddress,
        }),
      });
    }
  } catch (e) {
    deps.log.warn({ err: e }, 'vault: whitelist activation failed');
  }
}

/**
 * Convenience split used by main.ts: step 1 (poll) runs BEFORE rebalance;
 * steps 2+3 (drain + activate) run AFTER. The main loop calls these in order
 * so deposit inflows are swept + credited on a fresh NAV before the
 * rebalancer reopens position bounds.
 */
export async function runVaultPreRebalance(
  deps: Pick<VaultTickDeps, 'store' | 'pollAddress' | 'log'>,
): Promise<void> {
  const users = deps.store.listUsers();
  for (const u of users) {
    try {
      await deps.pollAddress(u.depositAddress);
    } catch (e) {
      deps.log.warn({ err: e, telegramId: u.telegramId }, 'vault: deposit poll failed');
    }
  }
}

export async function runVaultPostRebalance(
  deps: Omit<VaultTickDeps, 'pollAddress'>,
): Promise<void> {
  const paused = isVaultPaused((k) => deps.state.getFlag(k));
  if (!deps.isDegraded() && !deps.isKilled() && !paused) {
    try {
      await deps.drain();
    } catch (e) {
      deps.log.error({ err: e }, 'vault: withdrawal drain failed');
    }
  }
  try {
    const activated = deps.activateDue({ now: deps.now() });
    for (const row of activated) {
      deps.store.writeAudit({
        ts: deps.now(),
        telegramId: row.telegramId,
        event: 'whitelist_activated',
        detailsJson: JSON.stringify({
          id: row.id,
          oldAddress: row.oldAddress,
          newAddress: row.newAddress,
        }),
      });
    }
  } catch (e) {
    deps.log.warn({ err: e }, 'vault: whitelist activation failed');
  }
}
