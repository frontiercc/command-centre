// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Postgres coverage for lib/highlights/gather.ts's
// gatherHighlights(). gather.ts leans on two things that only genuinely bite
// on Postgres: Number()-coercion of count(*)/count(distinct ...) (Postgres
// returns these as strings, not numbers) and COALESCE-based display-name
// resolution ordering in the shoutouts join. The wider suite lives in
// test/highlights-gather.test.ts — this file ports the broadest-
// coverage window/exclusions/counts test, the shoutouts test, and a
// weekly-basis codeOutput assertion against a real postgres:16 testcontainer.
//
// HARNESS RULE (copied from otel-receivers-pg.test.ts / retention-cleanup-pg.
// test.ts): lib/highlights/gather.ts reaches the database through getClient(),
// which binds to DATABASE_URL on first use, so the module-under-
// test (and schema) are DYNAMIC-imported AFTER createTestDbClient('postgres')
// has set DATABASE_URL + reset modules. Unlike those two files, no manual
// DDL is needed here — createTestDbClient('postgres') boots the container via
// startPg(), which already applies the full committed lib/db/migrations-pg
// set, so every table gather.ts touches (users, admin_users, cowork_messages,
// pulse_classifications, code_session_stats, code_session_classifications,
// code_metrics, cowork_mcp_invocations, cowork_skill_invocations) already
// exists.
import { describe, it, expect } from 'vitest';

const NOW = 1754130000; // 2026-08-02 (Sunday) — window = last completed Mon-UTC week
const STRIPPED = '[Content removed — retention policy]';

