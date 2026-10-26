// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { recomputeWeekImpact } from '@/lib/usecases/impact-rollup';
import { recordWeekMatches } from '@/lib/usecases/weeks';
import { createTestDatabase } from './helpers/db';

const WK = 1755993600; // a Monday-UTC epoch
const UC = 'wi-roll-uc';

describe('recomputeWeekImpact', () => {
  let cleanup: () => Promise<void>;

  afterAll(async () => cleanup());

  beforeAll(async () => {
    // Its own migrated test database — this suite used to
    // write into whatever default DB getTypedClient() opened.
    const testDb = await createTestDatabase();
    cleanup = testDb.cleanup;
    const client = await getTypedClient();
    await client.insert(schema.useCases).values({ id: UC, title: 'WI Rollup UC' } as never).onConflictDoNothing();
    await client.insert(schema.users).values({ id: 'wi-u1', email: 'wi-u1@test.local' } as never).onConflictDoNothing();
    await client.insert(schema.useCaseActivationWeeks).values({ use_case_id: UC, week_start: WK, updated_at: 1 } as never).onConflictDoNothing();
    // one cowork session (wall 1500s, gap-based active 1400s, 1 flag), one code
    // session (wall 600s, gap-based active 550s, 2 tool errors, engaged 300s,
    // 1 reject 3 accepts), one empty-id row. duration_secs/wall time is
    // deliberately kept LARGER than active_secs on both rows, proving the
    // rollup reads active_secs, never wall time.
    await client.insert(schema.useCaseWeekMatches).values([
      { use_case_id: UC, week_start: WK, user_id: 'wi-u1', session_id: 'wi-cw-1' },
      { use_case_id: UC, week_start: WK, user_id: 'wi-u1', session_id: 'wi-cd-1' },
      { use_case_id: UC, week_start: WK, user_id: 'wi-u1', session_id: '' },
    ] as never).onConflictDoNothing();
    await client.insert(schema.coworkSessions).values({ id: 'wi-cw-1', conversation_id: 'wi-cw-1-conv', user_id: 'wi-u1' } as never).onConflictDoNothing();
    // onConflictDoUpdate (not onConflictDoNothing) — kept from when this
    // suite wrote into the shared ./data/ccc.db, where a row for this fixed
    // session_id could predate the active_secs column and DoNothing would
    // leave it NULL forever. Harmless on the per-file test database.
    await client.insert(schema.coworkSessionStats).values({
      session_id: 'wi-cw-1', user_id: 'wi-u1', duration_secs: 1500, active_secs: 1400, computed_at: 1,
    } as never).onConflictDoUpdate({
      target: schema.coworkSessionStats.session_id,
      set: { duration_secs: 1500, active_secs: 1400, computed_at: 1 },
    });
    await client.insert(schema.coworkMessages).values({
      id: 'wi-cw-m1', session_id: 'wi-cw-1', user_id: 'wi-u1', message_type: 'cowork_user_message',
      flagged: 1, flag_reason: 'pii:cpf', occurred_at: WK + 100,
    } as never).onConflictDoNothing();
    // Cowork tool calls: one failure + one success — only the failure counts
    // into cowork_tool_error_count.
    await client.insert(schema.coworkMessages).values([
      { id: 'wi-cw-t1', session_id: 'wi-cw-1', user_id: 'wi-u1', message_type: 'cowork_tool_metadata', tool_success: 0, occurred_at: WK + 110 },
      { id: 'wi-cw-t2', session_id: 'wi-cw-1', user_id: 'wi-u1', message_type: 'cowork_tool_metadata', tool_success: 1, occurred_at: WK + 120 },
    ] as never).onConflictDoNothing();
    await client.insert(schema.codeSessionStats).values({
      session_id: 'wi-cd-1', user_id: 'wi-u1', first_at: WK + 200, last_at: WK + 800,
      error_count: 2, active_secs: 550, computed_at: 1,
    } as never).onConflictDoUpdate({
      target: schema.codeSessionStats.session_id,
      set: { first_at: WK + 200, last_at: WK + 800, error_count: 2, active_secs: 550, computed_at: 1 },
    });
    await client.insert(schema.codeOtelMetrics).values([
      { id: 'wi-m1', user_id: 'wi-u1', session_id: 'wi-cd-1', metric_name: 'claude_code.active_time.total', value: 300, type: 'user', occurred_at: WK + 300 },
      { id: 'wi-m2', user_id: 'wi-u1', session_id: 'wi-cd-1', metric_name: 'claude_code.code_edit_tool.decision', value: 1, type: 'reject', occurred_at: WK + 300 },
      { id: 'wi-m3', user_id: 'wi-u1', session_id: 'wi-cd-1', metric_name: 'claude_code.code_edit_tool.decision', value: 3, type: 'accept', occurred_at: WK + 310 },
    ] as never).onConflictDoNothing();
  });

  it('sums duration, engaged time, friction and flags across both surfaces', async () => {
    await recomputeWeekImpact(UC, WK);
    const client = await getTypedClient();
    const t = schema.useCaseActivationWeeks;
    const { and, eq } = await import('drizzle-orm');
    const [row] = await client.select().from(t).where(and(eq(t.use_case_id, UC), eq(t.week_start, WK)));
    // active_secs (1400 + 550), NOT wall time (1500 + 600) — proves the sum
    // reads gap-based active time, never wall-clock duration.
    expect(Number(row.measured_duration_secs)).toBe(1400 + 550);
    expect(Number(row.engaged_secs)).toBe(300);
    expect(Number(row.tool_error_count)).toBe(2);
    // One failed Cowork tool call; the successful one contributes nothing.
    expect(Number(row.cowork_tool_error_count)).toBe(1);
    expect(Number(row.edit_reject_count)).toBe(1);
    expect(Number(row.edit_accept_count)).toBe(3);
    expect(Number(row.flagged_count)).toBe(1);
  });

  it('a week with only empty session ids leaves all six columns null', async () => {
    const client = await getTypedClient();
    const WK2 = WK + 7 * 86400;
    await client.insert(schema.useCaseActivationWeeks).values({ use_case_id: UC, week_start: WK2, updated_at: 1 } as never).onConflictDoNothing();
    await client.insert(schema.useCaseWeekMatches).values({ use_case_id: UC, week_start: WK2, user_id: 'wi-u1', session_id: '' } as never).onConflictDoNothing();
    await recomputeWeekImpact(UC, WK2);
    const { and, eq } = await import('drizzle-orm');
    const [row] = await client.select().from(schema.useCaseActivationWeeks)
      .where(and(eq(schema.useCaseActivationWeeks.use_case_id, UC), eq(schema.useCaseActivationWeeks.week_start, WK2)));
    expect(row.measured_duration_secs).toBeNull();
    expect(row.tool_error_count).toBeNull();
    expect(row.cowork_tool_error_count).toBeNull();
  });

  it('a session matched in two weeks attributes fully to the EARLIEST week only', async () => {
    const client = await getTypedClient();
    const UC2 = 'wi-roll-straddle-uc';
    const WK4 = WK + 21 * 86400;
    const WK5 = WK4 + 7 * 86400;
    await client.insert(schema.useCases).values({ id: UC2, title: 'WI Straddle UC' } as never).onConflictDoNothing();
    await client.insert(schema.useCaseActivationWeeks).values([
      { use_case_id: UC2, week_start: WK4, updated_at: 1 },
      { use_case_id: UC2, week_start: WK5, updated_at: 1 },
    ] as never).onConflictDoNothing();
    // one session, matched in BOTH weeks (a straddle — the same conversation
    // spilled across the Monday-UTC boundary)
    await client.insert(schema.useCaseWeekMatches).values([
      { use_case_id: UC2, week_start: WK4, user_id: 'wi-u1', session_id: 'wi-straddle-1' },
      { use_case_id: UC2, week_start: WK5, user_id: 'wi-u1', session_id: 'wi-straddle-1' },
    ] as never).onConflictDoNothing();
    await client.insert(schema.coworkSessions).values({ id: 'wi-straddle-1', conversation_id: 'wi-straddle-1-conv', user_id: 'wi-u1' } as never).onConflictDoNothing();
    // onConflictDoUpdate — see the note in beforeAll above.
    await client.insert(schema.coworkSessionStats).values({
      session_id: 'wi-straddle-1', user_id: 'wi-u1', duration_secs: 600, active_secs: 550, computed_at: 1,
    } as never).onConflictDoUpdate({
      target: schema.coworkSessionStats.session_id,
      set: { duration_secs: 600, active_secs: 550, computed_at: 1 },
    });

    await recomputeWeekImpact(UC2, WK4);
    await recomputeWeekImpact(UC2, WK5);

    const { and, eq } = await import('drizzle-orm');
    const t = schema.useCaseActivationWeeks;
    const [rowEarly] = await client.select().from(t).where(and(eq(t.use_case_id, UC2), eq(t.week_start, WK4)));
    const [rowLate] = await client.select().from(t).where(and(eq(t.use_case_id, UC2), eq(t.week_start, WK5)));

    // active_secs (550), NOT wall time (600).
    expect(Number(rowEarly.measured_duration_secs)).toBe(550);
    // WK5's only session was the straddler, which is now attributed entirely to
    // WK4 — WK5 is left with zero attributable sessions, so its columns go
    // null (an honest "not measured", never a fabricated zero).
    expect(rowLate.measured_duration_secs).toBeNull();
    expect(rowLate.tool_error_count).toBeNull();
  });

  it('is idempotent — re-running recordWeekMatches + recomputeWeekImpact does not double-count', async () => {
    const client = await getTypedClient();
    const WK3 = WK + 14 * 86400;
    await client.insert(schema.useCaseActivationWeeks).values({ use_case_id: UC, week_start: WK3, updated_at: 1 } as never).onConflictDoNothing();
    await client.insert(schema.coworkSessions).values({ id: 'wi-cw-2', conversation_id: 'wi-cw-2-conv', user_id: 'wi-u1' } as never).onConflictDoNothing();
    // onConflictDoUpdate — see the note in beforeAll above.
    await client.insert(schema.coworkSessionStats).values({
      session_id: 'wi-cw-2', user_id: 'wi-u1', duration_secs: 900, active_secs: 850, computed_at: 1,
    } as never).onConflictDoUpdate({
      target: schema.coworkSessionStats.session_id,
      set: { duration_secs: 900, active_secs: 850, computed_at: 1 },
    });

    const matches = [{ userId: 'wi-u1', sessionId: 'wi-cw-2', occurredAt: WK3 + 100, isMessage: true }];

    await recordWeekMatches(UC, WK3, matches);
    await recomputeWeekImpact(UC, WK3);
    await recordWeekMatches(UC, WK3, matches);
    await recomputeWeekImpact(UC, WK3);

    const { and, eq } = await import('drizzle-orm');
    const [row] = await client.select().from(schema.useCaseActivationWeeks)
      .where(and(eq(schema.useCaseActivationWeeks.use_case_id, UC), eq(schema.useCaseActivationWeeks.week_start, WK3)));
    // active_secs (850), NOT wall time (900).
    expect(Number(row.measured_duration_secs)).toBe(850);
  });

  // These two use fresh, never-before-seeded (use_case_id, week_start) pairs
  // (WK6/WK7 are new offsets from WK), so — unlike the fixed-WK tests above —
  // there is no risk of historical rows from an older run of this suite
  // polluting the sum.
  it('excludes a session with a NULL active_secs from the sum (not yet re-aggregated)', async () => {
    const client = await getTypedClient();
    const WK6 = WK + 28 * 86400;
    await client.insert(schema.useCaseActivationWeeks).values({ use_case_id: UC, week_start: WK6, updated_at: 1 } as never).onConflictDoNothing();
    await client.insert(schema.useCaseWeekMatches).values([
      { use_case_id: UC, week_start: WK6, user_id: 'wi-u1', session_id: 'wi-cw-null' },
      { use_case_id: UC, week_start: WK6, user_id: 'wi-u1', session_id: 'wi-cw-measured' },
    ] as never).onConflictDoNothing();
    await client.insert(schema.coworkSessions).values([
      { id: 'wi-cw-null', conversation_id: 'wi-cw-null-conv', user_id: 'wi-u1' },
      { id: 'wi-cw-measured', conversation_id: 'wi-cw-measured-conv', user_id: 'wi-u1' },
    ] as never).onConflictDoNothing();
    // Never re-aggregated since the migration — active_secs is NULL, not 0 —
    // versus a sibling session that HAS been measured (active_secs 400).
    await client.insert(schema.coworkSessionStats).values(
      { session_id: 'wi-cw-null', user_id: 'wi-u1', duration_secs: 5_000_000, active_secs: null, computed_at: 1 } as never,
    ).onConflictDoUpdate({
      target: schema.coworkSessionStats.session_id,
      set: { duration_secs: 5_000_000, active_secs: null, computed_at: 1 },
    });
    await client.insert(schema.coworkSessionStats).values(
      { session_id: 'wi-cw-measured', user_id: 'wi-u1', duration_secs: 500, active_secs: 400, computed_at: 1 } as never,
    ).onConflictDoUpdate({
      target: schema.coworkSessionStats.session_id,
      set: { duration_secs: 500, active_secs: 400, computed_at: 1 },
    });

    await recomputeWeekImpact(UC, WK6);
    const { and, eq } = await import('drizzle-orm');
    const [row] = await client.select().from(schema.useCaseActivationWeeks)
      .where(and(eq(schema.useCaseActivationWeeks.use_case_id, UC), eq(schema.useCaseActivationWeeks.week_start, WK6)));
    // Only the measured session's 400s counts — the huge-wall-time NULL-active
    // session contributes nothing (never falls back to its 5,000,000s wall time).
    expect(Number(row.measured_duration_secs)).toBe(400);
  });

  it('goes null when EVERY matched session has a NULL active_secs', async () => {
    const client = await getTypedClient();
    const WK7 = WK + 35 * 86400;
    await client.insert(schema.useCaseActivationWeeks).values({ use_case_id: UC, week_start: WK7, updated_at: 1 } as never).onConflictDoNothing();
    await client.insert(schema.useCaseWeekMatches).values(
      { use_case_id: UC, week_start: WK7, user_id: 'wi-u1', session_id: 'wi-cw-allnull' } as never,
    ).onConflictDoNothing();
    await client.insert(schema.coworkSessions).values({ id: 'wi-cw-allnull', conversation_id: 'wi-cw-allnull-conv', user_id: 'wi-u1' } as never).onConflictDoNothing();
    await client.insert(schema.coworkSessionStats).values(
      { session_id: 'wi-cw-allnull', user_id: 'wi-u1', duration_secs: 999_999, active_secs: null, computed_at: 1 } as never,
    ).onConflictDoUpdate({
      target: schema.coworkSessionStats.session_id,
      set: { duration_secs: 999_999, active_secs: null, computed_at: 1 },
    });

    await recomputeWeekImpact(UC, WK7);
    const { and, eq } = await import('drizzle-orm');
    const [row] = await client.select().from(schema.useCaseActivationWeeks)
      .where(and(eq(schema.useCaseActivationWeeks.use_case_id, UC), eq(schema.useCaseActivationWeeks.week_start, WK7)));
    expect(row.measured_duration_secs).toBeNull();
  });
});
