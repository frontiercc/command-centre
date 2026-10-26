// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Postgres coverage for lib/config.ts (getConfigValue /
// setConfigValue / getAllConfig / saveConfig over the `config` table).
//
// Runs against Postgres (testcontainers postgres:16, or the shared server
// named by CCC_TEST_PG_URL); skipped (not failed) without Docker.
// createTestDbClient('postgres') already ran the full lib/db/migrations-pg
// set via startPg(), so no per-test DDL is needed.
//
// HARNESS RULE (copied from admin-queries-pg.test.ts):
// lib/config.ts reaches the database through getClient(), which binds to
// DATABASE_URL on first use — so the module-under-test (and `schema`) is
// DYNAMIC-imported AFTER createTestDbClient() has set DATABASE_URL + reset
// modules.
//
// Encrypted-secret coverage: config.ts's SENSITIVE_KEYS route reads through
// decryptSecret() (lib/auth/secrets.ts). Writes
// ENCRYPT again (see config.ts's header comment), and an existing
// `enc:`-prefixed row must still decrypt back to the original on read. CCC_ENCRYPTION_KEY is pinned to a
// fixed test passphrase so encryptSecret()/decryptSecret() never fall through
// to the auto-generate-and-persist-to-.env.local branch during a test run.
import { describe, it, expect } from 'vitest';

async function runSpec(): Promise<void> {
  // Fixed passphrase — never let secrets.ts auto-generate/persist a key to
  // the real .env.local as a side effect of running this test.
  process.env.CCC_ENCRYPTION_KEY = 'test-passphrase-config-pg-test-only';

  const { createTestDbClient } = await import('./helpers/db');
  const { client, cleanup } = await createTestDbClient('postgres');
  try {
    // Dynamic import AFTER the DATABASE_URL env + module reset (harness rule).
    const cfg = await import('@/lib/config');
    const secrets = await import('@/lib/auth/secrets');

    // ── get/set round-trip ──────────────────────────────────────────────
    expect(await cfg.getConfigValue('organisationName')).toBe('');
    await cfg.setConfigValue('organisationName', 'Acme Corp');
    expect(await cfg.getConfigValue('organisationName')).toBe('Acme Corp');

    // ── upsert overwrites (same key, second write wins) ─────────────────
    await cfg.setConfigValue('organisationName', 'Acme Corp Renamed');
    expect(await cfg.getConfigValue('organisationName')).toBe('Acme Corp Renamed');
    // Only one row for the key — onConflictDoUpdate, not a second insert.
    const { schema } = await import('@/lib/db/schema');
    const { eq } = await import('drizzle-orm');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (client as any).select().from(schema.config).where(eq(schema.config.key, 'organisation_name'));
    expect(rows.length).toBe(1);
    expect(rows[0].value).toBe('Acme Corp Renamed');

    // ── getAllConfig reflects the same store, with typed defaults for unset keys ──
    await cfg.setConfigValue('retentionCoworkDays', '45');
    const all = await cfg.getAllConfig();
    expect(all.organisationName).toBe('Acme Corp Renamed');
    expect(all.retentionCoworkDays).toBe(45); // parsed to number
    expect(all.retentionOtelDays).toBe(30); // untouched key falls back to its documented default

    // ── saveConfig (multi-key transactional write via withTx) ────────────
    await cfg.saveConfig({ organisationName: 'Batch Co', retentionOtelDays: '60' });
    const afterBatch = await cfg.getAllConfig();
    expect(afterBatch.organisationName).toBe('Batch Co');
    expect(afterBatch.retentionOtelDays).toBe(60);

    // ── encrypted secret round-trip: decrypt-on-read survives on a LEGACY enc: row ──
    // Simulate a pre-existing encrypted row (written before encryption-at-rest
    // was retired) by inserting an `enc:`-prefixed value directly, bypassing
    // setConfigValue (which never encrypts on write today).
    const plaintext = 'sk-ant-legacy-secret-value-12345';
    const encrypted = secrets.encryptSecret(plaintext);
    expect(encrypted.startsWith('enc:')).toBe(true);
    const nowS = Math.floor(Date.now() / 1000);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any)
      .insert(schema.config)
      .values({ key: 'anthropic_ai_api_key', value: encrypted, updated_at: nowS })
      .onConflictDoUpdate({ target: schema.config.key, set: { value: encrypted, updated_at: nowS } });

    // getConfigValue on a SENSITIVE_KEYS member must decrypt transparently.
    expect(await cfg.getConfigValue('anthropicAiApiKey')).toBe(plaintext);
    // getAllConfig must decrypt the same key too (shared resolve() path).
    expect((await cfg.getAllConfig()).anthropicAiApiKey).toBe(plaintext);

    // A fresh setConfigValue on the same sensitive key is ENCRYPTED at rest
    // and reads back unchanged.
    await cfg.setConfigValue('anthropicAiApiKey', 'sk-ant-fresh-plaintext');
    expect(await cfg.getConfigValue('anthropicAiApiKey')).toBe('sk-ant-fresh-plaintext');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawRow = (await (client as any).select().from(schema.config).where(eq(schema.config.key, 'anthropic_ai_api_key')))[0];
    expect(rawRow.value).toMatch(/^enc:/); // encrypted at rest
    expect(rawRow.value).not.toContain('sk-ant-fresh-plaintext');
  } finally {
    await cleanup();
  }
}

describe('config (postgres)', () => {
  it(
    'get/set/getAll/saveConfig round-trip, upsert overwrites, and legacy enc: secret decrypt-on-read behave correctly on postgres',
    async () => {
      await runSpec();
    },
    180_000,
  );
});
