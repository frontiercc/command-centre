// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Postgres coverage for the Department Process
// Transformation feature (migration 077/0018, lib/usecases/process-corpus.ts,
// lib/usecases/suggestion-store.ts). Four things only genuinely bite on
// Postgres, each proven here against a real postgres:16 testcontainer:
//   1. Migration 0018 applies — the `department`/`canvas_json` columns on
//      use_case_suggestions and the four canvas columns on use_cases — proven
//      by inserting/selecting THROUGH the store and queries layers (a missing
//      column fails the insert/select outright, not silently).
//   2. The store round-trip (department + canvas + countOpenByDepartment
//      + listOpenDeptBoxes) re-run on real PG — ports the first test of
//      test/process-suggestion-store.test.ts, plus the use_cases canvas-field
//      round-trip from its second test.
//   3. gatherDeptCorpora's raw SQL: cowork_messages.occurred_at is BIGINT,
//      which node-postgres's raw driver returns as a STRING, not a number —
//      the `Number(r.occurred_at)` coercion is what keeps
//      DeptExcerpt.occurredAt a real number on Postgres. Also proves both
//      department-resolution paths (users.department direct; admin_users.
//      department via linked_cowork_user_id when users.department is NULL)
//      and PII redaction, all against real PG.
//   4. gatherSessionFacts' aggregate SQL: COUNT(active_secs)/SUM(active_secs)
//      both return BIGINT on Postgres (also a string from the raw driver) —
//      the Number() coercion around n/s in lib/usecases/process-corpus.ts is
//      what this section locks, including the null-aware branch (a session
//      with a NULL active_secs must not zero-and-sum).
//
// HARNESS RULE (copied from test/highlights-pg.test.ts / test/use-cases-
// tracker-pg.test.ts): every module under test reaches the database through
// getClient(), which binds to DATABASE_URL on first use — so
// schema and every module under test must be DYNAMIC-imported AFTER
// createTestDbClient('postgres') has set DATABASE_URL + reset modules.
// createTestDbClient('postgres') boots the container via startPg(), which
// already applies the full committed lib/db/migrations-pg set (migration
// 0018 included) — no manual DDL is needed here.
import { describe, it, expect } from 'vitest';

const DAY = 86400;
const NOW = Math.floor(Date.now() / 1000);

