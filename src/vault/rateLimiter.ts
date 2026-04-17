/**
 * Per-user TOTP failure tracker for brute-force protection.
 *
 * Failures are tracked in a rolling window. When cumulative failures within
 * the window reach `threshold`, the user is locked out for `lockoutMs` and
 * the stored failure list is cleared (so they don't trip the threshold again
 * on the next attempt after lockout expires).
 *
 * In-memory only; resets on bot restart. Acceptable because the window is
 * short (minutes), so an attacker can never accumulate meaningful cross-
 * restart progress against the 10^6 TOTP code space.
 */
export class TotpRateLimiter {
  private failures = new Map<number, number[]>();   // telegramId → epoch_ms timestamps
  private lockedUntil = new Map<number, number>();  // telegramId → lockout expiry epoch_ms

  constructor(
    private windowMs: number = 15 * 60_000,
    private threshold: number = 5,
    private lockoutMs: number = 15 * 60_000,
  ) {}

  /**
   * If currently locked out, returns the lockout expiry (epoch_ms).
   * Otherwise returns null. Also cleans up expired entries opportunistically.
   */
  isLockedOut(userId: number, now: number): number | null {
    const until = this.lockedUntil.get(userId);
    if (until === undefined) return null;
    if (until > now) return until;
    // Expired — clean up and report unlocked.
    this.lockedUntil.delete(userId);
    return null;
  }

  /**
   * Record a failed TOTP verification.
   * Returns `{ lockedUntil: <epoch_ms> }` if this failure *tripped* the
   * lockout threshold (caller should emit the one-shot `totp_rate_limited`
   * audit event). Returns `{ lockedUntil: null }` otherwise.
   */
  recordFailure(userId: number, now: number): { lockedUntil: number | null } {
    const prior = this.failures.get(userId) ?? [];
    const recent = prior.filter((t) => now - t <= this.windowMs);
    recent.push(now);
    if (recent.length >= this.threshold) {
      const until = now + this.lockoutMs;
      this.lockedUntil.set(userId, until);
      this.failures.delete(userId);
      return { lockedUntil: until };
    }
    this.failures.set(userId, recent);
    return { lockedUntil: null };
  }

  /**
   * Called after a successful TOTP verification. Clears any accumulated
   * failure timestamps and any lockout for that user.
   */
  recordSuccess(userId: number): void {
    this.failures.delete(userId);
    this.lockedUntil.delete(userId);
  }
}

/**
 * Format a remaining lockout window (ms) as "Xm Ys" for user replies.
 * Rounds seconds up so "00s" never renders; minimum message is "0m 1s".
 */
export function formatLockoutRemaining(ms: number): string {
  const totalSec = Math.max(1, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}
