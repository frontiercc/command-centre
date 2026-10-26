// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Workflow Impact package — the inverse-join helper that lets a
// Library entry list the confirmed/candidate workflows it powers. Follows
// the seeding convention of test/usecases-impact-rollup.test.ts /
// test/usecases-impact-builder.test.ts (a per-file test database from
// createTestDatabase(), seeded via getTypedClient(); `wi-l-*` marker ids).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { inArray } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { findWorkflowsUsingSignal } from '@/lib/usecases/impact';
import { weekStarts } from '@/lib/pulse/period';
import { createTestDatabase } from './helpers/db';

const WEEK = 7 * 86400;
const WK = 1755475200; // a real Monday 00:00 UTC epoch, same convention as usecases-impact-builder.test.ts
// nowS chosen so weekStarts(nowS - WEEK, 13) is the ascending 13-week window starting at WK.
const NOW = WK + 13 * WEEK + 100;

const UC_MATCH = 'wi-l-uc-match';
const UC_ARCHIVED = 'wi-l-uc-archived';
const UC_SKILL = 'wi-l-uc-skill'; // uses the same name but as a SKILL, not a connector — kind mismatch

describe('findWorkflowsUsingSignal', () => {
  let cleanup: () => Promise<void>;

  afterAll(async () => cleanup());

  beforeAll(async () => {
    const testDb = await createTestDatabase();
    cleanup = testDb.cleanup;
    const client = await getTypedClient();

    // Clear this file's own marker rows first. Every insert below uses
    // onConflictDoNothing, so a row surviving from an earlier run keeps its OLD
    // values and the fixture silently never lands — a use case left at
    // lifecycle 'at_risk' by the tracker then fails the 'piloting' assertion,
    // and leftover week rows make the no-activity case count 1 instead of 0.
    // Written when this suite shared the default ./data/ccc.db; now it gets
    // its own test database, so this is a no-op kept as a guard. Children
    // before parents (no cascade).
    // Includes wi-l-uc-no-activity, which the last test creates inline — its
    // whole point is having NO week rows, so a leftover one from an earlier run
    // makes it count 1 user instead of 0.
    const ucIds = [UC_MATCH, UC_ARCHIVED, UC_SKILL, 'wi-l-uc-no-activity'];
    await client.delete(schema.useCaseWeekMatches).where(inArray(schema.useCaseWeekMatches.use_case_id, ucIds));
    await client.delete(schema.useCaseActivationWeeks).where(inArray(schema.useCaseActivationWeeks.use_case_id, ucIds));
    await client.delete(schema.useCases).where(inArray(schema.useCases.id, ucIds));

    // Library entry (scene-setting; the helper itself matches
    // on kind+name directly, not on the library entry row).
    await client.insert(schema.skillLibraryEntries).values({
      name: 'salesforce', type: 'connector', surface: 'cowork', source: 'org',
      is_published: 1, created_at: NOW, updated_at: NOW,
    } as never).onConflictDoNothing();

    await client.insert(schema.users).values({ id: 'wi-l-u1', email: 'wi-l-u1@test.local' } as never).onConflictDoNothing();
    await client.insert(schema.users).values({ id: 'wi-l-u2', email: 'wi-l-u2@test.local' } as never).onConflictDoNothing();

    // A confirmed, non-archived use case whose connectors rule includes 'salesforce'.
    await client.insert(schema.useCases).values({
      id: UC_MATCH, title: 'WI Library Match UC', status: 'confirmed', lifecycle: 'piloting',
      connectors: JSON.stringify(['salesforce']), skills: JSON.stringify([]),
      departments: JSON.stringify([]), surfaces: JSON.stringify([]), keywords: JSON.stringify([]), task_types: JSON.stringify([]),
      origin: 'planned', capture_method: 'guided', created_at: NOW, updated_at: NOW,
    } as never).onConflictDoNothing();

    // An archived use case that also matches on connectors — must be excluded.
    await client.insert(schema.useCases).values({
      id: UC_ARCHIVED, title: 'WI Library Archived UC', status: 'archived', lifecycle: 'not_seen',
      connectors: JSON.stringify(['salesforce']), skills: JSON.stringify([]),
      departments: JSON.stringify([]), surfaces: JSON.stringify([]), keywords: JSON.stringify([]), task_types: JSON.stringify([]),
      origin: 'planned', capture_method: 'guided', created_at: NOW, updated_at: NOW,
    } as never).onConflictDoNothing();

    // A confirmed use case where 'salesforce' is a SKILL, not a connector — a
    // kind mismatch, must be excluded from a kind:'connector' lookup.
    await client.insert(schema.useCases).values({
      id: UC_SKILL, title: 'WI Library Skill-Kind UC', status: 'confirmed', lifecycle: 'piloting',
      connectors: JSON.stringify([]), skills: JSON.stringify(['salesforce']),
      departments: JSON.stringify([]), surfaces: JSON.stringify([]), keywords: JSON.stringify([]), task_types: JSON.stringify([]),
      origin: 'planned', capture_method: 'guided', created_at: NOW, updated_at: NOW,
    } as never).onConflictDoNothing();

    // Junction rows for the matching use case, across two weeks in the
    // 13-week window — two distinct users, a measured last_seen_at.
    const windowStarts = weekStarts(NOW - WEEK, 13);
    const wk0 = windowStarts[0];
    const wk1 = windowStarts[1];

    await client.insert(schema.useCaseActivationWeeks).values([
      { use_case_id: UC_MATCH, week_start: wk0, distinct_users: 1, session_count: 1, matched_messages: 1, updated_at: 1, last_seen_at: wk0 + 100 },
      { use_case_id: UC_MATCH, week_start: wk1, distinct_users: 1, session_count: 1, matched_messages: 1, updated_at: 1, last_seen_at: wk1 + 200 },
    ] as never).onConflictDoNothing();
    await client.insert(schema.useCaseWeekMatches).values([
      { use_case_id: UC_MATCH, week_start: wk0, user_id: 'wi-l-u1', session_id: 'wi-l-s1' },
      { use_case_id: UC_MATCH, week_start: wk1, user_id: 'wi-l-u2', session_id: 'wi-l-s2' },
    ] as never).onConflictDoNothing();
  });

  it('returns a non-archived use case whose connectors rule contains the signal, with distinct users + last-seen from the window', async () => {
    const rows = await findWorkflowsUsingSignal('connector', 'salesforce', NOW);
    const match = rows.find(r => r.id === UC_MATCH);

    expect(match).toBeDefined();
    expect(match!.title).toBe('WI Library Match UC');
    expect(match!.lifecycle).toBe('piloting');
    expect(match!.distinctUsers).toBe(2);
    const windowStarts = weekStarts(NOW - WEEK, 13);
    expect(match!.lastSeenAt).toBe(windowStarts[1] + 200);
  });

  it('excludes an archived use case even when its connectors rule matches', async () => {
    const rows = await findWorkflowsUsingSignal('connector', 'salesforce', NOW);
    expect(rows.find(r => r.id === UC_ARCHIVED)).toBeUndefined();
  });

  it('excludes a use case where the signal is a different kind (skill vs connector)', async () => {
    const rows = await findWorkflowsUsingSignal('connector', 'salesforce', NOW);
    expect(rows.find(r => r.id === UC_SKILL)).toBeUndefined();

    // The same signal, looked up as a skill, DOES find the skill-kind use case.
    const skillRows = await findWorkflowsUsingSignal('skill', 'salesforce', NOW);
    expect(skillRows.find(r => r.id === UC_SKILL)).toBeDefined();
    expect(skillRows.find(r => r.id === UC_MATCH)).toBeUndefined();
  });

  it('returns null lastSeenAt and 0 distinctUsers for a matching use case with no window activity rows', async () => {
    const client = await getTypedClient();
    const noActivityId = 'wi-l-uc-no-activity';
    await client.insert(schema.useCases).values({
      id: noActivityId, title: 'WI Library No Activity UC', status: 'confirmed', lifecycle: 'not_seen',
      connectors: JSON.stringify(['salesforce']), skills: JSON.stringify([]),
      departments: JSON.stringify([]), surfaces: JSON.stringify([]), keywords: JSON.stringify([]), task_types: JSON.stringify([]),
      origin: 'planned', capture_method: 'guided', created_at: NOW, updated_at: NOW,
    } as never).onConflictDoNothing();

    const rows = await findWorkflowsUsingSignal('connector', 'salesforce', NOW);
    const row = rows.find(r => r.id === noActivityId);
    expect(row).toBeDefined();
    expect(row!.distinctUsers).toBe(0);
    expect(row!.lastSeenAt).toBeNull();
  });
});
