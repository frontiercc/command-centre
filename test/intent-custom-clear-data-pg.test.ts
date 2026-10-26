// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Postgres coverage for two lib stragglers:
//   1. lib/intent/custom.ts getCustomCategories/saveCustomCategories — proves
//      the onConflictDoUpdate config-table upsert round-trips on Postgres.
//   2. lib/admin/clear-data.ts clearAuditAndAlerts — proves the withTx-wrapped
//      FK-safe multi-table clear (pulse_classifications/pulse_events/
//      pulse_skill_runs deleted BEFORE their parent cowork_messages) empties
//      every cleared table and preserves compliance_events/auth_events.
//
// HARNESS RULE (see other *-pg.test.ts files): the modules under test import
// `schema` from lib/db/schema.ts, and the database client binds to DATABASE_URL on first use — so
// schema + the modules under test are DYNAMIC-imported AFTER
// createTestDbClient() has set the DB env + reset modules. Postgres runs the
// full migrations-pg set via startPg(), so no manual DDL is needed.
import { describe, it, expect } from 'vitest';

async function runSpec(): Promise<void> {
  const { createTestDbClient } = await import('./helpers/db');
  const { client, cleanup } = await createTestDbClient('postgres');

  try {
    // No `process.__ccc_db` shim is needed — getCustomCategories/
    // saveCustomCategories/clearAuditAndAlerts all call getTypedClient()
    // themselves, so they
    // share the SAME process-singleton connection `client` already is.

    // Dynamic imports AFTER the DB env + module reset (harness rule).
    const { schema } = await import('@/lib/db/schema');
    const { getCustomCategories, saveCustomCategories } = await import('@/lib/intent/custom');
    const { clearAuditAndAlerts, CLEARED_TABLES } = await import('@/lib/admin/clear-data');
    const { eq } = await import('drizzle-orm');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = client as any;

    // ══════════════════════════════════════════════════════════════════════
    // getCustomCategories / saveCustomCategories round-trip
    // ══════════════════════════════════════════════════════════════════════
    expect(await getCustomCategories()).toEqual([]);

    await saveCustomCategories([{
      id: 'phi_request', name: 'PHI Request', description: 'Protected health information requests',
      phrases: ['patient records', 'medical history'], defaultSeverity: 'critical' as const,
      builtIn: false, enabled: true,
    }]);
    const first = await getCustomCategories();
    expect(first).toHaveLength(1);
    expect(first[0].id).toBe('phi_request');
    expect(first[0].phrases).toContain('patient records');

    // onConflictDoUpdate — a second save OVERWRITES rather than duplicating
    // the config row.
    await saveCustomCategories([{
      id: 'second', name: 'Second', description: 'test',
      phrases: ['new phrase'], defaultSeverity: 'high' as const, builtIn: false, enabled: true,
    }]);
    const second = await getCustomCategories();
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe('second');
    const configRows = await db.select().from(schema.config).where(eq(schema.config.key, 'intent_custom_categories'));
    expect(configRows.length).toBe(1); // exactly one row — proves no duplicate insert on re-save

    // ══════════════════════════════════════════════════════════════════════
    // clearAuditAndAlerts — FK-safe multi-table clear
    // ══════════════════════════════════════════════════════════════════════
    const NOW = Math.floor(Date.now() / 1000);
    await db.insert(schema.users).values({ id: 'u1', email: 'u1@test.local', source: 'otel', first_seen_at: NOW, last_seen_at: NOW });
    await db.insert(schema.coworkMessages).values({ id: 'm1', session_id: 's1', user_id: 'u1', message_type: 'cowork_user_message', occurred_at: NOW });
    await db.insert(schema.pulseClassifications).values({
      cowork_message_id: 'm1', user_id: 'u1', tier: 2, task_type: 'feature',
      classifier_confidence: 0.9, classifier_model: 'haiku', classified_at: NOW,
    });
    await db.insert(schema.coworkSkillInvocations).values({ id: 'sk1', user_id: 'u1', session_id: 's1', skill_name: 'test-skill', occurred_at: NOW });
    await db.insert(schema.coworkMcpInvocations).values({ id: 'mc1', user_id: 'u1', session_id: 's1', mcp_server: 'slack', mcp_tool: 'send', occurred_at: NOW });
    await db.insert(schema.codeAssistantMeta).values({ id: 'ca1', user_id: 'u1', session_id: 's1', occurred_at: NOW });
    await db.insert(schema.chatMessages).values({ id: 'ch1', user_id: 'u1', prompt_text: 'hi', prompt_length: 2, occurred_at: NOW });
    await db.insert(schema.alerts).values({ id: 'a1', alert_type: 'anomaly', severity: 'high', title: 't', explanation: 'e' });
    // Preserve checks — NOT in CLEARED_TABLES, must survive the clear.
    await db.insert(schema.complianceEvents).values({ id: 'ce1', event_type: 'access', surface: 'cowork', occurred_at: NOW });
    await db.insert(schema.authEvents).values({ event_type: 'admin_login_failed' });

    const counts = await clearAuditAndAlerts();
    // Every seeded table shows a non-zero delete count (pulse_events/
    // pulse_skill_runs weren't seeded — those two just prove the atomic
    // multi-table transaction completes across ALL CLEARED_TABLES, including
    // ones that start empty).
    for (const table of ['pulse_classifications', 'cowork_skill_invocations', 'cowork_mcp_invocations', 'code_assistant_meta', 'cowork_messages', 'chat_messages', 'alerts'] as const) {
      expect(counts[table]).toBeGreaterThanOrEqual(1);
    }
    expect(CLEARED_TABLES).toContain('pulse_events');
    expect(CLEARED_TABLES).toContain('pulse_skill_runs');

    expect((await db.select().from(schema.coworkMessages)).length).toBe(0);
    expect((await db.select().from(schema.pulseClassifications)).length).toBe(0);
    expect((await db.select().from(schema.alerts)).length).toBe(0);
    expect((await db.select().from(schema.coworkSkillInvocations)).length).toBe(0);
    expect((await db.select().from(schema.coworkMcpInvocations)).length).toBe(0);
    expect((await db.select().from(schema.codeAssistantMeta)).length).toBe(0);
    expect((await db.select().from(schema.chatMessages)).length).toBe(0);

    // Preserved — NOT cleared.
    expect((await db.select().from(schema.complianceEvents)).length).toBe(1);
    expect((await db.select().from(schema.authEvents)).length).toBe(1);
  } finally {
    await cleanup();
  }
}

describe('intent-custom + clear-data (postgres)', () => {
  it(
    'getCustomCategories/saveCustomCategories round-trip + clearAuditAndAlerts FK-safe clear on postgres',
    async () => {
      await runSpec();
    },
    180_000,
  );
});
