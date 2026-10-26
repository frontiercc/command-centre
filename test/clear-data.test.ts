// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;
let mod: typeof import('@/lib/admin/clear-data');

beforeAll(async () => {
  const t = await createTestDatabase();
  sql = t.sql; cleanup = t.cleanup;
  mod = await import('@/lib/admin/clear-data');
});
afterAll(async () => cleanup());

describe('clearAuditAndAlerts — audit log view + alert view', () => {
  it('does NOT clear the security/compliance audit trail', () => {
    expect(mod.CLEARED_TABLES).not.toContain('compliance_events');
    expect(mod.CLEARED_TABLES).not.toContain('auth_events');
  });

  it('clears the audit/alert tables + the FK-child pulse records, in FK-safe order', async () => {
    const t = mod.CLEARED_TABLES as readonly string[];
    for (const expected of ['cowork_messages', 'chat_messages', 'alerts', 'pulse_classifications', 'pulse_events', 'pulse_skill_runs']) {
      expect(t).toContain(expected);
    }
    // FK-children must be deleted before their parent cowork_messages
    for (const child of ['pulse_classifications', 'pulse_events', 'pulse_skill_runs']) {
      expect(t.indexOf(child)).toBeLessThan(t.indexOf('cowork_messages'));
    }
    // clearAuditAndAlerts is now async and takes no arguments —
    // it always resolves its own typed client, which (via
    // getClient()'s process-singleton) reads the SAME database `sql` (from
    // createTestDatabase()) points at.
    const counts = await mod.clearAuditAndAlerts(); // every table name valid on the live schema
    expect(counts).toBeDefined();
  });

  it('REGRESSION: clears cowork_messages even when a pulse record FK-references it (no FK error)', async () => {
    // Reproduces the original "FOREIGN KEY constraint failed" bug.
    // Postgres always enforces foreign keys.
    const now = Math.floor(Date.now() / 1000);
    await sql.run(`INSERT INTO users (id, email, display_name, source, first_seen_at, last_seen_at) VALUES ('u','u@test','U','otel', ?, ?)`, [now, now]);
    await sql.run(`INSERT INTO cowork_messages (id, user_id, session_id, message_type, occurred_at) VALUES ('m1','u','s','cowork_user_message', ?)`, [now]);
    await sql.run(`INSERT INTO pulse_classifications (cowork_message_id, user_id, tier, task_type, classifier_confidence, classifier_model, classified_at)
                VALUES ('m1','u',2,'feature',0.9,'haiku', ?)`, [now]);
    await sql.run(`INSERT INTO alerts (id, alert_type, severity, title, explanation) VALUES ('a1','anomaly','high','t','e')`);
    // Preserve checks (explicit id: Postgres's TEXT PRIMARY KEY rejects NULL)
    await sql.run(`INSERT INTO compliance_events (id, event_type, surface, occurred_at) VALUES ('ce1','access','cowork', ?)`, [now]);
    await sql.run(`INSERT INTO auth_events (event_type) VALUES ('admin_login_failed')`);

    await mod.clearAuditAndAlerts();

    const n = async (t: string) => ((await sql.get(`SELECT COUNT(*) n FROM ${t}`)) as { n: number }).n;
    expect(await n('cowork_messages')).toBe(0);
    expect(await n('pulse_classifications')).toBe(0);
    expect(await n('alerts')).toBe(0);
    // Security/compliance preserved
    expect(await n('compliance_events')).toBe(1);
    expect(await n('auth_events')).toBe(1);
  });
});
