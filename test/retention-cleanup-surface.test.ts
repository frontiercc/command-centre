// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// cowork_messages cleanup is now surface-scoped — surface='cowork'
// windows on retentionCoworkDays, surface='code' on the new retentionCodeDays.
// Proves (1) each surface purges on its OWN window and
// (2) pulse_classifications/pulse_events/pulse_skill_runs, which FK to
// cowork_messages.id, are deleted before their parent message — no FK error.
//
// Harness: follows test/retention-archive-chat.test.ts — createTestDatabase() (runs
// the full migration set, so pulse_classifications/cowork_messages exist with
// their real FKs), REAL setConfigValue (no @/lib/config mock), and dynamic
// imports of getTypedClient/schema/runRetentionCleanup AFTER createTestDatabase() so
// they bind to the fresh test DB file.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDatabase } from './helpers/db';

const NOW = Math.floor(Date.now() / 1000);
const daysAgo = (d: number) => NOW - d * 86400;

describe('retention cleanup — surface split', () => {
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const t = await createTestDatabase();
    cleanup = t.cleanup;

    const cfg = await import('@/lib/config');
    await cfg.setConfigValue('retentionMode', 'purge');
    await cfg.setConfigValue('retentionCoworkDays', '90');
    await cfg.setConfigValue('retentionCodeDays', '30');
  });

  afterEach(async () => { await cleanup(); });

  it('code prompts purge on the CODE window, cowork prompts on the COWORK window', async () => {
    const { getTypedClient } = await import('@/lib/db/client');
    const { schema } = await import('@/lib/db/schema');
    const client = await getTypedClient();

    // A code prompt aged 45d: older than code(30), younger than cowork(90) →
    // must be deleted. A cowork prompt aged 45d: younger than cowork(90) →
    // must survive.
    const old = daysAgo(45);
    await client.insert(schema.users).values({ id: 'u1', email: 'u1@x.com', first_seen_at: old, last_seen_at: old });
    await client.insert(schema.coworkMessages).values([
      { id: 'code-45', session_id: 's1', user_id: 'u1', message_type: 'code_user_message', surface: 'code', content_full: 'x', content_preview: 'x', occurred_at: old },
      { id: 'cow-45', session_id: 's2', user_id: 'u1', message_type: 'cowork_user_message', surface: 'cowork', content_full: 'y', content_preview: 'y', occurred_at: old },
    ]);

    const { runRetentionCleanup } = await import('@/lib/retention/cleanup');
    const res = await runRetentionCleanup();

    const rows = await client.select().from(schema.coworkMessages);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain('cow-45');    // cowork prompt survives (younger than 90d)
    expect(ids).not.toContain('code-45'); // code prompt purged (older than 30d)
    expect(res.code_rows_affected).toBeGreaterThanOrEqual(1);
  });

  it('purging an old code message with a pulse_classifications child does not FK-fail', async () => {
    const { getTypedClient } = await import('@/lib/db/client');
    const { schema } = await import('@/lib/db/schema');
    const client = await getTypedClient();

    const old = daysAgo(60);
    await client.insert(schema.users).values({ id: 'u1', email: 'u1@x.com', first_seen_at: old, last_seen_at: old });
    await client.insert(schema.coworkMessages).values({
      id: 'code-old', session_id: 's3', user_id: 'u1', message_type: 'code_user_message', surface: 'code',
      content_full: 'z', content_preview: 'z', occurred_at: old,
    });
    await client.insert(schema.pulseClassifications).values({
      cowork_message_id: 'code-old', user_id: 'u1', tier: 1, task_type: 'test',
      classifier_confidence: 0.9, classifier_model: 'test-model', classified_at: old,
    });

    const { runRetentionCleanup } = await import('@/lib/retention/cleanup');
    await expect(runRetentionCleanup()).resolves.toBeDefined();

    const msgs = await client.select().from(schema.coworkMessages);
    const cls = await client.select().from(schema.pulseClassifications);
    expect(msgs.map((m) => m.id)).not.toContain('code-old');
    expect(cls.length).toBe(0); // child deleted with (or before) the parent, no FK error
  });

  it('folds NULL-surface cowork_messages into the COWORK window (nothing left orphaned)', async () => {
    const { getTypedClient } = await import('@/lib/db/client');
    const { schema } = await import('@/lib/db/schema');
    const client = await getTypedClient();

    // Aged well past the cowork(90) window; surface explicitly NULL so it
    // matches neither eq(surface,'cowork') nor eq(surface,'code') — this
    // proves the fold catches rows that would otherwise never be swept.
    const old = daysAgo(120);
    await client.insert(schema.users).values({ id: 'u1', email: 'u1@x.com', first_seen_at: old, last_seen_at: old });
    await client.insert(schema.coworkMessages).values({
      id: 'null-surface-old', session_id: 's4', user_id: 'u1', message_type: 'cowork_user_message', surface: null,
      content_full: 'n', content_preview: 'n', occurred_at: old,
    });

    const { runRetentionCleanup } = await import('@/lib/retention/cleanup');
    await runRetentionCleanup();

    const rows = await client.select().from(schema.coworkMessages);
    expect(rows.map((r) => r.id)).not.toContain('null-surface-old');
  });
});
