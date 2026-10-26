// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// MFA seed encryption. Release 1: an encrypted seed is read back,
// a plaintext seed is unchanged, and an unreadable seed is recorded rather than
// silently failing the login. Release 2: writes are encrypted and
// old plaintext seeds are converted at boot. POSTGRES ONLY.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createCipheriv, randomBytes, scryptSync } from 'crypto';

process.env.CCC_ENCRYPTION_KEY = 'test-key-for-totp-seed-read';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let cleanup: () => Promise<void>;
let sqlTag: typeof import('drizzle-orm').sql;
let q: typeof import('@/lib/db/admin-queries');
let secrets: typeof import('@/lib/auth/secrets');
let totp: typeof import('@/lib/auth/totp');

async function run(text: string): Promise<Array<Record<string, unknown>>> {
  const r = await db.execute(sqlTag.raw(text));
  return (r.rows ?? r) as Array<Record<string, unknown>>;
}
function encryptWithOtherKey(plain: string): string {
  const key = scryptSync('another-key', 'ccc-config-encryption-v1', 32);
  const iv = randomBytes(16);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `enc:${Buffer.concat([iv, enc, c.getAuthTag()]).toString('base64')}`;
}

describe('MFA seed encryption (postgres)', () => {
  beforeAll(async () => {
    const { createTestDbClient } = await import('./helpers/db');
    const c = await createTestDbClient('postgres');
    db = c.client; cleanup = c.cleanup;
    sqlTag = (await import('drizzle-orm')).sql;
    q = await import('@/lib/db/admin-queries');
    secrets = await import('@/lib/auth/secrets');
    totp = await import('@/lib/auth/totp');
  }, 180_000);
  afterAll(async () => { if (cleanup) await cleanup(); });
  beforeEach(async () => {
    await run(`DELETE FROM error_events`);
    await run(`DELETE FROM admin_users WHERE id = 'mfa-u1'`);
    await run(`INSERT INTO admin_users (id, email, role, password_hash) VALUES ('mfa-u1', 'mfa-u1@test.local', 'admin', 'x')`);
  });

  it('seeds are base32, so a plaintext seed can never look encrypted', () => {
    const seed = totp.generateTotpSecret();
    expect(seed).toMatch(/^[A-Z2-7]+=*$/);
    expect(secrets.isEncrypted(seed)).toBe(false);
  });

  it('enableTotp stores the seed encrypted, and it reads back unchanged', async () => {
    await q.enableTotp('mfa-u1', 'JBSWY3DPEHPK3PXP', []);
    const stored = String((await run(`SELECT totp_secret FROM admin_users WHERE id = 'mfa-u1'`))[0].totp_secret);
    expect(stored.startsWith('enc:')).toBe(true);
    expect(stored).not.toContain('JBSWY3DPEHPK3PXP');
    expect(await q.getTotpStatus('mfa-u1')).toEqual({ enabled: true, secret: 'JBSWY3DPEHPK3PXP' }); // gitleaks:allow (example seed)
  });

  it('a plaintext seed (written before release 2) still reads back unchanged', async () => {
    await run(`UPDATE admin_users SET totp_secret = 'JBSWY3DPEHPK3PXP', totp_enabled = 1 WHERE id = 'mfa-u1'`);
    expect(await q.getTotpStatus('mfa-u1')).toEqual({ enabled: true, secret: 'JBSWY3DPEHPK3PXP' }); // gitleaks:allow (example seed)
  });

  it('boot conversion encrypts plaintext seeds only, and running it again changes nothing', async () => {
    await run(`DELETE FROM admin_users WHERE id IN ('mfa-u2', 'mfa-u3')`);
    const already = secrets.encryptSecret('KRSXG5CTMVRXEZLU');
    await run(`UPDATE admin_users SET totp_secret = 'JBSWY3DPEHPK3PXP', totp_enabled = 1 WHERE id = 'mfa-u1'`);
    await run(`INSERT INTO admin_users (id, email, role, password_hash, totp_secret, totp_enabled) VALUES ('mfa-u2', 'mfa-u2@test.local', 'admin', 'x', '${already}', 1)`);
    await run(`INSERT INTO admin_users (id, email, role, password_hash) VALUES ('mfa-u3', 'mfa-u3@test.local', 'admin', 'x')`);

    expect(await q.encryptStoredTotpSeeds()).toEqual({ encrypted: 1 });
    const rows = await run(`SELECT id, totp_secret FROM admin_users WHERE id IN ('mfa-u1', 'mfa-u2', 'mfa-u3') ORDER BY id`);
    expect(String(rows[0].totp_secret).startsWith('enc:')).toBe(true);
    expect(rows[1].totp_secret).toBe(already);
    expect(rows[2].totp_secret).toBeNull();
    expect(await q.getTotpStatus('mfa-u1')).toEqual({ enabled: true, secret: 'JBSWY3DPEHPK3PXP' }); // gitleaks:allow (example seed)
    expect(await q.getTotpStatus('mfa-u2')).toEqual({ enabled: true, secret: 'KRSXG5CTMVRXEZLU' }); // gitleaks:allow (example seed)
    expect(await q.getTotpStatus('mfa-u3')).toEqual({ enabled: false, secret: null });

    expect(await q.encryptStoredTotpSeeds()).toEqual({ encrypted: 0 });
    expect((await run(`SELECT totp_secret FROM admin_users WHERE id = 'mfa-u2'`))[0].totp_secret).toBe(already);
    await run(`DELETE FROM admin_users WHERE id IN ('mfa-u2', 'mfa-u3')`);
  });

  it('a converted seed still verifies a real TOTP code', async () => {
    const seed = totp.generateTotpSecret();
    await run(`UPDATE admin_users SET totp_secret = '${seed}', totp_enabled = 1 WHERE id = 'mfa-u1'`);
    await q.encryptStoredTotpSeeds();
    const { secret } = await q.getTotpStatus('mfa-u1');
    expect(secret).toBe(seed);
    expect(totp.verifyTotpCode(totp.currentTotpCode(seed), secret!)).toBe(true);
  });

  it('disableTotp clears an encrypted seed', async () => {
    await q.enableTotp('mfa-u1', 'JBSWY3DPEHPK3PXP', []);
    await q.disableTotp('mfa-u1');
    expect(await q.getTotpStatus('mfa-u1')).toEqual({ enabled: false, secret: null });
  });

  it('an encrypted seed is decrypted on read', async () => {
    const enc = secrets.encryptSecret('JBSWY3DPEHPK3PXP');
    await run(`UPDATE admin_users SET totp_secret = '${enc}', totp_enabled = 1 WHERE id = 'mfa-u1'`);
    expect(await q.getTotpStatus('mfa-u1')).toEqual({ enabled: true, secret: 'JBSWY3DPEHPK3PXP' }); // gitleaks:allow (example seed)
  });

  it('an undecryptable seed returns no secret and is recorded, without the seed', async () => {
    await run(`UPDATE admin_users SET totp_secret = '${encryptWithOtherKey('JBSWY3DPEHPK3PXP')}', totp_enabled = 1 WHERE id = 'mfa-u1'`);
    expect(await q.getTotpStatus('mfa-u1')).toEqual({ enabled: true, secret: null });
    await new Promise(r => setTimeout(r, 300));
    const ev = await run(`SELECT message FROM error_events WHERE source = 'totp-seed'`);
    expect(ev).toHaveLength(1);
    expect(String(ev[0].message)).toContain('mfa-u1');
    expect(String(ev[0].message)).not.toContain('JBSWY3DPEHPK3PXP');
  });
});
