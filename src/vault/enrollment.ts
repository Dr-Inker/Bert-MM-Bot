import { Keypair } from '@solana/web3.js';
import { encrypt, decrypt } from './encryption.js';
import { generateSecret, otpauthUri, verifyCode } from './totp.js';
import type { DepositorStore } from './depositorStore.js';

export interface EnrollmentDeps {
  store: DepositorStore;
  masterKey: Buffer;
  /** Invoked after accept(): create BERT ATA for the new deposit address. */
  ensureAta: (depositAddress: string) => Promise<void>;
}

export class Enrollment {
  constructor(private deps: EnrollmentDeps) {}

  /** User accepted the disclaimer. Generates deposit keypair + empty user row. */
  async accept(args: { telegramId: number; now: number }): Promise<void> {
    if (this.deps.store.getUser(args.telegramId)) return;
    const kp = Keypair.generate();
    const secretBuf = Buffer.from(kp.secretKey);
    const enc = encrypt(secretBuf, this.deps.masterKey);
    this.deps.store.createUser({
      telegramId: args.telegramId,
      role: 'depositor',
      depositAddress: kp.publicKey.toBase58(),
      depositSecretEnc: enc.ciphertext,
      depositSecretIv: enc.iv,
      disclaimerAt: args.now,
      createdAt: args.now,
    });
    await this.deps.ensureAta(kp.publicKey.toBase58());
  }

  /** Generate a TOTP secret and return the URI for the QR code. */
  async beginTotpEnrollment(args: { telegramId: number }): Promise<{
    secretBase32: string; uri: string;
  }> {
    const user = this.deps.store.getUser(args.telegramId);
    if (!user) throw new Error('Enrollment.beginTotpEnrollment: no such user');
    const secretBase32 = generateSecret();
    const uri = otpauthUri({
      secret: secretBase32,
      label: `BertVault:${args.telegramId}`,
      issuer: 'BertVault',
    });
    // Persist the pending secret immediately (encrypted). enrolled_at=0 means pending;
    // confirmTotp sets the real timestamp once the user proves they can produce a code.
    const enc = encrypt(Buffer.from(secretBase32, 'utf8'), this.deps.masterKey);
    this.deps.store.setTotp({
      telegramId: args.telegramId,
      secretEnc: enc.ciphertext,
      secretIv: enc.iv,
      enrolledAt: 0,
    });
    return { secretBase32, uri };
  }

  /** Confirm the user can produce a valid TOTP code. Marks enrolled. */
  async confirmTotp(args: { telegramId: number; code: string; now: number }): Promise<boolean> {
    const secrets = this.deps.store.getUserSecrets(args.telegramId);
    if (!secrets || !secrets.totpSecretEnc || !secrets.totpSecretIv) return false;
    const secretBase32 = decrypt(
      secrets.totpSecretEnc,
      secrets.totpSecretIv,
      this.deps.masterKey,
    ).toString('utf8');
    const r = verifyCode({ secret: secretBase32, code: args.code, lastUsedCounter: null });
    if (!r.ok) return false;
    this.deps.store.setTotp({
      telegramId: args.telegramId,
      secretEnc: secrets.totpSecretEnc,
      secretIv: secrets.totpSecretIv,
      enrolledAt: args.now,
    });
    this.deps.store.setTotpLastCounter(args.telegramId, r.counter);
    return true;
  }
}
