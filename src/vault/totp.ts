import { TOTP, Secret } from 'otpauth';

const STEP_SEC = 30;
const DIGITS = 6;
const WINDOW = 1; // ±1 step tolerance

/** Generate a 160-bit base32 secret. */
export function generateSecret(): string {
  return new Secret({ size: 20 }).base32;
}

/** Build an otpauth:// URI for QR codes. */
export function otpauthUri(args: { secret: string; label: string; issuer: string }): string {
  const totp = new TOTP({
    issuer: args.issuer,
    label: args.label,
    algorithm: 'SHA1',
    digits: DIGITS,
    period: STEP_SEC,
    secret: args.secret,
  });
  return totp.toString();
}

/** Current TOTP counter (integer seconds / step). */
export function currentCounter(): number {
  return Math.floor(Date.now() / 1000 / STEP_SEC);
}

export interface VerifyResult {
  ok: boolean;
  counter: number;       // the accepted counter (only meaningful if ok)
  reason?: 'bad_format' | 'invalid' | 'replay';
}

/** Verify a 6-digit code. Enforces non-decreasing counter to block replay. */
export function verifyCode(args: {
  secret: string;
  code: string;
  lastUsedCounter: number | null;
}): VerifyResult {
  if (!/^\d{6}$/.test(args.code)) {
    return { ok: false, counter: -1, reason: 'bad_format' };
  }
  const totp = new TOTP({ algorithm: 'SHA1', digits: DIGITS, period: STEP_SEC, secret: args.secret });
  const delta = totp.validate({ token: args.code, window: WINDOW });
  if (delta === null) return { ok: false, counter: -1, reason: 'invalid' };
  const matchedCounter = currentCounter() + delta;
  if (args.lastUsedCounter !== null && matchedCounter <= args.lastUsedCounter) {
    return { ok: false, counter: matchedCounter, reason: 'replay' };
  }
  return { ok: true, counter: matchedCounter };
}
