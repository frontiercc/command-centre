// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { buildUseCaseImpact } from '@/lib/usecases/impact';
import { createTestDatabase } from './helpers/db';

const WEEK = 7 * 86400;
const WK = 1755475200; // a real Monday 00:00 UTC epoch — must be a genuine
// calendar-week boundary since buildUseCaseImpact derives its window via weekStarts(),
// unlike usecases-impact-rollup.test.ts's WK which is only ever used as an opaque key.
const WK2 = WK + WEEK;
// nowS chosen so weekStarts(nowS - WEEK, 13) is the ascending 13-week window
// [WK, WK+1w, ..., WK+12w] — WK is the oldest (window[0]), WK2 is window[1],
// and the remaining 11 window weeks have no use_case_activation_weeks row at all.
const NOW = WK + 13 * WEEK + 100;
const UC = 'wi-b-uc';

describe('buildUseCaseImpact', () => {
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    // Its own migrated test database — this suite used to
    // write into whatever default DB getTypedClient() opened.
    const testDb = await createTestDatabase();
    cleanup = testDb.cleanup;
    const client = await getTypedClient();

    await client.insert(schema.useCases).values({ id: UC, title: 'WI Impact UC' } as never).onConflictDoNothing();
    await client.insert(schema.users).values({ id: 'wi-b-u1', email: 'wi-b-u1@test.local' } as never).onConflictDoNothing();

    // Two measured weeks: WK has data, WK2 is all-null (row exists, no session ids that week).
    // onConflictDoUpdate, NOT DoNothing — kept from when this suite ran
    // against the shared ./data/ccc.db file, where anything recomputing weekly
    // rows between runs could leave polluted values in place.
    // Harmless on the per-file test database it now uses.
    const wkRow = {
      use_case_id: UC, week_start: WK, distinct_users: 1, session_count: 2, matched_messages: 1,
      updated_at: 1, measured_duration_secs: 2100, engaged_secs: 300,
      tool_error_count: 2, edit_reject_count: 1, edit_accept_count: 3, flagged_count: 1,
    };
    const wk2Row = {
      use_case_id: UC, week_start: WK2, distinct_users: 0, session_count: 0, matched_messages: 0,
      updated_at: 1, measured_duration_secs: null, engaged_secs: null,
      tool_error_count: null, edit_reject_count: null, edit_accept_count: null, flagged_count: null,
    };
    // A fresh database per file (createTestDatabase), so a plain insert.
    await client.insert(schema.useCaseActivationWeeks).values([wkRow, wk2Row] as never);

    // Junction: one cowork session + one code session in WK; an empty-id row in WK2
    // (mirrors the rollup test's "only empty session ids" convention).
    await client.insert(schema.useCaseWeekMatches).values([
      { use_case_id: UC, week_start: WK, user_id: 'wi-b-u1', session_id: 'wi-b-cw-1' },
      { use_case_id: UC, week_start: WK, user_id: 'wi-b-u1', session_id: 'wi-b-cd-1' },
      { use_case_id: UC, week_start: WK2, user_id: 'wi-b-u1', session_id: '' },
    ] as never).onConflictDoNothing();

    // Cowork session: one skill invocation, one connector invocation, one model.
    await client.insert(schema.coworkSessions).values({ id: 'wi-b-cw-1', conversation_id: 'wi-b-cw-1-conv', user_id: 'wi-b-u1' } as never).onConflictDoNothing();
    await client.insert(schema.coworkSessionStats).values({
      session_id: 'wi-b-cw-1', user_id: 'wi-b-u1', duration_secs: 1500, active_secs: 900,
      models_used: JSON.stringify(['claude-opus-4-6']), computed_at: 1,
    } as never).onConflictDoNothing();
    await client.insert(schema.coworkSkillInvocations).values({
      id: 'wi-b-skill-1', user_id: 'wi-b-u1', session_id: 'wi-b-cw-1', skill_name: 'docx', occurred_at: WK + 100,
    } as never).onConflictDoNothing();
    await client.insert(schema.coworkMcpInvocations).values({
      id: 'wi-b-mcp-1', user_id: 'wi-b-u1', session_id: 'wi-b-cw-1', mcp_server: 'salesforce', mcp_tool: 'query', occurred_at: WK + 100,
    } as never).onConflictDoNothing();

    // A cowork_messages row + pulse_classifications row for depth (cowork tier bucketed by occurred_at).
    await client.insert(schema.coworkMessages).values({
      id: 'wi-b-cwm-1', session_id: 'wi-b-cw-1', user_id: 'wi-b-u1', message_type: 'cowork_user_message', occurred_at: WK + 100,
    } as never).onConflictDoNothing();
    await client.insert(schema.pulseClassifications).values({
      cowork_message_id: 'wi-b-cwm-1', user_id: 'wi-b-u1', tier: 2, task_type: 'drafting',
      classifier_confidence: 0.9, classifier_model: 'haiku', classified_at: WK + 100,
    } as never).onConflictDoNothing();

    // Code session: one model + one classification (tier bucketed by last_at).
    await client.insert(schema.codeSessionStats).values({
      session_id: 'wi-b-cd-1', user_id: 'wi-b-u1', first_at: WK + 200, last_at: WK + 800,
      error_count: 2, active_secs: 500,
      models_json: JSON.stringify({ 'claude-haiku-4-5': { input: 10, output: 5, cache_creation: 0, cache_read: 0 } }),
      computed_at: 1,
    } as never).onConflictDoNothing();
    await client.insert(schema.codeSessionClassifications).values({
      session_id: 'wi-b-cd-1', user_id: 'wi-b-u1', work_type: 'refactor', tier: 3, confidence: 0.8,
      classifier_model: 'haiku', status: 'classified', classified_at: WK + 800,
    } as never).onConflictDoNothing();

    // A second code session with an ARRAY-shaped models_json (guards against the
    // bug where Object.keys() on an array yields numeric-index "0"/"1" strings
    // masquerading as model names). Matched at a different in-window week that
    // has no use_case_activation_weeks row, so it only affects participation/
    // surfaces, not the weekly series or totals assertions above.
    await client.insert(schema.useCaseWeekMatches).values({
      use_case_id: UC, week_start: WK + 2 * WEEK, user_id: 'wi-b-u1', session_id: 'wi-b-cd-2',
    } as never).onConflictDoNothing();
    await client.insert(schema.codeSessionStats).values({
      session_id: 'wi-b-cd-2', user_id: 'wi-b-u1', first_at: WK + 2 * WEEK + 200, last_at: WK + 2 * WEEK + 800,
      error_count: 0, models_json: JSON.stringify(['claude-array-invalid', 'claude-array-invalid-2']),
      computed_at: 1,
    } as never).onConflictDoNothing();

    // A rubric save inside the window — it must NOT be reported: rubric saves never mark the charts.
    await client.insert(schema.pulseRubricVersions).values({
      changed_by: 'wi-b-u1', changed_at: WK + 3 * 86400, rubric_json: '{}',
    } as never).onConflictDoNothing();
  });

  afterAll(async () => cleanup());

  it('produces 13 ascending weeks with absent weeks all-null and the measured week carrying its numbers', async () => {
    const impact = await buildUseCaseImpact(UC, NOW);

    expect(impact.windowWeeks).toBe(13);
    expect(impact.weeks).toHaveLength(13);
    expect(impact.weeks.map(w => w.weekStart)).toEqual(
      Array.from({ length: 13 }, (_, i) => WK + i * WEEK),
    );

    const wk1 = impact.weeks[0];
    expect(wk1.weekStart).toBe(WK);
    expect(wk1.sessions).toBe(2);
    expect(wk1.durationSecs).toBe(2100);
    expect(wk1.engagedSecs).toBe(300);
    expect(wk1.toolErrors).toBe(2);
    expect(wk1.editRejects).toBe(1);
    expect(wk1.editAccepts).toBe(3);
    expect(wk1.flagged).toBe(1);

    const wk2 = impact.weeks[1];
    expect(wk2.weekStart).toBe(WK2);
    expect(wk2.sessions).toBe(0);
    expect(wk2.durationSecs).toBeNull();
    expect(wk2.engagedSecs).toBeNull();
    expect(wk2.toolErrors).toBeNull();
    expect(wk2.editRejects).toBeNull();
    expect(wk2.editAccepts).toBeNull();
    expect(wk2.flagged).toBeNull();

    // The remaining 11 window weeks have no row at all — absent -> all-null, including sessions.
    for (const w of impact.weeks.slice(2)) {
      expect(w.sessions).toBeNull();
      expect(w.durationSecs).toBeNull();
      expect(w.engagedSecs).toBeNull();
      expect(w.toolErrors).toBeNull();
      expect(w.editRejects).toBeNull();
      expect(w.editAccepts).toBeNull();
      expect(w.flagged).toBeNull();
    }
  });

  it('totals sum only measured weeks and estimateHours uses the default calibration', async () => {
    const impact = await buildUseCaseImpact(UC, NOW);
    expect(impact.totals.durationSecs).toBe(2100);
    expect(impact.totals.engagedSecs).toBe(300);
    expect(impact.totals.sessions).toBe(2);
    // default useCasesMinutesSavedPerSession = 30 -> 2 sessions * 30 / 60 = 1 hour.
    expect(impact.totals.estimateHours).toBe(1);
  });

  it('totals carry the live per-surface active-time split, summed over the window session ids', async () => {
    const impact = await buildUseCaseImpact(UC, NOW);
    // wi-b-cw-1's active_secs=900 is the only cowork session in the window.
    expect(impact.totals.coworkDurationSecs).toBe(900);
    // wi-b-cd-1's active_secs=500 is measured; wi-b-cd-2 (also in-window) has
    // no active_secs set (null) and is excluded from the sum, not treated as 0.
    expect(impact.totals.codeDurationSecs).toBe(500);
  });

  it('totals report null (not zero) active-time split for a use case with no matched sessions', async () => {
    const impact = await buildUseCaseImpact('wi-b-no-such-uc', NOW);
    expect(impact.totals.coworkDurationSecs).toBeNull();
    expect(impact.totals.codeDurationSecs).toBeNull();
  });

  it('participation surfaces the seeded skill, connector, models and surface counts', async () => {
    const impact = await buildUseCaseImpact(UC, NOW);

    expect(impact.participation.skills[0]).toEqual({ name: 'docx', sessions: 1 });
    expect(impact.participation.connectors[0]).toEqual({ name: 'salesforce', sessions: 1 });

    const modelNames = impact.participation.models.map(m => m.name);
    expect(modelNames).toContain('claude-opus-4-6');
    expect(modelNames).toContain('claude-haiku-4-5');
    for (const m of impact.participation.models) expect(m.sessions).toBe(1);

    // wi-b-cd-2's ARRAY-shaped models_json must be skipped entirely (M-8 guard)
    // — never surfaced as numeric-index "model names" '0'/'1'.
    expect(modelNames).not.toContain('0');
    expect(modelNames).not.toContain('1');
    expect(modelNames).not.toContain('claude-array-invalid');

    // code surfaces now 2: wi-b-cd-1 (valid object models_json) + wi-b-cd-2
    // (array-shaped, contributes to the surface count but not to model names).
    expect(impact.participation.surfaces).toEqual({ cowork: 1, code: 2 });
    expect(impact.participation.cappedAt).toBeNull();
  });

  it('depth buckets tier counts per week for both surfaces and never reports rubric saves', async () => {
    const impact = await buildUseCaseImpact(UC, NOW);

    const wkDepth = impact.depth.weeks.find(w => w.weekStart === WK);
    expect(wkDepth).toBeDefined();
    expect(wkDepth!.tierCounts[2]).toBe(1); // cowork classification, weekStart(occurred_at)
    expect(wkDepth!.tierCounts[3]).toBe(1); // code classification, weekStart(last_at)
    expect(wkDepth!.total).toBe(2);

    expect(impact.depth.rubricChangesAt).toEqual([]);
  });

  describe('session cap counts distinct sessions, not session-weeks', () => {
    const UC_CAP = 'wi-cap-uc';
    // 155 distinct sessions, each matched in every one of the 13 in-window
    // weeks -> 2,015 (session, week) junction ROWS but only 155 DISTINCT
    // sessions. The old query capped on junction rows (LIMIT applied to
    // (session_id, week_start) pairs), so 2,015 > 2,000 falsely tripped
    // cappedAt even though real session coverage (155) is nowhere near the
    // 2,000-session limit. Grouping by session_id first fixes this.
    const SESSION_COUNT = 155;

    beforeAll(async () => {
      const client = await getTypedClient();
      await client.insert(schema.useCases).values({ id: UC_CAP, title: 'WI Cap UC' } as never).onConflictDoNothing();

      const allWeeks = Array.from({ length: 13 }, (_, i) => WK + i * WEEK);
      const rows: Array<{ use_case_id: string; week_start: number; user_id: string; session_id: string }> = [];
      for (let j = 0; j < SESSION_COUNT; j++) {
        const sessionId = `wi-cap-s${j}`;
        for (const ws of allWeeks) {
          rows.push({ use_case_id: UC_CAP, week_start: ws, user_id: 'wi-cap-u', session_id: sessionId });
        }
      }
      expect(rows.length).toBeGreaterThan(2000); // proves the old pair-counted LIMIT would have tripped

      for (let i = 0; i < rows.length; i += 100) {
        await client.insert(schema.useCaseWeekMatches).values(rows.slice(i, i + 100) as never).onConflictDoNothing();
      }
    });

    it('does not falsely report the cap when distinct sessions are well under the limit', async () => {
      const impact = await buildUseCaseImpact(UC_CAP, NOW);
      expect(impact.participation.cappedAt).toBeNull();
    });
  });
});
