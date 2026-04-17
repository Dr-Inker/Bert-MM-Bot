import type { DepositorStore } from './depositorStore.js';
import type { PendingWhitelistChange } from './types.js';

export interface CooldownsDeps {
  store: DepositorStore;
  cooldownMs: number;
}

export class Cooldowns {
  constructor(private deps: CooldownsDeps) {}

  /** Request a whitelist change. First-set is immediate; subsequent waits cooldown. */
  requestChange(args: {
    telegramId: number; newAddress: string; now: number;
  }): { immediate: boolean; activatesAt: number; pendingId: number } {
    const user = this.deps.store.getUser(args.telegramId);
    if (!user) throw new Error('requestChange: user not found');

    if (user.whitelistAddress === null) {
      return this.deps.store.withTransaction(() => {
        const id = this.deps.store.enqueueWhitelistChange({
          telegramId: args.telegramId, oldAddress: null, newAddress: args.newAddress,
          requestedAt: args.now, activatesAt: args.now, initialStatus: 'activated',
        });
        this.deps.store.setWhitelistImmediate({
          telegramId: args.telegramId, address: args.newAddress, ts: args.now,
        });
        return { immediate: true, activatesAt: args.now, pendingId: id };
      });
    }

    const activatesAt = args.now + this.deps.cooldownMs;
    const id = this.deps.store.enqueueWhitelistChange({
      telegramId: args.telegramId, oldAddress: user.whitelistAddress,
      newAddress: args.newAddress, requestedAt: args.now, activatesAt,
      initialStatus: 'pending',
    });
    return { immediate: false, activatesAt, pendingId: id };
  }

  /** Activate any pending changes whose activates_at <= now. Returns activated rows. */
  activateDue(args: { now: number }): PendingWhitelistChange[] {
    const due = this.deps.store.listDueWhitelistChanges(args.now);
    const activated: PendingWhitelistChange[] = [];
    for (const row of due) {
      this.deps.store.withTransaction(() => {
        this.deps.store.setWhitelistImmediate({
          telegramId: row.telegramId, address: row.newAddress, ts: args.now,
        });
        this.deps.store.markWhitelistActivated(row.id);
      });
      activated.push(row);
    }
    return activated;
  }

  /** Cancel the most recent pending change for a user. Returns true if one was cancelled. */
  cancelPending(args: { telegramId: number; reason: string; now: number }): boolean {
    const p = this.deps.store.mostRecentPendingChange(args.telegramId);
    if (!p) return false;
    this.deps.store.cancelPendingWhitelist(p.id, args.reason);
    return true;
  }
}
