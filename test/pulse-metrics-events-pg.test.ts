// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Postgres coverage for lib/pulse/metrics/{dds,oti,ors,psr}.ts
// + lib/pulse/events/{frontier,capability}.ts, against a migrated Postgres
// database (createTestDbClient('postgres')).
//
// HARNESS RULE (copied from queries-users-pg.test.ts / queries-analytics-
// dashboard-pg.test.ts): the modules-under-test (and schema) are
// DYNAMIC-imported AFTER createTestDbClient() has set the database env +
// reset modules.
//
// Coverage: computeDdsForUsers/computeOtiForUsers
// exercise the GROUP BY batch paths (Policy B count/bigint→Number coercion
// on real aggregate rows); computeTeamOrsDetail exercises the heaviest
// multi-join + DISTINCT path; computeTeamPsr exercises a join+aggregate;
// detectFrontierPushes is the one WRITE path asserted on real inserted rows.
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

async function runSpec(): Promise<void> {
  const { createTestDbClient } = await import('./helpers/db');
  const { client, cleanup } = await createTestDbClient('postgres');
  try {
    // Dynamic import AFTER the database env + module reset (harness rule).
    const { schema } = await import('@/lib/db/schema');
    const dds = await import('@/lib/pulse/metrics/dds');
    const oti = await import('@/lib/pulse/metrics/oti');
    const ors = await import('@/lib/pulse/metrics/ors');
    const psr = await import('@/lib/pulse/metrics/psr');
    const frontier = await import('@/lib/pulse/events/frontier');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = client as any;

    // ── Seed: users on team-1, dept 'Engineering' via admin_users link ─────
    await db.insert(schema.users).values([
      { id: 'user-1', email: 'u1@test.local', team_id: 'team-1' },
      { id: 'user-2', email: 'u2@test.local', team_id: 'team-1' },
      { id: 'user-3', email: 'u3@test.local' }, // no team — used for OTI/DDS batch-vs-single check
    ]);
    await db.insert(schema.adminUsers).values([
      {
        id: 'admin-1', email: 'admin1@test.local', password_hash: 'x',
        department: 'Engineering', linked_cowork_user_id: 'user-1',
      },
    ]);

    let msgSeq = 0;
    let classSeq = 0;
    async function seedClassification(
      userId: string, tier: number, taskType: string, occurredAt: number,
      opts: { frontierPushCandidate?: number } = {},
    ): Promise<number> {
      const msgId = `msg-${++msgSeq}`;
      await db.insert(schema.coworkMessages).values({
        id: msgId, session_id: `sess-${msgId}`, user_id: userId, message_type: 'cowork_user_message',
        role: 'user', content_preview: 'do the thing', occurred_at: occurredAt,
      });
      const id = ++classSeq;
      await db.insert(schema.pulseClassifications).values({
        id, cowork_message_id: msgId, user_id: userId, tier, task_type: taskType,
        frontier_push_candidate: opts.frontierPushCandidate ?? 0,
        classifier_confidence: 0.9, classifier_model: 'test-model',
        classifier_status: 'classified', classified_at: occurredAt,
      });
      return id;
    }

    // ── computeDdsForUsers: GROUP BY batch matches per-user single-shot ─────
    // user-1: mixed tiers within the rolling 14-day window.
    await seedClassification('user-1', 1, 'general', NOW - 2 * DAY);
    await seedClassification('user-1', 2, 'general', NOW - 1 * DAY);
    await seedClassification('user-1', 3, 'general', NOW - 1 * DAY);
    // user-2: all Tier 3.
    await seedClassification('user-2', 3, 'general', NOW - 1 * DAY);
    await seedClassification('user-2', 3, 'general', NOW - 2 * DAY);
    // user-3: no activity at all.

    const ddsMap = await dds.computeDdsForUsers(['user-1', 'user-2', 'user-3']);
    const expectedDds1 = await dds.computeUserDds('user-1');
    const expectedDds2 = await dds.computeUserDds('user-2');
    expect(ddsMap.get('user-1')).toBeCloseTo(expectedDds1 as number, 10);
    expect(ddsMap.get('user-2')).toBeCloseTo(expectedDds2 as number, 10);
    // user-1: 1xT1 + 1xT2 + 1xT3 → (1 + 2 + 3) / 3 = 2.0
    expect(ddsMap.get('user-1')).toBeCloseTo(2.0, 5);
    // user-2: 2xT3 → (3 + 3) / 2 = 3.0
    expect(ddsMap.get('user-2')).toBeCloseTo(3.0, 5);
    expect(ddsMap.get('user-3')).toBeNull();

    // ── computeOtiForUsers: GROUP BY batch matches per-user single-shot,
    //    each user has their OWN baseline window (distinct GROUP BY buckets) ─
    // user-1's baseline (first 7 days of THEIR history) starts ~40 days ago.
    await seedClassification('user-1', 1, 'general', NOW - 40 * DAY);
    await seedClassification('user-1', 1, 'general', NOW - 39 * DAY);
    // user-2's baseline starts ~20 days ago (a distinct window from user-1's).
    await seedClassification('user-2', 1, 'general', NOW - 20 * DAY);
    await seedClassification('user-2', 2, 'general', NOW - 19 * DAY);

    const otiMap = await oti.computeOtiForUsers(['user-1', 'user-2', 'user-3']);
    const expectedOti1 = await oti.computeUserOti('user-1');
    const expectedOti2 = await oti.computeUserOti('user-2');
    // OTI v2: batch path uses the same pure helper as per-user, so results match exactly.
    expect(otiMap.get('user-1')).toEqual(expectedOti1);
    expect(otiMap.get('user-2')).toEqual(expectedOti2);
    expect(otiMap.get('user-3')).toBeNull();

    // ── computeTeamOrsDetail: multi-join + DISTINCT (breadth/overlap/propagation) ─
    // user-1 and user-2 are both Tier 2+ active within 30d (from the DDS seeds
    // above); add a shared MCP connector + a shared skill to light up all
    // three components. The connector-overlap join requires the SESSION used
    // to have a tier>=2 classification, so these use msg-2 (user-1, Tier 2)
    // and msg-4 (user-2, Tier 3) — NOT msg-1, which is user-1's Tier 1 seed.
    await db.insert(schema.coworkMcpInvocations).values([
      { id: 'mcp-1', user_id: 'user-1', session_id: `sess-msg-2`, mcp_server: 'linear', mcp_tool: 'search', occurred_at: NOW - 1 * DAY },
      { id: 'mcp-2', user_id: 'user-2', session_id: `sess-msg-4`, mcp_server: 'linear', mcp_tool: 'search', occurred_at: NOW - 1 * DAY },
    ]);
    await db.insert(schema.coworkSkillInvocations).values([
      { id: 'skill-1', user_id: 'user-1', session_id: `sess-msg-2`, skill_name: 'shared-skill', occurred_at: NOW - 1 * DAY },
      { id: 'skill-2', user_id: 'user-2', session_id: `sess-msg-4`, skill_name: 'shared-skill', occurred_at: NOW - 1 * DAY },
    ]);

    const orsDetail = await ors.computeTeamOrsDetail('team-1');
    expect(orsDetail).not.toBeNull();
    expect(orsDetail!.breadth).toBeCloseTo(1.0, 5); // both active members are Tier 2+
    expect(orsDetail!.overlap).toBeCloseTo(1.0, 5); // both share the one connector
    expect(orsDetail!.propagation).toBeCloseTo(1.0, 5); // the one skill is shared by both
    expect(orsDetail!.ors).toBeCloseTo(1.0, 5);

    // ── computeTeamPsr: join + division ──────────────────────────────────
    await db.insert(schema.pulseBaselines).values({
      team_id: 'team-1', baseline_process_count: 10, set_by: 'user-1', set_at: NOW,
    });
    await db.insert(schema.pulseEvents).values([
      { user_id: 'user-1', event_type: 'capability_creation', status: 'confirmed', title: 'cap 1', detected_at: NOW },
      { user_id: 'user-2', event_type: 'capability_creation', status: 'confirmed', title: 'cap 2', detected_at: NOW },
      { user_id: 'user-1', event_type: 'capability_creation', status: 'candidate', title: 'cap 3 (not confirmed)', detected_at: NOW },
    ]);
    const psrResult = await psr.computeTeamPsr('team-1');
    expect(psrResult).toBeCloseTo(0.2, 5); // 2 confirmed / 10 baseline

    // ── suggestBaselineProcessCount: COUNT(DISTINCT task_type) join ────────
    // team-1's classified task_types so far: 'general' only (from the DDS/OTI
    // seeds above, all within 30d) → distinct count is 1.
    const suggestion = await psr.suggestBaselineProcessCount('team-1');
    expect(suggestion).toBe(1);

    // ── detectFrontierPushes: the ONE write path, asserted on a real row ────
    const frontierId = await seedClassification('user-1', 3, 'novel_capability', NOW, { frontierPushCandidate: 1 });
    await frontier.detectFrontierPushes([frontierId]);

    const eventRows = (await db.select().from(schema.pulseEvents).where(
      eq(schema.pulseEvents.user_id, 'user-1'),
    )) as Array<{ event_type: string; status: string; tier: number | null }>;
    const eventTypes = eventRows.map((r) => r.event_type);
    // This is user-1's first-ever Tier 3 classification to reach
    // detectFrontierPushes (the earlier Tier 3 seed above was never passed
    // through the detector), so tier_3_first fires alongside frontier_push —
    // the real WRITE assertion is that both land as real 'confirmed' rows.
    expect(eventTypes).toContain('tier_3_first');
    expect(eventTypes).toContain('frontier_push');
    const frontierPushRow = eventRows.find((r) => r.event_type === 'frontier_push');
    expect(frontierPushRow?.status).toBe('confirmed');
  } finally {
    await cleanup();
  }
}

describe('pulse metrics + events (postgres)', () => {
  it(
    'DDS/OTI batch parity, ORS multi-join, PSR join, and a real frontier-push write behave correctly on postgres',
    async () => {
      await runSpec();
    },
    180_000,
  );
});
