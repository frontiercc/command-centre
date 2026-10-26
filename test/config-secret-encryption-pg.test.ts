// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Sensitive config values are encrypted at rest,
// read back transparently, converted at boot, and fail LOUDLY
// when they cannot be decrypted. POSTGRES ONLY.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createCipheriv, randomBytes, scryptSync } from 'crypto';

process.env.CCC_ENCRYPTION_KEY = 'test-key-for-config-secret-encryption';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let cleanup: () => Promise<void>;
let sqlTag: typeof import('drizzle-orm').sql;
let cfg: typeof import('@/lib/config');

async function run(text: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> {
  let q = text;
  params.forEach((p, i) => { q = q.replace(`$${i + 1}`, `'${String(p).replace(/'/g, "''")}'`); });
  const r = await db.execute(sqlTag.raw(q));
  return (r.rows ?? r) as Array<Record<string, unknown>>;
}
const raw = async (dbKey: string) => (await run(`SELECT value FROM config WHERE key = $1`, [dbKey]))[0]?.value as string | undefined;

/** An enc: value made with a DIFFERENT key — what a changed CCC_ENCRYPTION_KEY looks like. */
function encryptWithOtherKey(plain: string): string {
  const key = scryptSync('some-other-key', 'ccc-config-encryption-v1', 32);
  const iv = randomBytes(16);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `enc:${Buffer.concat([iv, enc, c.getAuthTag()]).toString('base64')}`;
}

describe('config secrets encrypted at rest (postgres)', () => {
  beforeAll(async () => {
    const { createTestDbClient } = await import('./helpers/db');
    const c = await createTestDbClient('postgres');
    db = c.client; cleanup = c.cleanup;
    sqlTag = (await import('drizzle-orm')).sql;
    cfg = await import('@/lib/config');
  }, 180_000);
  afterAll(async () => { if (cleanup) await cleanup(); });
  beforeEach(async () => { await run(`DELETE FROM config`); await run(`DELETE FROM error_events`); });

  it('the encrypted set is exactly the secrets registry', async () => {
    const { SECRET_KEYS } = await import('@/lib/config-secrets');
    expect([...cfg.ENCRYPTED_CONFIG_KEYS].sort()).toEqual(Object.keys(SECRET_KEYS).sort());
  });

  it('setConfigValue encrypts a secret and reads it back; ordinary settings stay plain', async () => {
    await cfg.setConfigValue('githubToken', 'ghp_example_value');
    await cfg.setConfigValue('organisationName', 'Acme');
    expect(await raw('github_token')).toMatch(/^enc:/);
    expect(await raw('github_token')).not.toContain('ghp_example_value');
    expect(await cfg.getConfigValue('githubToken')).toBe('ghp_example_value');
    expect(await raw('organisation_name')).toBe('Acme');
    expect((await cfg.getAllConfig()).githubToken).toBe('ghp_example_value');
  });

  it('saveConfig encrypts secrets too, and never double-encrypts', async () => {
    await cfg.saveConfig({ smtpPassword: 'pw-1', digestSlackWebhookUrl: 'https://hooks.slack.com/x' });
    const once = await raw('smtp_password');
    expect(once).toMatch(/^enc:/);
    expect(await cfg.getConfigValue('smtpPassword')).toBe('pw-1');
    await cfg.saveConfig({ smtpPassword: once! });
    expect(await raw('smtp_password')).toBe(once);
    expect(await cfg.getConfigValue('digestSlackWebhookUrl')).toBe('https://hooks.slack.com/x');
  });

  it('encryptStoredSecrets converts plaintext rows once and is safe to re-run', async () => {
    await run(`INSERT INTO config (key, value) VALUES ('compliance_access_key', 'sk-ant-api01-plain'), ('organisation_name', 'Acme')`);
    expect(await cfg.encryptStoredSecrets()).toEqual({ encrypted: 1 });
    expect(await raw('compliance_access_key')).toMatch(/^enc:/);
    expect(await raw('organisation_name')).toBe('Acme');
    expect(await cfg.getConfigValue('complianceAccessKey')).toBe('sk-ant-api01-plain');
    expect(await cfg.encryptStoredSecrets()).toEqual({ encrypted: 0 });
  });

  it('a value this server cannot decrypt is reported, never silent', async () => {
    await run(`INSERT INTO config (key, value) VALUES ('github_token', $1)`, [encryptWithOtherKey('ghp_old')]);
    expect(await cfg.getConfigValue('githubToken')).toBe('');
    expect(await cfg.getUnreadableSecretKeys()).toEqual(['githubToken']);
    await new Promise(r => setTimeout(r, 300));
    const ev = await run(`SELECT source, message FROM error_events WHERE source = 'config-secret'`);
    expect(ev).toHaveLength(1);
    expect(String(ev[0].message)).toContain('githubToken');
    expect(String(ev[0].message)).not.toContain('ghp_old');
  });
});
