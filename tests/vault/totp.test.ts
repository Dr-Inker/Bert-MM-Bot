import { describe, it, expect } from 'vitest';
import { TOTP } from 'otpauth';
import {
  generateSecret, otpauthUri, verifyCode, currentCounter,
} from '../../src/vault/totp.js';

describe('totp', () => {
  it('generates a 32-char base32 secret', () => {
    const s = generateSecret();
    expect(s.length).toBeGreaterThanOrEqual(32);
    expect(/^[A-Z2-7]+=*$/.test(s)).toBe(true);
  });

  it('otpauthUri contains label + issuer', () => {
    const uri = otpauthUri({ secret: 'JBSWY3DPEHPK3PXP', label: 'user-123', issuer: 'BertVault' });
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain('issuer=BertVault');
    expect(uri).toContain('JBSWY3DPEHPK3PXP');
  });

  it('verifies a freshly-generated code', () => {
    const secret = generateSecret();
    const totp = new TOTP({ secret });
    const code = totp.generate();
    const r = verifyCode({ secret, code, lastUsedCounter: null });
    expect(r.ok).toBe(true);
    expect(r.counter).toBe(currentCounter());
  });

  it('rejects invalid code', () => {
    const secret = generateSecret();
    const r = verifyCode({ secret, code: '000000', lastUsedCounter: null });
    expect(r.ok).toBe(false);
  });

  it('rejects replay: same counter twice', () => {
    const secret = generateSecret();
    const totp = new TOTP({ secret });
    const code = totp.generate();
    const first = verifyCode({ secret, code, lastUsedCounter: null });
    expect(first.ok).toBe(true);
    const replay = verifyCode({ secret, code, lastUsedCounter: first.counter });
    expect(replay.ok).toBe(false);
    expect(replay.reason).toBe('replay');
  });

  it('rejects non-6-digit string', () => {
    const secret = generateSecret();
    expect(verifyCode({ secret, code: 'abcdef', lastUsedCounter: null }).ok).toBe(false);
    expect(verifyCode({ secret, code: '12345', lastUsedCounter: null }).ok).toBe(false);
    expect(verifyCode({ secret, code: '1234567', lastUsedCounter: null }).ok).toBe(false);
  });
});
