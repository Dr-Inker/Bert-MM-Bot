import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface EncryptedBlob {
  ciphertext: Buffer;   // [encrypted_bytes || auth_tag]
  iv: Buffer;
}

/** Encrypt `plaintext` under 32-byte `key` using AES-256-GCM. */
export function encrypt(plaintext: Buffer, key: Buffer): EncryptedBlob {
  if (key.length !== 32) throw new Error('encrypt: key must be 32 bytes');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: Buffer.concat([enc, tag]), iv };
}

/** Decrypt a blob. Throws on wrong key, wrong IV, or tampered ciphertext. */
export function decrypt(ciphertext: Buffer, iv: Buffer, key: Buffer): Buffer {
  if (key.length !== 32) throw new Error('decrypt: key must be 32 bytes');
  if (iv.length !== IV_BYTES) throw new Error(`decrypt: iv must be ${IV_BYTES} bytes`);
  if (ciphertext.length < TAG_BYTES) throw new Error('decrypt: ciphertext too short');
  const enc = ciphertext.subarray(0, ciphertext.length - TAG_BYTES);
  const tag = ciphertext.subarray(ciphertext.length - TAG_BYTES);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

/** Load master key from VAULT_MASTER_KEY env var (base64, 32 bytes). */
export function loadMasterKey(): Buffer {
  const b64 = process.env.VAULT_MASTER_KEY;
  if (!b64) throw new Error('VAULT_MASTER_KEY env var not set');
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error(`VAULT_MASTER_KEY must be 32 bytes (got ${key.length})`);
  return key;
}
