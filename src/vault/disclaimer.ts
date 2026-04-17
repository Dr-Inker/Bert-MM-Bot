export const DISCLAIMER_TEXT = `
⚠️  BERT Vault — Terms

This is a CUSTODIAL service.

• Operator (Dr. Inker Labs) holds all private keys, including your deposit address's.
• Funds are pooled with other depositors and used by a market-making strategy on the Meteora BERT/SOL DLMM pool.
• The strategy can lose money. Impermanent loss, rebalance friction, and slippage all apply. Past performance is not a guarantee of future returns.
• No FDIC insurance. No guarantees of redemption. Withdrawals are self-service via Telegram to a single whitelisted address.
• 2FA (TOTP) is required on every sensitive action (deposit-address reveal, balance view, withdrawal, whitelist change).
• Changing the withdrawal whitelist takes effect after a 24-hour cooldown (except on first setup).
• Withdrawals pay a 0.30% fee into the pool (not to the operator).

By continuing you accept these terms and the associated risk.
Reply  /accept  to continue, or  /decline  to abort.
`.trim();
