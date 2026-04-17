import { describe, it, expect, beforeEach } from 'vitest';
import { encrypt, decrypt, loadMasterKey } from '../../src/vault/encryption.js';

describe('encryption', () => {
  const key = Buffer.alloc(32, 7); // deterministic 32-byte key for tests

  it('round-trips a plaintext', () => {
    const { ciphertext, iv } = encrypt(Buffer.from('hello world'), key);
    const plain = decrypt(ciphertext, iv, key);
    expect(plain.toString()).toBe('hello world');
  });

  it('round-trips 32-byte binary', () => {
    const msg = Buffer.alloc(32, 0xab);
    const { ciphertext, iv } = encrypt(msg, key);
    expect(decrypt(ciphertext, iv, key).equals(msg)).toBe(true);
  });

  it('fails to decrypt with wrong key', () => {
    const { ciphertext, iv } = encrypt(Buffer.from('secret'), key);
    const wrong = Buffer.alloc(32, 8);
    expect(() => decrypt(ciphertext, iv, wrong)).toThrow();
  });

  it('fails to decrypt with tampered ciphertext', () => {
    const { ciphertext, iv } = encrypt(Buffer.from('secret'), key);
    ciphertext[0] ^= 1;
    expect(() => decrypt(ciphertext, iv, key)).toThrow();
  });

  it('produces unique IVs across many encryptions', () => {
    const ivs = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      const { iv } = encrypt(Buffer.from('x'), key);
      ivs.add(iv.toString('hex'));
    }
    expect(ivs.size).toBe(10_000);
  });

  it('loadMasterKey rejects missing env var', () => {
    delete process.env.VAULT_MASTER_KEY;
    expect(() => loadMasterKey()).toThrow(/VAULT_MASTER_KEY/);
  });

  it('loadMasterKey rejects wrong-length key', () => {
    process.env.VAULT_MASTER_KEY = Buffer.alloc(16, 0).toString('base64');
    expect(() => loadMasterKey()).toThrow(/32/);
  });

  it('loadMasterKey returns 32-byte buffer', () => {
    process.env.VAULT_MASTER_KEY = Buffer.alloc(32, 0).toString('base64');
    const k = loadMasterKey();
    expect(k.length).toBe(32);
  });
});
