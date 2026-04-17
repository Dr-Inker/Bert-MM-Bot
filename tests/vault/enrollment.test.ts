import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateStore } from '../../src/stateStore.js';
import { DepositorStore } from '../../src/vault/depositorStore.js';
import { Enrollment } from '../../src/vault/enrollment.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Enrollment', () => {
  let dir: string;
  let state: StateStore;
  let store: DepositorStore;
  let enroll: Enrollment;
  const masterKey = Buffer.alloc(32, 42);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bertmm-'));
    state = new StateStore(join(dir, 'state.db'));
    state.init();
    store = new DepositorStore(state);
    enroll = new Enrollment({ store, masterKey, ensureAta: async () => {} });
  });
  afterEach(() => { state.close(); rmSync(dir, { recursive: true, force: true }); });

  it('accept() creates a user with encrypted deposit key', async () => {
    await enroll.accept({ telegramId: 1, now: 100 });
    const u = store.getUser(1);
    expect(u).toBeTruthy();
    expect(u!.role).toBe('depositor');
    expect(u!.totpEnrolledAt).toBeNull();
    const s = store.getUserSecrets(1);
    expect(s!.depositSecretEnc.length).toBeGreaterThan(0);
    expect(s!.depositSecretIv.length).toBe(12);
  });

  it('beginTotpEnrollment returns a secret + uri for the user', async () => {
    await enroll.accept({ telegramId: 2, now: 100 });
    const r = await enroll.beginTotpEnrollment({ telegramId: 2 });
    expect(r.uri).toMatch(/^otpauth:\/\//);
    expect(r.secretBase32).toMatch(/^[A-Z2-7]+=*$/);
  });

  it('confirmTotp accepts a valid code and persists totp secret', async () => {
    await enroll.accept({ telegramId: 3, now: 100 });
    const { secretBase32 } = await enroll.beginTotpEnrollment({ telegramId: 3 });
    const { TOTP } = await import('otpauth');
    const code = new TOTP({ secret: secretBase32 }).generate();
    const ok = await enroll.confirmTotp({ telegramId: 3, code, now: 200 });
    expect(ok).toBe(true);
    const u = store.getUser(3)!;
    expect(u.totpEnrolledAt).toBe(200);
    expect(u.totpLastUsedCounter).toBeGreaterThan(0);
  });

  it('confirmTotp rejects bad code', async () => {
    await enroll.accept({ telegramId: 4, now: 100 });
    await enroll.beginTotpEnrollment({ telegramId: 4 });
    const ok = await enroll.confirmTotp({ telegramId: 4, code: '000000', now: 200 });
    expect(ok).toBe(false);
  });

  it('accept() is idempotent (second call is a no-op)', async () => {
    await enroll.accept({ telegramId: 5, now: 100 });
    await enroll.accept({ telegramId: 5, now: 200 });
    const u = store.getUser(5)!;
    expect(u.disclaimerAt).toBe(100);  // unchanged
  });

  it('after beginTotpEnrollment (before confirm), getUser still reports totpEnrolledAt === null', async () => {
    await enroll.accept({ telegramId: 6, now: 100 });
    await enroll.beginTotpEnrollment({ telegramId: 6 });
    const u = store.getUser(6)!;
    expect(u.totpEnrolledAt).toBeNull();
  });
});