describe('department process mining (postgres)', () => {
  it(
    'migration 0018 round-trips through the store/queries layers, gatherDeptCorpora coerces bigint occurred_at + resolves both department paths + redacts PII, and gatherSessionFacts coerces its bigint aggregate sum',
    async () => {
      const { createTestDbClient } = await import('./helpers/db');
      const { client, cleanup } = await createTestDbClient('postgres');

      try {
        // Dynamic imports AFTER the DATABASE_URL env + module reset (harness rule).
        const { schema } = await import('@/lib/db/schema');
        const store = await import('@/lib/usecases/suggestion-store');
        const queries = await import('@/lib/usecases/queries');
        const corpus = await import('@/lib/usecases/process-corpus');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const db = client as any;

        // ════════════════════════════════════════════════════════════════
        // SECTION 1 — migration 0018 applies + the store round-trip.
        // ════════════════════════════════════════════════════════════════
        const CANVAS = {
          story: 'Month-end commentary appears hand-assembled from pasted spreadsheet rows.',
          valueHypothesis: 'Feeding the pack template directly would turn assembly into review.',
          people: 4, sessions: 23, occasions: 9, windowDays: 28,
          rhythm: { label: 'monthly' as const, display: 'Monthly, month-end spike' },
          systems: ['anthropic-skills:xlsx', 'salesforce'], activeHours: 9.2, tierNote: 'Mostly tier 2',
        };

        await store.upsertOpenSuggestion({
          signalKey: 'pg-k-dept-1', title: 'Month-end variance commentary', description: null,
          matchingRule: { skills: [], connectors: ['salesforce'], taskTypes: [], departments: ['PG Finance Suggestion'] },
          evidence: { distinctUsers: 4, sessionCount: 23, departments: ['PG Finance Suggestion'] },
          nowS: 1000, department: 'PG Finance Suggestion', canvas: CANVAS,
        });
        await store.upsertOpenSuggestion({
          signalKey: 'pg-k-org-1', title: 'Org cluster', description: null,
          matchingRule: { skills: ['x'], connectors: [], taskTypes: [], departments: [] },
          evidence: { distinctUsers: 3, sessionCount: 5, departments: [] }, nowS: 1000,
        });

        const all = await store.listOpenSuggestions();
        const dept = all.find(s => s.signalKey === 'pg-k-dept-1')!;
        expect(dept.department).toBe('PG Finance Suggestion');
        expect(dept.canvas?.rhythm.display).toBe('Monthly, month-end spike');
        expect(all.find(s => s.signalKey === 'pg-k-org-1')!.department).toBeNull();
        expect(await store.countOpenByDepartment('PG Finance Suggestion')).toBe(1);
        const boxes = await store.listOpenDeptBoxes();
        expect(boxes).toEqual([expect.objectContaining({ department: 'PG Finance Suggestion', count: 1 })]);

        // use_cases canvas columns (pain_point/value_hypothesis/baseline_note/
        // kpi_note) — same fixture as process-suggestion-store.test.ts's second test.
        const uc = await queries.createUseCase({
          title: 'PG canvas round-trip', painPoint: 'p', valueHypothesis: 'v', baselineNote: 'b', kpiNote: 'k',
        });
        const ucBack = (await queries.getUseCase(uc.id))!;
        expect([ucBack.painPoint, ucBack.valueHypothesis, ucBack.baselineNote, ucBack.kpiNote]).toEqual(['p', 'v', 'b', 'k']);

        // ════════════════════════════════════════════════════════════════
        // SECTION 2 — gatherDeptCorpora: bigint occurred_at Number()
        // coercion, both department-resolution paths, PII redaction.
        // ════════════════════════════════════════════════════════════════
        const inWin = NOW - 2 * DAY;

        // Path A: users.department direct.
        await db.insert(schema.users).values({
          id: 'pg-anna', email: 'pg-anna@test.local', display_name: 'Anna PG', department: 'PG Finance Dept',
        });
        await db.insert(schema.coworkMessages).values({
          id: 'm-pg-anna-1', session_id: 's-pg-anna-1', user_id: 'pg-anna',
          message_type: 'cowork_user_message', surface: 'cowork',
          content_full: 'Please email jane.doe@example.com the board pack draft', occurred_at: inWin,
        });

        // Path B: admin_users.department via linked_cowork_user_id, with
        // users.department NULL for this user.
        await db.insert(schema.users).values({
          id: 'pg-ben', email: 'pg-ben@test.local', display_name: 'Ben PG', department: null,
        });
        await db.insert(schema.adminUsers).values({
          id: 'pg-admin-ben', email: 'pg-admin-ben@test.local', password_hash: 'x',
          department: 'PG Sales Dept', linked_cowork_user_id: 'pg-ben',
        });
        await db.insert(schema.coworkMessages).values({
          id: 'm-pg-ben-1', session_id: 's-pg-ben-1', user_id: 'pg-ben',
          message_type: 'cowork_user_message', surface: 'cowork',
          content_full: 'Draft the client renewal proposal', occurred_at: inWin,
        });

        const corpora = await corpus.gatherDeptCorpora(NOW, 28);
        const depts = corpora.map(c => c.department).sort();
        expect(depts).toEqual(['PG Finance Dept', 'PG Sales Dept']);

        const finance = corpora.find(c => c.department === 'PG Finance Dept')!;
        expect(finance.excerpts).toHaveLength(1);
        // THE LOAD-BEARING ASSERTION: cowork_messages.occurred_at is bigint;
        // node-postgres's raw driver returns bigint as a STRING — without
        // the Number() coercion this would be typeof 'string', not 'number'.
        expect(typeof finance.excerpts[0].occurredAt).toBe('number');
        expect(finance.excerpts[0].occurredAt).toBe(inWin);
        expect(finance.excerpts[0].text).not.toContain('jane.doe@example.com');

        const sales = corpora.find(c => c.department === 'PG Sales Dept')!;
        expect(sales.excerpts.map(e => e.userId)).toEqual(['pg-ben']);
        expect(typeof sales.excerpts[0].occurredAt).toBe('number');

        // ════════════════════════════════════════════════════════════════
        // SECTION 3 — gatherSessionFacts: bigint SUM()/COUNT() Number()
        // coercion over cowork_session_stats.active_secs.
        // ════════════════════════════════════════════════════════════════
        await db.insert(schema.coworkSessions).values([
          { id: 's-pg-facts-1', conversation_id: 's-pg-facts-1', user_id: 'pg-anna' },
          { id: 's-pg-facts-2', conversation_id: 's-pg-facts-2', user_id: 'pg-anna' },
          { id: 's-pg-facts-3', conversation_id: 's-pg-facts-3', user_id: 'pg-anna' },
        ]);
        await db.insert(schema.coworkSessionStats).values([
          { session_id: 's-pg-facts-1', user_id: 'pg-anna', computed_at: NOW, active_secs: 100 },
          { session_id: 's-pg-facts-2', user_id: 'pg-anna', computed_at: NOW, active_secs: 250 },
          { session_id: 's-pg-facts-3', user_id: 'pg-anna', computed_at: NOW, active_secs: null },
        ]);

        const facts = await corpus.gatherSessionFacts(['s-pg-facts-1', 's-pg-facts-2', 's-pg-facts-3']);
        // THE LOAD-BEARING ASSERTION: COUNT(active_secs)/SUM(active_secs) both
        // return bigint on Postgres — node-postgres's raw driver returns
        // bigint as a STRING, not a number, whether the query came from raw
        // SQL or (as here) Drizzle's query builder with a `sql<number>`
        // template. Without the Number() coercion around n/s in
        // gatherSessionFacts, `facts.activeSecs` would be typeof 'string'.
        expect(typeof facts.activeSecs).toBe('number');
        expect(facts.activeSecs).toBe(350); // the null row contributes nothing, not "0"-and-summed-anyway
      } finally {
        await cleanup();
      }
    },
    180_000,
  );
});
