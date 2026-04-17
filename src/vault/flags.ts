/**
 * Shared flag-key constants for the depositor vault.
 *
 * Flags live in the `flags` table (key-value with reason + timestamp). The
 * value is interpreted as: '1' = set, anything else (including '' or missing)
 * = unset. See `StateStore.setFlag` / `StateStore.getFlag`.
 */

/** When set to '1', the withdrawal-drain loop refuses to process withdrawals. */
export const VAULT_PAUSED_FLAG = 'vault_paused';

/** Returns true when the vault is currently paused via the flag. */
export function isVaultPaused(getFlag: (key: string) => string | undefined): boolean {
  return (getFlag(VAULT_PAUSED_FLAG) ?? '') === '1';
}