describe('gatherHighlights (postgres)', () => {
  it(
    'windows/exclusions/counts, weekly-basis codeOutput, and COALESCE shoutouts all behave identically on postgres',
    async () => {
      const { createTestDbClient } = await import('./helpers/db');
      const { client, cleanup } = await createTestDbClient('postgres');

      try {
        // Dynamic imports AFTER the DATABASE_URL env + module reset (harness rule).
        const { schema } = await import('@/lib/db/schema');
        const { weekStart } = await import('@/lib/pulse/period');
        const { gatherHighlights } = await import('@/lib/highlights/gather');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const db = client as any;

        const wkEnd = weekStart(NOW); // exclusive end of last completed week
        const wkStart = wkEnd - 7 * 86400;
        const inWin = wkStart + 3600; // safely inside the window

        await db.insert(schema.users).values([
          { id: 'u-hl-1', email: 'hl1@test.local', display_name: 'Person One' },
          { id: 'u-hl-2', email: 'hl2@test.local', display_name: 'Person Two' },
        ]);

        // Three tier-3 messages: one long+clean, one carrying identity to
        // strip, one stripped-by-retention (must be excluded). One tier-1
        // (excluded). One NULL-preview-but-real-content_full row (must NOT be
        // dropped by the ne()/notLike() NULL-preview exclusion filters). One
        // out-of-window row (must be excluded from everything).
        await db.insert(schema.coworkMessages).values([
          { id: 'm-hl-1', session_id: 's-hl-1', user_id: 'u-hl-1', message_type: 'cowork_user_message', surface: 'cowork',
            content_preview: 'Build a client proposal', content_full: 'Build a client-ready proposal deck. '.repeat(20), occurred_at: inWin },
          { id: 'm-hl-2', session_id: 's-hl-2', user_id: 'u-hl-2', message_type: 'cowork_user_message', surface: 'cowork',
            content_preview: 'Analyse the file', content_full: 'Analyse C:\\Users\\jane\\report.xlsx and see https://internal.corp/wiki/page then summarise', occurred_at: inWin },
          { id: 'm-hl-3', session_id: 's-hl-3', user_id: 'u-hl-1', message_type: 'cowork_user_message', surface: 'cowork',
            content_preview: STRIPPED, content_full: null, occurred_at: inWin },
          { id: 'm-hl-4', session_id: 's-hl-4', user_id: 'u-hl-1', message_type: 'cowork_user_message', surface: 'cowork',
            content_preview: 'tiny', content_full: 'tiny tier-1 task', occurred_at: inWin },
          { id: 'm-hl-5', session_id: 's-hl-5', user_id: 'u-hl-1', message_type: 'cowork_user_message', surface: 'cowork',
            content_preview: '<scheduled-task id=1>', content_full: '<scheduled-task> nightly sync for bob@corp', occurred_at: inWin },
          { id: 'm-hl-6', session_id: 's-hl-6', user_id: 'u-hl-1', message_type: 'cowork_user_message', surface: 'cowork',
            content_preview: 'out of window', content_full: 'outside the completed week', occurred_at: wkEnd + 3600 },
          { id: 'm-hl-7', session_id: 's-hl-7', user_id: 'u-hl-2', message_type: 'cowork_user_message', surface: 'cowork',
            content_preview: null, content_full: 'Reconcile the vendor invoice totals against the ledger export', occurred_at: inWin },
        ]);

        await db.insert(schema.pulseClassifications).values([
          { cowork_message_id: 'm-hl-1', user_id: 'u-hl-1', tier: 3, task_type: 'workflow', classifier_confidence: 0.9, classifier_model: 'test', classified_at: inWin },
          { cowork_message_id: 'm-hl-2', user_id: 'u-hl-2', tier: 3, task_type: 'analysis', classifier_confidence: 0.9, classifier_model: 'test', classified_at: inWin },
          { cowork_message_id: 'm-hl-3', user_id: 'u-hl-1', tier: 3, task_type: 'workflow', classifier_confidence: 0.9, classifier_model: 'test', classified_at: inWin },
          { cowork_message_id: 'm-hl-4', user_id: 'u-hl-1', tier: 1, task_type: 'drafting', classifier_confidence: 0.9, classifier_model: 'test', classified_at: inWin },
          { cowork_message_id: 'm-hl-5', user_id: 'u-hl-1', tier: 3, task_type: 'workflow', classifier_confidence: 0.9, classifier_model: 'test', classified_at: inWin },
          { cowork_message_id: 'm-hl-6', user_id: 'u-hl-1', tier: 3, task_type: 'workflow', classifier_confidence: 0.9, classifier_model: 'test', classified_at: wkEnd + 3600 },
          { cowork_message_id: 'm-hl-7', user_id: 'u-hl-2', tier: 3, task_type: 'finance', classifier_confidence: 0.9, classifier_model: 'test', classified_at: inWin },
        ]);

        // Engineering mix — 2 work types inside the window, one session outside.
        await db.insert(schema.codeSessionStats).values([
          { session_id: 'cs-hl-1', user_id: 'u-hl-1', first_at: inWin, last_at: inWin, computed_at: inWin },
          { session_id: 'cs-hl-2', user_id: 'u-hl-2', first_at: inWin, last_at: inWin, computed_at: inWin },
          { session_id: 'cs-hl-3', user_id: 'u-hl-1', first_at: inWin, last_at: inWin, computed_at: inWin },
          { session_id: 'cs-hl-4', user_id: 'u-hl-1', first_at: wkEnd + 3600, last_at: wkEnd + 3600, computed_at: wkEnd + 3600 },
        ]);
        await db.insert(schema.codeSessionClassifications).values([
          { session_id: 'cs-hl-1', user_id: 'u-hl-1', work_type: 'feature', tier: 2, confidence: 0.9, classifier_model: 'test', classified_at: inWin },
          { session_id: 'cs-hl-2', user_id: 'u-hl-2', work_type: 'feature', tier: 2, confidence: 0.9, classifier_model: 'test', classified_at: inWin },
          { session_id: 'cs-hl-3', user_id: 'u-hl-1', work_type: 'bugfix', tier: 2, confidence: 0.9, classifier_model: 'test', classified_at: inWin },
          { session_id: 'cs-hl-4', user_id: 'u-hl-1', work_type: 'feature', tier: 2, confidence: 0.9, classifier_model: 'test', classified_at: wkEnd + 3600 },
        ]);

        // Code output — the COMPLETED week's own weekly row (granularity='week',
        // period_start=wkStart): lines 500+200=700, hands-on (7200+3600)/3600=3h,
        // kept=40, proposed=40+10=50, basis:'week'.
        await db.insert(schema.codeMetrics).values({
          scope_type: 'organisation', scope_id: 'org', period_start: wkStart, period_end: wkEnd,
          granularity: 'week', computed_at: inWin,
          lines_added: 500, lines_removed: 200,
          active_time_user_s: 7200, active_time_cli_s: 3600,
          edit_accept_count: 40, edit_reject_count: 10,
        });

        await db.insert(schema.coworkMcpInvocations).values([
          { id: 'mi-1', user_id: 'u-hl-1', session_id: 's-hl-1', mcp_server: 'salesforce', mcp_tool: 'query', occurred_at: inWin },
          { id: 'mi-2', user_id: 'u-hl-1', session_id: 's-hl-1', mcp_server: 'salesforce', mcp_tool: 'update', occurred_at: inWin },
          { id: 'mi-3', user_id: 'u-hl-2', session_id: 's-hl-2', mcp_server: 'slack', mcp_tool: 'post', occurred_at: inWin },
        ]);

        await db.insert(schema.coworkSkillInvocations).values([
          { id: 'si-1', user_id: 'u-hl-1', session_id: 's-hl-1', skill_name: 'docx', occurred_at: inWin },
          { id: 'si-2', user_id: 'u-hl-1', session_id: 's-hl-1', skill_name: 'pptx', occurred_at: inWin },
        ]);

        // ════════════════════════════════════════════════════════════════════
        // SECTION A — window/exclusions/counts: the broadest query coverage,
        // exercising count(*)/count(distinct ...) string coercion (Postgres
        // returns these as strings) across headcount, tier3Count, and systems.
        // ════════════════════════════════════════════════════════════════════
        const input = await gatherHighlights({ nowS: NOW });
        expect(input.weekStart).toBe(wkStart);
        expect(input.weekEnd).toBe(wkEnd);
        expect(input.workItems.map(w => w.taskType).sort()).toEqual(['analysis', 'finance', 'workflow']); // m-hl-1 + m-hl-2 + m-hl-7 (NULL-preview, real content)
        expect(input.workItems[0].text.length).toBeGreaterThanOrEqual(input.workItems[1].text.length); // longest-first
        expect(input.headcount).toBe(2);
        expect(input.tier3Count).toBe(5); // ALL in-window tier-3 classifications (m-hl-1/2/3/5/7 — stripped and scheduled rows still COUNT in the tier mix)
        expect(input.systems.totalCalls).toBe(3);
        expect(input.systems.distinctSystems).toBe(2);
        expect(input.systems.top[0]).toEqual({ server: 'salesforce', calls: 2, people: 1 });
        expect(typeof input.headcount).toBe('number');
        expect(typeof input.tier3Count).toBe('number');
        expect(typeof input.systems.totalCalls).toBe('number');

        // engineeringMix groups/counts by work_type, excludes the out-of-window session.
        const byType = Object.fromEntries(input.engineeringMix.map(m => [m.workType, m.sessions]));
        expect(byType['New functionality']).toBe(2); // cs-hl-1 + cs-hl-2 (cs-hl-4 is out-of-window, excluded)
        expect(byType['Fixing defects']).toBe(1); // cs-hl-3

        // NULL content_preview but real content_full must NOT be dropped
        // (the ne()/notLike() NULL-safe filters).
        const finance = input.workItems.find(w => w.taskType === 'finance');
        expect(finance).toBeDefined();
        expect(finance!.text).toContain('vendor invoice');

        // stripIdentity ran on every returned work item.
        const allText = input.workItems.map(w => w.text).join(' ');
        expect(allText).not.toContain('C:\\Users');
        expect(allText).not.toContain('https://internal.corp');
        expect(allText).not.toContain('jane');

        // ════════════════════════════════════════════════════════════════════
        // SECTION B — codeOutput arithmetic from the completed week's weekly
        // row, basis="week".
        // ════════════════════════════════════════════════════════════════════
        expect(input.codeOutput).toEqual({
          linesChanged: 700,   // 500 + 200
          handsOnHours: 3,     // (7200 + 3600) / 3600
          changesKept: 40,
          changesProposed: 50, // 40 + 10
          basis: 'week',
        });

        // ════════════════════════════════════════════════════════════════════
        // SECTION C — shoutouts: null by default, populated with includeNames
        // (COALESCE(admin_users.display_name, users.display_name, users.email)
        // display-name join + count-distinct, both string-coerced on Postgres).
        // ════════════════════════════════════════════════════════════════════
        expect(input.shoutouts).toBeNull();
        const named = await gatherHighlights({ nowS: NOW, includeNames: true });
        expect(named.shoutouts?.systems?.person).toBe('Person One');
        expect(named.shoutouts?.systems?.count).toBe(2);
        expect(named.shoutouts?.skills?.person).toBe('Person One');
        expect(named.shoutouts?.skills?.distinct).toBe(2);
        expect(typeof named.shoutouts?.systems?.count).toBe('number');
        expect(typeof named.shoutouts?.skills?.distinct).toBe('number');
      } finally {
        await cleanup();
      }
    },
    180_000,
  );
});
