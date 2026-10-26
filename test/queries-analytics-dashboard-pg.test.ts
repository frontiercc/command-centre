// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Postgres coverage for the Analytics snapshots + dashboard
// aggregates + batch helpers group of lib/db/queries.ts: getSnapshotsForUser,
// getSnapshotsForPeriod, getAdoptionTrend, getSurfaceBreakdown,
// getUserAdoptionHealth, getUserPrimarySurface, getUserMessageCount7d,
// getAllUserMessageCounts7d, getAllUserPrimarySurfaces,
// getAllUserAdoptionHealth, getDepartmentBreakdown, getTopUsers.
//
// This is the heaviest GROUP BY + date-bucket + coercion cluster in
// queries.ts. The central assertions are:
//   1. getAdoptionTrend's MERGE behaviour — an analytics_snapshots
//      row is authoritative ONLY for the date it covers (overlay wins over a
//      live count for that SAME date); every other date in the window is
//      filled from the live cowork/chat fallback, never blanked.
//   2. Every GROUP BY here returns the correct grouped rows on Postgres
//      (strict mode) — proving no bare-non-aggregated-column rejection.
//   3. Every count/SUM comes back as a real JS `number`
//      (pg returns bigint/numeric aggregates as strings).
//
// HARNESS RULE (copied from queries-alerts-pg.test.ts / queries-users-pg.
// test.ts): queries.ts reaches the database through getClient(), which binds
// to DATABASE_URL on first use, so the module-under-test (and
// schema) are DYNAMIC-imported AFTER createTestDbClient() has set
// DATABASE_URL + reset modules.
import { describe, it, expect } from 'vitest';

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;
// Per-row date buckets (to_char(to_timestamp(col)) at UTC) are pure-UTC
// conversions of the epoch, so labelling test
// fixtures via the epoch (not local-calendar arithmetic) keeps the test
// deterministic regardless of the host machine's timezone.
const dayLabel = (ts: number): string => new Date(ts * 1000).toISOString().slice(0, 10);
const TODAY_TS = NOW - 100; // a few seconds ago — same UTC day as "now" almost always
const OVERLAY_TS = NOW - 2 * DAY;
const LIVE_ONLY_TS = NOW - 3 * DAY;
const TODAY = dayLabel(TODAY_TS);
const OVERLAY_DAY = dayLabel(OVERLAY_TS);
const LIVE_ONLY_DAY = dayLabel(LIVE_ONLY_TS);

