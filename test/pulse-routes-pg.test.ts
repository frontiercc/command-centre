// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Postgres regression test for the /api/pulse/dept/[dept],
// /api/pulse/capabilities, and /api/pulse/user-prefs route handlers' OWN
// inline queries (async Drizzle). Proves on REAL Postgres:
//   - The "latest row per scope" tuple-IN-subquery reads (teamMetricsRow,
//     memberMetrics) correctly dedupe to the newest computed_at row per
//     scope_id (row-value IN subquery).
//   - GROUP BY COUNT aggregates (tier3ByType, deptSkills/deptConnectors)
//     and the per-member COUNT(*) FILTER (WHERE ...) friction query come
//     back as STRINGS on pg and are Number()-coerced correctly.
//   - cowork_session_stats.upload_count SUM (Policy B) and the docSessions
//     COUNT both coerce correctly.
//   - The capabilities PATCH confirm path performs a real UPDATE +
//     conditional INSERT (alert).
//   - The user-prefs POST upsert's ON CONFLICT DO UPDATE touches ONLY the
//     column being set — an existing target_dds survives a
//     pulse_start_at-only write, and vice versa.
//
// Harness mirrors test/pulse-dashboard-routes-pg.test.ts: one runSpec()
// against a migrated Postgres database (createTestDbClient('postgres')). Auth + the one
// already-converted lib helper the dept route calls (getCoworkCostUsd) are
// mocked — everything else in each route hits the REAL database via a fresh
// dynamic import (every module under test is imported AFTER the database env
// is established).
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockSession: { authenticated: boolean; role?: string; email?: string; userId?: string; department?: string | null } = {
  authenticated: true,
  role: 'admin',
  email: 'me@test.com',
  userId: 'admin1',
};

vi.mock('@/lib/auth/admin-auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/admin-auth')>();
  return {
    ...actual,
    getAdminSession: async () => mockSession,
  };
});

vi.mock('@/lib/pulse/aggregator', async (orig) => {
  const actual = await orig<typeof import('@/lib/pulse/aggregator')>();
  return {
    ...actual,
    getCoworkCostUsd: async () => 2.5,
  };
});

vi.mock('@/lib/config', async (orig) => {
  const actual = await orig<typeof import('@/lib/config')>();
  return {
    ...actual,
    getConfigValue: async (key: Parameters<typeof actual.getConfigValue>[0]) =>
      key === 'riskAlertPulseCapabilityEnabled' ? 'true' : actual.getConfigValue(key),
  };
});

