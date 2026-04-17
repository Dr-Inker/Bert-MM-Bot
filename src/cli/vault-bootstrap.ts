import { Keypair } from '@solana/web3.js';
import type { DepositorStore } from '../vault/depositorStore.js';
import { encrypt } from '../vault/encryption.js';

export interface BootstrapParams {
  store: DepositorStore;
  masterKey: Buffer;
  operatorTelegramId: number;
  initialNavUsd: number;
  ensureAta: (addr: string) => Promise<void>;
  now: number;
}

export interface BootstrapResult {
  operatorTelegramId: number;
  depositAddress: string;
  initialShares: number;
  navPerShare: number;
}

/**
 * One-time vault founding-depositor initialization. Atomically:
 *   1. Generates an operator deposit keypair + encrypts it.
 *   2. Inserts the operator user row (role='operator').
 *   3. Mints `initialNavUsd` shares to the operator (1 share = $1 at launch).
 *   4. Writes a 'bootstrap' NAV snapshot with NAV/share = 1.
 *   5. Emits a 'bootstrap' audit event.
 *
 * Refuses to run if any users already exist in the vault (safety guard).
 * Calls `ensureAta(depositAddress)` *after* the transaction so BERT
 * inbound transfers to the operator deposit address can land.
 */
export async function runBootstrap(p: BootstrapParams): Promise<BootstrapResult> {
  if (p.store.listUsers().length > 0) {
    throw new Error('vault-bootstrap: vault already initialised (users exist)');
  }
  const kp = Keypair.generate();
  const enc = encrypt(Buffer.from(kp.secretKey), p.masterKey);
  const depositAddress = kp.publicKey.toBase58();
  p.store.withTransaction(() => {
    p.store.createUser({
      telegramId: p.operatorTelegramId,
      role: 'operator',
      depositAddress,
      depositSecretEnc: enc.ciphertext,
      depositSecretIv: enc.iv,
      disclaimerAt: p.now,
      createdAt: p.now,
    });
    p.store.addShares(p.operatorTelegramId, p.initialNavUsd); // 1 share = $1 at launch
    p.store.insertNavSnapshot({
      ts: p.now,
      totalValueUsd: p.initialNavUsd,
      totalShares: p.initialNavUsd,
      navPerShare: 1,
      source: 'bootstrap',
    });
    p.store.writeAudit({
      ts: p.now,
      telegramId: p.operatorTelegramId,
      event: 'bootstrap',
      detailsJson: JSON.stringify({ initialNavUsd: p.initialNavUsd }),
    });
  });
  await p.ensureAta(depositAddress);
  return {
    operatorTelegramId: p.operatorTelegramId,
    depositAddress,
    initialShares: p.initialNavUsd,
    navPerShare: 1,
  };
}