async function runSpec(): Promise<void> {
  const { createTestDbClient } = await import('./helpers/db');
  const { client, cleanup } = await createTestDbClient('postgres');
  try {
    // Dynamic import AFTER the DATABASE_URL env + module reset (harness rule).
    const { schema } = await import('@/lib/db/schema');
    const queries = await import('@/lib/db/queries');
    const {
      getSnapshotsForUser, getSnapshotsForPeriod, getAdoptionTrend, getSurfaceBreakdown,
      getUserAdoptionHealth, getUserPrimarySurface, getUserMessageCount7d,
      getAllUserMessageCounts7d, getAllUserPrimarySurfaces, getAllUserAdoptionHealth,
      getDepartmentBreakdown, getTopUsers,
    } = queries;

    // ── Fixtures: users ──────────────────────────────────────────────────
    // user-1/2/3: exercise the FALLBACK (live message-derived) path for the
    // per-user + Map-builder functions (no analytics_snapshots rows).
    // user-4/5: exercise the PRIMARY (analytics_snapshots-driven) path.
    // user-6/7: dedicated getDepartmentBreakdown fixtures.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).insert(schema.users).values([
      { id: 'user-1', email: 'u1@test.local', department: 'Eng', last_seen_at: NOW },
      { id: 'user-2', email: 'u2@test.local', department: 'Sales' },
      { id: 'user-3', email: 'u3@test.local' },
      { id: 'user-4', email: 'u4@test.local', department: 'Eng' },
      { id: 'user-5', email: 'u5@test.local', department: 'Sales' },
      { id: 'user-6', email: 'u6@test.local', department: 'Eng', last_seen_at: NOW },
      { id: 'user-7', email: 'u7@test.local', department: 'Sales' },
    ]);

    // ── Fixtures: analytics_snapshots (Enterprise-mode primary path) ────
    // user-4/user-5 both land on OVERLAY_DAY — this is the date that will
    // later be proven "authoritative" against a conflicting live count on
    // the SAME date (getAdoptionTrend's overlay-wins assertion).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).insert(schema.analyticsSnapshots).values([
      {
        id: 'snap-4', user_id: 'user-4', snapshot_date: OVERLAY_DAY,
        messages_sent: 4, surface_chat: 3, surface_code: 0, surface_cowork: 1,
      },
      {
        id: 'snap-5', user_id: 'user-5', snapshot_date: OVERLAY_DAY,
        messages_sent: 2, surface_chat: 2, surface_code: 0, surface_cowork: 0,
      },
    ]);

    // ── Fixtures: live chat_messages ─────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).insert(schema.chatMessages).values([
      { id: 'chm-1', user_id: 'user-1', prompt_text: 'hi', prompt_length: 2, occurred_at: TODAY_TS },
      { id: 'chm-2', user_id: 'user-1', prompt_text: 'hi again', prompt_length: 8, occurred_at: TODAY_TS },
      { id: 'chm-3', user_id: 'user-6', prompt_text: 'dept test', prompt_length: 9, occurred_at: TODAY_TS },
      { id: 'chm-4', user_id: 'user-6', prompt_text: 'dept test 2', prompt_length: 11, occurred_at: TODAY_TS },
    ]);

    // ── Fixtures: live cowork_messages ───────────────────────────────────
    // LIVE_ONLY_DAY has NO snapshot row anywhere — proves the merge fills
    // gaps rather than blanking the graph. OVERLAY_DAY gets a CONFLICTING
    // live cowork count (3 distinct users) that must be overridden by the
    // snapshot's surface_cowork=1 once merged.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).insert(schema.coworkMessages).values([
      { id: 'cw-1', session_id: 's1', user_id: 'user-1', message_type: 'cowork_user_message', surface: 'cowork', occurred_at: LIVE_ONLY_TS },
      { id: 'cw-2', session_id: 's2', user_id: 'user-2', message_type: 'cowork_user_message', surface: 'cowork', occurred_at: LIVE_ONLY_TS },
      { id: 'cw-3', session_id: 's3', user_id: 'user-1', message_type: 'cowork_user_message', surface: 'cowork', occurred_at: OVERLAY_TS },
      { id: 'cw-4', session_id: 's4', user_id: 'user-2', message_type: 'cowork_user_message', surface: 'cowork', occurred_at: OVERLAY_TS },
      { id: 'cw-5', session_id: 's5', user_id: 'user-3', message_type: 'cowork_user_message', surface: 'cowork', occurred_at: OVERLAY_TS },
      { id: 'cw-6', session_id: 's6', user_id: 'user-6', message_type: 'cowork_user_message', surface: 'cowork', occurred_at: TODAY_TS },
      { id: 'cw-7', session_id: 's7', user_id: 'user-2', message_type: 'cowork_user_message', surface: 'code', occurred_at: TODAY_TS },
      { id: 'cw-8', session_id: 's8', user_id: 'user-7', message_type: 'cowork_user_message', surface: 'code', occurred_at: TODAY_TS },
    ]);

    // ─────────────────────────────────────────────────────────────────────
    // Part A — analytics_snapshots present: primary paths + merge proof.
    // ─────────────────────────────────────────────────────────────────────

    // ── getSnapshotsForUser: primary rows for user-4, fallback for user-1 ──
    const snapsUser4 = await getSnapshotsForUser('user-4', 30);
    expect(snapsUser4.length).toBe(1);
    expect(snapsUser4[0].snapshot_date).toBe(OVERLAY_DAY);
    expect(snapsUser4[0].messages_sent).toBe(4);
    expect(typeof snapsUser4[0].messages_sent).toBe('number');

    // user-1 has NO analytics_snapshots row -> synthesised fallback from
    // chat_messages (TODAY, 2 msgs) + cowork_messages surface=cowork
    // (LIVE_ONLY_DAY 1, OVERLAY_DAY 1).
    const snapsUser1 = await getSnapshotsForUser('user-1', 30);
    const byDate1 = new Map(snapsUser1.map((s) => [s.snapshot_date, s]));
    expect(byDate1.get(TODAY)?.surface_chat).toBe(2);
    expect(byDate1.get(TODAY)?.messages_sent).toBe(2);
    expect(byDate1.get(LIVE_ONLY_DAY)?.surface_cowork).toBe(1);
    expect(byDate1.get(OVERLAY_DAY)?.surface_cowork).toBe(1);
    for (const s of snapsUser1) {
      expect(typeof s.messages_sent).toBe('number');
      expect(typeof s.surface_cowork).toBe('number');
    }

    // ── getSnapshotsForPeriod: org-wide snapshot rows within the window ──
    const period = await getSnapshotsForPeriod(7);
    expect(period.map((s) => s.id).sort()).toEqual(['snap-4', 'snap-5']);

    // ── getAdoptionTrend: THE merge proof ────────────────────────────────
    // OVERLAY_DAY: snapshot (chat=3+2=5, code=0, cowork=1) must WIN over the
    // live count for that date (cowork_messages shows 3 distinct users:
    // user-1/2/3 — if the merge were wrong, cowork would read 3, not 1).
    // LIVE_ONLY_DAY: no snapshot exists — must be filled from the live
    // fallback (cowork=2 distinct users: user-1/2), NOT blanked.
    // TODAY: no snapshot — live chat=4 (chm-1/2 user-1 + chm-3/4 user-6),
    // code=2 (cw-7 user-2, cw-8 user-7), cowork=1 (cw-6 user-6). This is an
    // org-wide bucket, so the dept-test fixtures (user-6/7) land here too.
    const trend = await getAdoptionTrend(5);
    const byDate = new Map(trend.map((t) => [t.date, t]));
    expect(byDate.get(OVERLAY_DAY)).toEqual({
      date: OVERLAY_DAY, surface_chat: 5, surface_code: 0, surface_cowork: 1,
    });
    expect(byDate.get(LIVE_ONLY_DAY)).toEqual({
      date: LIVE_ONLY_DAY, surface_chat: 0, surface_code: 0, surface_cowork: 2,
    });
    expect(byDate.get(TODAY)).toEqual({
      date: TODAY, surface_chat: 4, surface_code: 2, surface_cowork: 1,
    });
    // Sorted ascending by date (localeCompare on YYYY-MM-DD strings).
    const dates = trend.map((t) => t.date);
    expect([...dates].sort()).toEqual(dates);

    // ── getSurfaceBreakdown: PRIMARY path (snapshot totals > 0) ─────────
    // Global snapshot sum within 7 days: chat=5, code=0, cowork=1 -> > 0,
    // so the primary (Enterprise) branch wins, never touching the fallback
    // CASE WHEN aggregates.
    const surfacePrimary = await getSurfaceBreakdown();
    expect(surfacePrimary).toEqual({ chat: 5, code: 0, agentCowork: 1, otelCowork: 0 });
    expect(typeof surfacePrimary.chat).toBe('number');

    // ── getUserAdoptionHealth / getUserPrimarySurface / getUserMessageCount7d
    //    PRIMARY path (user-4/5, snapshot-driven) ────────────────────────
    expect(await getUserAdoptionHealth('user-4')).toBe('inactive'); // messages_sent=4 < 5
    expect(await getUserPrimarySurface('user-4')).toBe('Chat'); // chat=3 is max
    expect(await getUserMessageCount7d('user-4')).toBe(4);
    expect(await getUserAdoptionHealth('user-5')).toBe('inactive'); // messages_sent=2 < 5
    expect(await getUserPrimarySurface('user-5')).toBe('Chat');
    expect(await getUserMessageCount7d('user-5')).toBe(2);

    //    FALLBACK path (user-1/2/3, no snapshot rows) ─────────────────────
    // getUserAdoptionHealth delegates to getSnapshotsForUser(userId,14)
    // FIRST — which has its OWN chat/cowork synthesis fallback (see above),
    // so it is never actually empty when the user has any live activity.
    // That shadows getUserAdoptionHealth's OWN raw-COUNT fallback entirely
    // (dead code on this path in both the pre- and post-conversion
    // implementation — not a regression introduced by this conversion).
    // user-1's synthesised messages_sent total = 2(TODAY chat) + 1
    // (LIVE_ONLY_DAY cowork) + 1(OVERLAY_DAY cowork) = 4 < 5 -> 'inactive'.
    expect(await getUserAdoptionHealth('user-1')).toBe('inactive');
    // getUserPrimarySurface/getUserMessageCount7d are INDEPENDENT
    // implementations (no getSnapshotsForUser dependency) — real fallback:
    // coworkCount=2 (LIVE_ONLY_DAY+OVERLAY_DAY), codeCount=0, chatCount=2
    // (TODAY) -> tie broken toward Cowork (checked before Chat).
    // messages_7d fallback = cowork_messages count (7d) = 2.
    expect(await getUserPrimarySurface('user-1')).toBe('Cowork');
    expect(await getUserMessageCount7d('user-1')).toBe(2);
    // user-2's synthesised messages_sent total = 1(TODAY code) + 1
    // (LIVE_ONLY_DAY cowork) + 1(OVERLAY_DAY cowork) = 3 < 5 -> 'inactive'.
    expect(await getUserAdoptionHealth('user-2')).toBe('inactive');
    // Primary-surface fallback: coworkCount=2, codeCount=1, chatCount=0 -> Cowork.
    expect(await getUserPrimarySurface('user-2')).toBe('Cowork');
    expect(await getUserMessageCount7d('user-2')).toBe(3);
    // user-3's synthesised messages_sent total = 1(OVERLAY_DAY cowork) < 5 -> 'inactive'.
    expect(await getUserAdoptionHealth('user-3')).toBe('inactive');
    expect(await getUserPrimarySurface('user-3')).toBe('Cowork');
    expect(await getUserMessageCount7d('user-3')).toBe(1);

    // ── getAllUser*Map builders: mixed primary (user-4/5) + fallback
    //    (user-1/2/3) in ONE call — proves GROUP BY + fallback dedup work
    //    together. ──────────────────────────────────────────────────────
    const msgMap = await getAllUserMessageCounts7d();
    expect(msgMap.get('user-1')).toBe(2);
    expect(msgMap.get('user-2')).toBe(3);
    expect(msgMap.get('user-3')).toBe(1);
    expect(msgMap.get('user-4')).toBe(4);
    expect(msgMap.get('user-5')).toBe(2);

    const surfaceMap = await getAllUserPrimarySurfaces();
    expect(surfaceMap.get('user-1')).toBe('Cowork');
    expect(surfaceMap.get('user-2')).toBe('Cowork');
    expect(surfaceMap.get('user-3')).toBe('Cowork');
    expect(surfaceMap.get('user-4')).toBe('Chat');
    expect(surfaceMap.get('user-5')).toBe('Chat');

    // getAllUserAdoptionHealth does NOT delegate to getSnapshotsForUser — its
    // fallback is a direct raw COUNT(*) over cowork_messages, so user-1/2/3
    // (no real analytics_snapshots rows) land in genuinely 'shallow'
    // (count>0 && <5) here, unlike the single-user getUserAdoptionHealth
    // call above.
    const healthMap = await getAllUserAdoptionHealth();
    expect(healthMap.get('user-1')).toBe('shallow');
    expect(healthMap.get('user-2')).toBe('shallow');
    expect(healthMap.get('user-3')).toBe('shallow');
    expect(healthMap.get('user-4')).toBe('inactive');
    expect(healthMap.get('user-5')).toBe('inactive');

    // ─────────────────────────────────────────────────────────────────────
    // Part B — analytics_snapshots emptied: fallback paths for
    // getSurfaceBreakdown + getTopUsers, plus getDepartmentBreakdown (which
    // never touches analytics_snapshots at all).
    // ─────────────────────────────────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).delete(schema.analyticsSnapshots);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).insert(schema.otelEvents).values([
      { id: 'oe-1', occurred_at: TODAY_TS, event_type: 'user_prompt', surface: 'chat' },
      { id: 'oe-2', occurred_at: TODAY_TS, event_type: 'tool_decision', surface: 'code' },
    ]);

    // ── getSurfaceBreakdown: FALLBACK path (CASE WHEN aggregates over
    //    cowork_messages + otel_events + chat_messages) ──────────────────
    // agentCowork = COUNT of rows with surface IN ('cowork', NULL): cw-1..6 = 6.
    // codeFromAgent = COUNT of surface='code' cowork_messages: cw-7,cw-8 = 2.
    // otel.chat=1 (oe-1), otel.code=1 (oe-2). chatFromAgent = 4 (chm-1..4).
    const surfaceFallback = await getSurfaceBreakdown();
    expect(surfaceFallback).toEqual({ chat: 1 + 4, code: 1 + 2, agentCowork: 6, otelCowork: 0 });
    expect(typeof surfaceFallback.agentCowork).toBe('number');

    // ── getTopUsers: FALLBACK path (LEFT JOIN derived per-surface counts,
    //    weekAgo param) ───────
    const topFallback = await getTopUsers(10);
    const topById = new Map(topFallback.map((u) => [u.id, u.total_activity]));
    // user-1: chat=2(chm-1/2), cowork=2(cw-1,cw-3) -> 4.
    expect(topById.get('user-1')).toBe(4);
    // user-2: code=1(cw-7), cowork=2(cw-2,cw-4) -> 3.
    expect(topById.get('user-2')).toBe(3);
    // user-3: cowork=1(cw-5) -> 1.
    expect(topById.get('user-3')).toBe(1);
    // user-6: chat=2(chm-3/4), cowork=1(cw-6) -> 3.
    expect(topById.get('user-6')).toBe(3);
    // user-7: code=1(cw-8) -> 1.
    expect(topById.get('user-7')).toBe(1);
    // user-4/user-5 have zero live activity -> excluded (WHERE total > 0).
    expect(topById.has('user-4')).toBe(false);
    expect(topById.has('user-5')).toBe(false);
    // user-1 is the unique max -> deterministically first.
    expect(topFallback[0].id).toBe('user-1');
    for (const u of topFallback) expect(typeof u.total_activity).toBe('number');

    // ── getDepartmentBreakdown: GROUP BY department, no snapshot involved ──
    // Eng (user-1, user-4, user-6): chat set={user-1,user-6}, code set=
    // {user-2,user-7}, cowork set={user-1,user-2,user-3,user-6}.
    //   surface_chat (Eng members in chat set) = user-1,user-6 -> 2
    //   surface_code (Eng members in code set) = none -> 0
    //   surface_cowork (Eng members in cowork set) = user-1,user-6 -> 2
    //   active_users (last_seen_at set) = user-1,user-6 -> 2; user_count=3
    // Sales (user-2, user-5, user-7): surface_chat=0, surface_code=
    //   user-2,user-7 -> 2, surface_cowork=user-2 -> 1, active_users=0,
    //   user_count=3.
    const depts = await getDepartmentBreakdown();
    const byDept = new Map(depts.map((d) => [d.department, d]));
    expect(byDept.get('Eng')).toEqual({
      department: 'Eng', user_count: 3, active_users: 2,
      surface_chat: 2, surface_code: 0, surface_cowork: 2,
    });
    expect(byDept.get('Sales')).toEqual({
      department: 'Sales', user_count: 3, active_users: 0,
      surface_chat: 0, surface_code: 2, surface_cowork: 1,
    });
    // Eng total (2+0+2=4) > Sales total (0+2+1=3) -> Eng ordered first.
    expect(depts[0].department).toBe('Eng');
    for (const d of depts) {
      expect(typeof d.user_count).toBe('number');
      expect(typeof d.surface_chat).toBe('number');
    }
  } finally {
    await cleanup();
  }
}

describe('analytics snapshots + dashboard aggregates + batch helpers (postgres)', () => {
  it(
    'getSnapshotsForUser/getAdoptionTrend/getSurfaceBreakdown/getTopUsers/... behave correctly on postgres — proves the merge, GROUP BY strictness, and count/bigint coercion',
    async () => {
      await runSpec();
    },
    180_000,
  );
});