function makeRequest(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`);
}

const NOW = Math.floor(Date.now() / 1000);
const DAY = 24 * 3600;

async function runSpec(): Promise<void> {
  const { createTestDbClient } = await import('./helpers/db');
  const h = await createTestDbClient('postgres');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = h.client;
  const cleanup = h.cleanup;

  try {
    const { schema } = await import('@/lib/db/schema');

    // ── Users + admin link (admin1 is "me", linked via admin_users to u1) ──
    await client.insert(schema.users).values([
      { id: 'u1', email: 'u1@test.com', display_name: 'Ada Lovelace', team_id: 'team1', department: 'Engineering' },
      { id: 'u2', email: 'u2@test.com', display_name: 'Grace Hopper', team_id: 'team1', department: 'Engineering' },
    ]);
    await client.insert(schema.adminUsers).values({
      id: 'admin1', email: 'me@test.com', password_hash: 'x', role: 'admin',
      linked_cowork_user_id: 'u1', department: 'Engineering',
    });

    // ── pulse_metrics: team-scope (PSR/ORS), function-scope current+prior
    // (dept metrics), user-scope current+STALE-older (proves the tuple-IN
    // "latest row per scope" dedup — the older u1 row must NOT win) ──
    await client.insert(schema.pulseMetrics).values([
      { scope_type: 'team', scope_id: 'team1', period_start: NOW - 7 * DAY, period_end: NOW, psr: 3.0, ors: 3.3, ors_breadth: 0.5, ors_overlap: 0.4, ors_propagation: 0.3, granularity: 'rolling', computed_at: NOW },
      { scope_type: 'function', scope_id: 'Engineering', period_start: NOW - 7 * DAY, period_end: NOW, oti: 1.5, dds: 2.0, psr: 2.5, ors: 3.0, event_count: 8, tier_1_count: 2, tier_2_count: 4, tier_3_count: 2, ors_breadth: 0.4, ors_overlap: 0.3, ors_propagation: 0.2, granularity: 'rolling', computed_at: NOW },
      { scope_type: 'function', scope_id: 'Engineering', period_start: NOW - 20 * DAY, period_end: NOW - 10 * DAY, oti: 1.0, dds: 1.5, psr: 2.0, ors: 2.5, granularity: 'rolling', computed_at: NOW - 10 * DAY },
      { scope_type: 'user', scope_id: 'u1', period_start: NOW - 7 * DAY, period_end: NOW, dds: 2.8, oti: 1.9, granularity: 'rolling', computed_at: NOW },
      // STALE older row for u1 — must be excluded by the MAX(computed_at) dedup.
      { scope_type: 'user', scope_id: 'u1', period_start: NOW - 30 * DAY, period_end: NOW - 20 * DAY, dds: 1.0, oti: 0.5, granularity: 'rolling', computed_at: NOW - 20 * DAY },
      { scope_type: 'user', scope_id: 'u2', period_start: NOW - 7 * DAY, period_end: NOW, dds: 2.2, oti: 1.6, granularity: 'rolling', computed_at: NOW - DAY },
    ]);

    // ── cowork_messages: 3 cowork_user_message (for classifications) +
    // 3 cowork_tool_metadata (tool_success mix, for the friction FILTER) ──
    await client.insert(schema.coworkMessages).values([
      { id: 'cm1', session_id: 's1', user_id: 'u1', message_type: 'cowork_user_message', surface: 'cowork', occurred_at: NOW - 2 * DAY },
      { id: 'cm2', session_id: 's1', user_id: 'u1', message_type: 'cowork_user_message', surface: 'cowork', occurred_at: NOW - 3 * DAY },
      { id: 'cm3', session_id: 's2', user_id: 'u2', message_type: 'cowork_user_message', surface: 'cowork', occurred_at: NOW - 2 * DAY },
      { id: 'cmt1', session_id: 's1', user_id: 'u1', message_type: 'cowork_tool_metadata', occurred_at: NOW - DAY, tool_success: 1 },
      { id: 'cmt2', session_id: 's1', user_id: 'u1', message_type: 'cowork_tool_metadata', occurred_at: NOW - DAY, tool_success: 0 },
      { id: 'cmt3', session_id: 's2', user_id: 'u2', message_type: 'cowork_tool_metadata', occurred_at: NOW - DAY, tool_success: 1 },
    ]);

    // ── pulse_classifications: u1 tier2 (cm1) + tier3/coding (cm2, within
    // the 2-week concentration window); u2 tier1 (cm3) ──
    await client.insert(schema.pulseClassifications).values([
      { cowork_message_id: 'cm1', user_id: 'u1', tier: 2, task_type: 'drafting', classifier_confidence: 0.9, classifier_model: 'haiku', classifier_status: 'classified', classified_at: NOW - 2 * DAY },
      { cowork_message_id: 'cm2', user_id: 'u1', tier: 3, task_type: 'coding', classifier_confidence: 0.9, classifier_model: 'haiku', classifier_status: 'classified', classified_at: NOW - 3 * DAY },
      { cowork_message_id: 'cm3', user_id: 'u2', tier: 1, task_type: 'chat', classifier_confidence: 0.9, classifier_model: 'haiku', classifier_status: 'classified', classified_at: NOW - 2 * DAY },
    ]);

    // ── skill/connector invocations (sole-user concentration + tools-used) ──
    await client.insert(schema.coworkSkillInvocations).values([
      { id: 'si1', user_id: 'u1', session_id: 's1', skill_name: 'brand-review', occurred_at: NOW - DAY },
    ]);
    await client.insert(schema.coworkMcpInvocations).values([
      { id: 'mi1', user_id: 'u1', session_id: 's1', mcp_server: 'slack', mcp_tool: 'send', occurred_at: NOW - DAY },
    ]);

    // ── pulse_events: a confirmed frontier_push (hero/milestone/feed) + two
    // candidate capability_creation rows (one links to cm1 for the task_type
    // LEFT JOIN in the capabilities route; the other has no cowork_message_id
    // and is the one the PATCH test confirms) ──
    await client.insert(schema.pulseEvents).values([
      { user_id: 'u1', event_type: 'frontier_push', status: 'confirmed', title: 'Frontier Push', tier: 3, detected_at: NOW - 3 * DAY, team_id: 'team1' },
      { user_id: 'u1', event_type: 'capability_creation', status: 'candidate', title: 'Cap One', tier: 2, detected_at: NOW - 3 * DAY, cowork_message_id: 'cm1' },
      { user_id: 'u1', event_type: 'capability_creation', status: 'candidate', title: 'Cap Two', tier: 2, detected_at: NOW - 4 * DAY },
    ]);

    // ── pulse_briefings (function scope) ──
    await client.insert(schema.pulseBriefings).values({
      scope_type: 'function', scope_id: 'Engineering', period_start: NOW - 7 * DAY, period_end: NOW,
      body: 'Dept doing well', suggestion: 'Keep going', model: 'haiku', generated_at: NOW,
    });

    // ── cowork_sessions + cowork_session_stats (docSessions upload SUM) ──
    await client.insert(schema.coworkSessions).values({
      id: 'cs1', conversation_id: 'conv1', user_id: 'u1', started_at: NOW - DAY,
    });
    await client.insert(schema.coworkSessionStats).values({
      session_id: 'cs1', user_id: 'u1', upload_count: 2, computed_at: NOW,
    });

    // ═══════════════════════════ /api/pulse/dept/[dept] ═══════════════════════════
    const { GET: deptGET } = await import('../app/api/pulse/dept/[dept]/route');
    const deptRes = await deptGET(makeRequest('/api/pulse/dept/Engineering'), { params: Promise.resolve({ dept: 'Engineering' }) });
    expect(deptRes.status).toBe(200);
    const deptBody = await deptRes.json();

    expect(deptBody.members.map((m: { id: string }) => m.id).sort()).toEqual(['u1', 'u2']);

    // Tuple-IN "latest row per scope" dedup — team-level PSR/ORS averaged
    // across team1 (the only team with dept members).
    expect(deptBody.teamMetrics.psr).toBeCloseTo(3.0, 6);
    expect(deptBody.teamMetrics.ors).toBeCloseTo(3.3, 6);
    expect(deptBody.teamMetrics.orsBreadth).toBeCloseTo(0.5, 6);

    // Function-scope current + prior dept metrics.
    expect(deptBody.metrics.oti).toBeCloseTo(1.5, 6);
    expect(deptBody.metrics.dds).toBeCloseTo(2.0, 6);
    expect(deptBody.metrics.tier_2_count).toBe(4);
    expect(deptBody.priorMetrics.oti).toBeCloseTo(1.0, 6);
    expect(deptBody.priorMetrics.dds).toBeCloseTo(1.5, 6);

    // Per-member "latest row" dedup: u1's STALE dds=1.0 row must NOT win —
    // the current dds=2.8 row does. Ordered DESC NULLS LAST by dds, so u1
    // (2.8) sorts before u2 (2.2).
    expect(deptBody.memberMetrics).toHaveLength(2);
    expect(deptBody.memberMetrics[0].id).toBe('u1');
    expect(deptBody.memberMetrics[0].dds).toBeCloseTo(2.8, 6);
    expect(deptBody.memberMetrics[0].oti).toBeCloseTo(1.9, 6);
    expect(deptBody.memberMetrics[0].last_active).toBe(NOW - 2 * DAY);
    expect(deptBody.memberMetrics[1].id).toBe('u2');
    expect(deptBody.memberMetrics[1].dds).toBeCloseTo(2.2, 6);

    // Journey heatmap — 3 classified rows within the 6-week window.
    expect(deptBody.journeyHeatmap).toHaveLength(3);
    expect(deptBody.journeyHeatmap).toContainEqual({ week: 0, tier: 2, count: 1 });
    expect(deptBody.journeyHeatmap).toContainEqual({ week: 0, tier: 3, count: 1 });
    expect(deptBody.journeyHeatmap).toContainEqual({ week: 0, tier: 1, count: 1 });

    // Concentration: u1 is the sole runner of 1 tier-3 task type ('coding')
    // in the past 2 weeks — below the >=3 risk threshold, so risk is empty
    // but the detail list still surfaces it.
    expect(deptBody.concentrationRisk).toEqual([]);
    expect(deptBody.concentrationDetail).toContainEqual({ user_id: 'u1', display_name: 'Ada Lovelace', task_types: ['coding'] });

    // Skill concentration: u1 is the sole user of 'brand-review'.
    expect(deptBody.skillConcentration).toContainEqual({ user_id: 'u1', display_name: 'Ada Lovelace', skills: ['brand-review'] });

    // Frontier boxes, computed from classifications, not the
    // template events. Session s1 (u1) collapses to Tier 3 'coding' — the label
    // used at its highest tier — and carries its connector and skill.
    expect(deptBody.frontier.tier3People).toBe(1);
    expect(deptBody.frontier.bestWork).toHaveLength(2); // one per person
    expect(deptBody.frontier.bestWork[0]).toMatchObject({ displayName: 'Ada Lovelace', taskType: 'coding', tier: 3 });
    expect(deptBody.frontier.bestWork[0].facts.connectors).toEqual(['slack']);
    expect(deptBody.frontier.bestWork[0].facts.skills).toEqual(['brand-review']);
    // 'Cap One' links to a session (cm1 → s1); 'Cap Two' has none and is not shown,
    // but both count as awaiting review. No prompt text travels with either.
    expect(deptBody.frontier.capabilities).toHaveLength(1);
    expect(deptBody.frontier.capabilities[0].capability.status).toBe('candidate');
    expect(deptBody.frontier.capabilityPending).toBe(2);
    expect(JSON.stringify(deptBody.frontier)).not.toContain('body');
    expect(deptBody.frontier.mainstay).toBeNull();

    // GROUP BY count coercion — tools used in the last 7 days.
    expect(deptBody.toolsUsed).toHaveLength(2);
    expect(deptBody.toolsUsed).toContainEqual({ name: 'brand-review', type: 'skill', count: 1 });
    expect(deptBody.toolsUsed).toContainEqual({ name: 'slack', type: 'connector', count: 1 });

    // Feed — new capabilities, last 30 days.
    expect(deptBody.frontier.feed).toHaveLength(1);
    expect(deptBody.frontier.feed[0].displayName).toBe('Ada Lovelace');

    expect(deptBody.deptBriefing.body).toBe('Dept doing well');

    // COUNT + SUM coercion — doc-upload sessions.
    expect(deptBody.docSessions).toEqual({ sessions_with_uploads: 1, total_uploads: 2 });
    expect(typeof deptBody.docSessions.total_uploads).toBe('number');

    // Mocked getCoworkCostUsd summed across 2 members.
    expect(deptBody.coworkCostUsd).toBeCloseTo(5.0, 6);

    // COUNT(*) FILTER friction coercion, summed across members:
    // u1 → 1 failed / 2 total; u2 → 0 failed / 1 total. Combined 1/3.
    expect(deptBody.coworkFrictionIndex).toBeCloseTo(1 / 3, 6);

    // ═══════════════════════════ /api/pulse/capabilities ═══════════════════════════
    const { GET: capGET, PATCH: capPATCH } = await import('../app/api/pulse/capabilities/route');

    const capRes = await capGET(makeRequest('/api/pulse/capabilities'));
    expect(capRes.status).toBe(200);
    const capBody = await capRes.json();
    expect(capBody.pendingCount).toBe(2);
    const capTitles = capBody.candidates.map((c: { title: string }) => c.title);
    expect(capTitles).toEqual(['Cap One', 'Cap Two']); // ORDER BY detected_at DESC
    // LEFT JOIN to pulse_classifications via cowork_message_id — 'Cap One' resolves task_type, 'Cap Two' has none.
    const capOne = capBody.candidates.find((c: { title: string }) => c.title === 'Cap One');
    const capTwo = capBody.candidates.find((c: { title: string }) => c.title === 'Cap Two');
    expect(capOne.task_type).toBe('drafting');
    expect(capTwo.task_type).toBeNull();

    // scope=user branch (linked_cowork_user_id lookup) — same candidates since both belong to u1.
    const capScopedRes = await capGET(makeRequest('/api/pulse/capabilities?scope=user'));
    const capScopedBody = await capScopedRes.json();
    expect(capScopedBody.pendingCount).toBe(2);

    // PATCH confirm 'Cap Two' — real UPDATE + conditional alert INSERT.
    const capTwoId = capTwo.id;
    const patchRes = await capPATCH(new NextRequest('http://localhost/api/pulse/capabilities', {
      method: 'PATCH',
      body: JSON.stringify({ id: capTwoId, action: 'confirm' }),
    }));
    expect(patchRes.status).toBe(200);
    const patchBody = await patchRes.json();
    expect(patchBody.status).toBe('confirmed');

    const updatedRows = await client.select({ status: schema.pulseEvents.status, confirmed_at: schema.pulseEvents.confirmed_at })
      .from(schema.pulseEvents).where((await import('drizzle-orm')).eq(schema.pulseEvents.id, capTwoId));
    expect(updatedRows[0].status).toBe('confirmed');
    expect(updatedRows[0].confirmed_at).not.toBeNull();

    const alertRows = await client.select({ title: schema.alerts.title, alert_type: schema.alerts.alert_type })
      .from(schema.alerts).where((await import('drizzle-orm')).eq(schema.alerts.alert_type, 'pulse_capability'));
    expect(alertRows).toHaveLength(1);
    expect(alertRows[0].title).toBe('Capability confirmed: Ada Lovelace');

    // ═══════════════════════════ /api/pulse/user-prefs ═══════════════════════════
    const { GET: prefsGET, POST: prefsPOST } = await import('../app/api/pulse/user-prefs/route');

    const beforeRes = await prefsGET(makeRequest('/api/pulse/user-prefs'));
    const beforeBody = await beforeRes.json();
    expect(beforeBody).toEqual({ target_dds: null, pulse_start_at: null });

    const postDdsRes = await prefsPOST(new NextRequest('http://localhost/api/pulse/user-prefs', {
      method: 'POST', body: JSON.stringify({ target_dds: 2 }),
    }));
    expect(postDdsRes.status).toBe(200);

    const afterDdsRes = await prefsGET(makeRequest('/api/pulse/user-prefs'));
    const afterDdsBody = await afterDdsRes.json();
    expect(afterDdsBody.target_dds).toBeCloseTo(2, 6);
    expect(afterDdsBody.pulse_start_at).toBeNull();

    // Second upsert (pulse_start_at only) — ON CONFLICT DO UPDATE must touch
    // ONLY pulse_start_at/set_at; target_dds=2 from the prior write survives.
    const postStartRes = await prefsPOST(new NextRequest('http://localhost/api/pulse/user-prefs', {
      method: 'POST', body: JSON.stringify({ pulse_start_at: '2026-01-01' }),
    }));
    expect(postStartRes.status).toBe(200);

    const afterStartRes = await prefsGET(makeRequest('/api/pulse/user-prefs'));
    const afterStartBody = await afterStartRes.json();
    expect(afterStartBody.target_dds).toBeCloseTo(2, 6); // survived the pulse_start_at-only upsert
    expect(afterStartBody.pulse_start_at).toBe(Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000));
  } finally {
    await cleanup();
  }
}

describe('pulse dept/capabilities/user-prefs routes (postgres)', () => {
  it(
    'return correctly-aggregated JSON with tuple-IN latest-row dedup, GROUP BY/FILTER counts, and ON-CONFLICT partial-column upserts coerced correctly on real postgres',
    async () => {
      await runSpec();
    },
    180_000,
  );
});
