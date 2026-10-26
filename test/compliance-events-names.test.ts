// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Regression test for the Audit Log bug: getComplianceEvents (lib/db/queries.ts)
// joined `users` only to support the department filter and never selected
// display_name, so compliance-source audit rows showed the raw user_id UUID
// while cowork/chat/skill rows (built via getCoworkEventsForAudit /
// getSkillConnectorEventsForAudit in app/api/events/route.ts) showed real
// names. The fix adds the same admin_users-linked-cowork-user-id join those
// builders use (admin_users wins over users) and resolves the returned
// user_id to COALESCE(admin display_name, user display_name), falling back
// to the raw stored id when no name is found anywhere.
//
// Second regression (v0.34.x): the same query never selected a department,
// so every compliance_events row rendered "—" in the Audit Log's Department
// column even when the user had one (found on the demo deployment's seeded audit
// view). getComplianceEvents now returns `department` resolved the same way
// as the name: COALESCE(admin_users.department, users.department), null when
// no user row matches anywhere.
//
// HARNESS RULE (copied from queries-alerts-pg.test.ts / queries-cowork-chat-
// gdpr-pg.test.ts): queries.ts reaches the database through getClient(),
// which binds to DATABASE_URL on first use, so the module-under-test
// (and schema) are DYNAMIC-imported AFTER createTestDbClient('postgres') has
// set DATABASE_URL + reset modules. The database is fully migrated, so no
// hand DDL is needed.
import { describe, it, expect } from 'vitest';

const NOW = Math.floor(Date.now() / 1000);

async function runSpec(): Promise<void> {
  const { createTestDbClient } = await import('./helpers/db');
  const { client, cleanup } = await createTestDbClient('postgres');
  try {
    // Dynamic import AFTER the DATABASE_URL env + module reset (harness rule).
    const { schema } = await import('@/lib/db/schema');
    const { getComplianceEvents } = await import('@/lib/db/queries');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = client as any;

    const namedUserId = 'cd065c14-0000-4000-8000-000000000001';
    const orphanUserId = 'cd065c14-0000-4000-8000-000000000002';
    const adminLinkedUserId = 'cd065c14-0000-4000-8000-000000000003';

    // compliance_events.user_id carries an FK to users on Postgres, so the
    // "no name found anywhere" case is a users row with no display_name or
    // department (and no linked admin row) rather than a dangling id.
    await db.insert(schema.users).values([
      { id: namedUserId, email: 'mark@test.local', display_name: 'Hugo Lambert', department: 'Eng' },
      { id: orphanUserId, email: 'orphan@test.local', display_name: null, department: null },
      { id: adminLinkedUserId, email: 'ana@test.local', display_name: 'Lucas Pereira', department: 'Sales' },
    ]);
    await db.insert(schema.adminUsers).values([
      {
        id: 'admin-1', email: 'ana.admin@test.local', password_hash: 'x',
        display_name: 'Ana C. (Admin)', department: 'RevOps', linked_cowork_user_id: adminLinkedUserId,
      },
    ]);

    await db.insert(schema.complianceEvents).values([
      {
        id: 'ce-named', user_id: namedUserId, event_type: 'compliance_event', surface: 'chat',
        content_preview: 'hello', metadata: null, flagged: 0, occurred_at: NOW - 60,
      },
      {
        id: 'ce-orphan', user_id: orphanUserId, event_type: 'compliance_event', surface: 'chat',
        content_preview: 'hi', metadata: null, flagged: 0, occurred_at: NOW - 30,
      },
      {
        id: 'ce-admin-linked', user_id: adminLinkedUserId, event_type: 'compliance_event', surface: 'chat',
        content_preview: 'hey', metadata: null, flagged: 0, occurred_at: NOW - 10,
      },
    ]);

    const events = await getComplianceEvents({});
    expect(events.length).toBe(3);

    // Newest-first (ORDER BY occurred_at DESC): ce-admin-linked, ce-orphan, ce-named.
    const orphanRow = events.find((e) => e.id === 'ce-orphan');
    const namedRow = events.find((e) => e.id === 'ce-named');
    const adminLinkedRow = events.find((e) => e.id === 'ce-admin-linked');

    // Resolved to the display name — the bug: this used to be the raw UUID.
    expect(namedRow?.user_id).toBe('Hugo Lambert');

    // No name on any matching row → falls back to the raw stored id, no crash.
    expect(orphanRow?.user_id).toBe(orphanUserId);

    // Department resolution (second regression): users-table department comes
    // through; admin_users department wins when the admin row is linked; no
    // department anywhere → null (page renders the em-dash).
    expect(namedRow?.department).toBe('Eng');
    expect(adminLinkedRow?.department).toBe('RevOps');
    expect(adminLinkedRow?.user_id).toBe('Ana C. (Admin)');
    expect(orphanRow?.department).toBeNull();
  } finally {
    await cleanup();
  }
}

describe('getComplianceEvents — display name resolution (audit log)', () => {
  it(
    'resolves compliance_events.user_id to the joined display name, falling back to the raw id when no name is found',
    async () => {
      await runSpec();
    },
    30_000,
  );
});
