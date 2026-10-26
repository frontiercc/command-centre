// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Regression coverage for the remaining converted pulse routes
// not covered by test/pulse-routes-pg.test.ts: team/
// [teamId], teams, depts, skills-overview, skill-exchange,
// governance-health, and briefing's 'all_users' branch. These are simpler
// conversions (plain query-builder + inArray/groupBy, no tuple-IN-subquery /
// jsonb / date-bucket handling), so coverage here (on Postgres) plus
// the proof already on record for the dept/capabilities/
// user-prefs routes (which share the exact same Number()-coercion +
// query-builder idioms) is sufficient confidence for this task's scope.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';
import { getClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';

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
    requireAdmin: async () => ({ ...mockSession, authenticated: true as const }),
  };
});

vi.mock('@/lib/pulse/briefings/weekly', async (orig) => {
  const actual = await orig<typeof import('@/lib/pulse/briefings/weekly')>();
  return { ...actual, generateUserWeeklyBriefing: vi.fn(async () => {}) };
});

function makeRequest(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`);
}

const NOW = Math.floor(Date.now() / 1000);
const DAY = 24 * 3600;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const h = await createTestDatabase();
  client = await getClient();
  cleanup = () => h.cleanup();

  await client.insert(schema.users).values([
    { id: 'u1', email: 'u1@test.com', display_name: 'Ada Lovelace', team_id: 'team1', department: 'Engineering' },
    { id: 'u2', email: 'u2@test.com', display_name: 'Grace Hopper', team_id: 'team1', department: 'Engineering' },
    { id: 'u3', email: 'u3@test.com', display_name: 'Rear Admiral', team_id: 'team2', department: 'Sales' },
  ]);
  await client.insert(schema.adminUsers).values({
    id: 'admin1', email: 'me@test.com', password_hash: 'x', role: 'admin',
    linked_cowork_user_id: 'u1', department: 'Engineering',
  });

  await client.insert(schema.pulseMetrics).values([
    { scope_type: 'team', scope_id: 'team1', period_start: NOW - 7 * DAY, period_end: NOW, oti: 1.5, dds: 2.2, psr: 3.0, ors: 3.3, event_count: 5, tier_1_count: 1, tier_2_count: 2, tier_3_count: 2, granularity: 'rolling', computed_at: NOW },
    { scope_type: 'user', scope_id: 'u1', period_start: NOW - 7 * DAY, period_end: NOW, dds: 2.8, oti: 1.9, granularity: 'rolling', computed_at: NOW },
    { scope_type: 'user', scope_id: 'u1', period_start: NOW - 30 * DAY, period_end: NOW - 20 * DAY, dds: 1.0, oti: 0.5, granularity: 'rolling', computed_at: NOW - 20 * DAY },
    { scope_type: 'user', scope_id: 'u2', period_start: NOW - 7 * DAY, period_end: NOW, dds: 2.2, oti: 1.6, granularity: 'rolling', computed_at: NOW - DAY },
  ]);

  await client.insert(schema.coworkMessages).values([
    { id: 'cm1', session_id: 's1', user_id: 'u1', message_type: 'cowork_user_message', surface: 'cowork', occurred_at: NOW - 2 * DAY },
    { id: 'cm2', session_id: 's1', user_id: 'u1', message_type: 'cowork_user_message', surface: 'cowork', occurred_at: NOW - 3 * DAY },
  ]);
  await client.insert(schema.pulseClassifications).values([
    { cowork_message_id: 'cm1', user_id: 'u1', tier: 2, task_type: 'drafting', classifier_confidence: 0.9, classifier_model: 'haiku', classifier_status: 'classified', classified_at: NOW - 2 * DAY },
    { cowork_message_id: 'cm2', user_id: 'u1', tier: 3, task_type: 'coding', classifier_confidence: 0.9, classifier_model: 'haiku', classifier_status: 'classified', classified_at: NOW - 2 * DAY },
  ]);

  await client.insert(schema.pulseEvents).values([
    { user_id: 'u1', event_type: 'frontier_push', status: 'confirmed', title: 'Team Frontier', tier: 3, detected_at: NOW - DAY, team_id: 'team1' },
  ]);

  await client.insert(schema.pulseSkills).values({
    skill_name: 'brand-review', team_id: 'team1', author_user_id: 'u1', run_count: 4,
    first_seen_at: NOW - 30 * DAY, last_seen_at: NOW,
  });

  await client.insert(schema.coworkSkillInvocations).values([
    { id: 'si1', user_id: 'u1', session_id: 's1', skill_name: 'brand-review', occurred_at: NOW - DAY },
    { id: 'si2', user_id: 'u1', session_id: 's1', skill_name: 'brand-review', occurred_at: NOW - DAY },
    { id: 'si3', user_id: 'u2', session_id: 's2', skill_name: 'other-skill', occurred_at: NOW - DAY },
  ]);
  await client.insert(schema.coworkMcpInvocations).values([
    { id: 'mi1', user_id: 'u1', session_id: 's1', mcp_server: 'slack', mcp_tool: 'send', occurred_at: NOW - DAY },
    { id: 'mi2', user_id: 'u1', session_id: 's1', mcp_server: 'workspace', mcp_tool: 'read', occurred_at: NOW - DAY },
  ]);

  await client.insert(schema.alerts).values([
    { id: 'a1', alert_type: 'anomaly', severity: 'low', title: 'Alert 1', explanation: 'x', status: 'resolved', generated_at: NOW - DAY },
    { id: 'a2', alert_type: 'anomaly', severity: 'low', title: 'Alert 2', explanation: 'x', status: 'open', generated_at: NOW - DAY },
  ]);
});

afterAll(async () => cleanup());

describe('GET /api/pulse/teams', () => {
  it('groups member count by team_id with Number()-coerced counts', async () => {
    const { GET } = await import('../app/api/pulse/teams/route');
    const res = await GET(makeRequest('/api/pulse/teams'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.teams).toEqual([
      { team_id: 'team1', member_count: 2 },
      { team_id: 'team2', member_count: 1 },
    ]);
    expect(typeof body.teams[0].member_count).toBe('number');
  });
});

describe('GET /api/pulse/team/[teamId]', () => {
  it('returns team metrics, heatmap, skills, and frontier feed', async () => {
    const { GET } = await import('../app/api/pulse/team/[teamId]/route');
    const res = await GET(makeRequest('/api/pulse/team/team1'), { params: Promise.resolve({ teamId: 'team1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.members.map((m: { id: string }) => m.id).sort()).toEqual(['u1', 'u2']);
    expect(body.metrics.ors).toBeCloseTo(3.3, 6);
    expect(body.journeyHeatmap.length).toBeGreaterThan(0);
    expect(body.frontierFeed).toHaveLength(1);
    expect(body.frontierFeed[0].title).toBe('Team Frontier');
    expect(body.skills).toHaveLength(1);
    expect(body.skills[0].skill_name).toBe('brand-review');
  });
});

describe('GET /api/pulse/depts', () => {
  it('averages per-department metrics via the tuple-IN latest-row dedup', async () => {
    const { GET } = await import('../app/api/pulse/depts/route');
    const res = await GET(makeRequest('/api/pulse/depts'));
    expect(res.status).toBe(200);
    const body = await res.json();
    const eng = body.depts.find((d: { department: string }) => d.department === 'Engineering');
    expect(eng.member_count).toBe(2);
    expect(typeof eng.member_count).toBe('number');
    // u1's latest dds=2.8 (not the stale 1.0 row) averaged with u2's 2.2 => 2.5
    expect(eng.avg_dds).toBeCloseTo(2.5, 6);
  });
});

describe('GET /api/pulse/skills-overview', () => {
  it('computes org top skills/connectors and the current-user gap', async () => {
    const { GET } = await import('../app/api/pulse/skills-overview/route');
    const res = await GET(makeRequest('/api/pulse/skills-overview'));
    expect(res.status).toBe(200);
    const body = await res.json();
    const brandReview = body.topSkills.find((s: { skill_name: string }) => s.skill_name === 'brand-review');
    expect(brandReview.usage_count).toBe(2);
    expect(brandReview.user_count).toBe(1);
    // 'workspace' is excluded from connectors (system default).
    expect(body.topConnectors.map((c: { mcp_server: string }) => c.mcp_server)).toEqual(['slack']);
    // admin1 is linked to u1, whose own skills include brand-review -> no gap for it.
    expect(body.mySkills.map((s: { skill_name: string }) => s.skill_name)).toContain('brand-review');
    expect(body.skillGap.find((s: { skill_name: string }) => s.skill_name === 'brand-review')).toBeUndefined();
  });
});

describe('GET /api/pulse/skill-exchange', () => {
  it('computes adoption/concentration for a department', async () => {
    const { GET } = await import('../app/api/pulse/skill-exchange/route');
    const res = await GET(makeRequest('/api/pulse/skill-exchange?dept=Engineering'));
    expect(res.status).toBe(200);
    const body = await res.json();
    const brandReview = body.skills.find((s: { skill_name: string }) => s.skill_name === 'brand-review');
    expect(brandReview.adopter_count).toBe(1);
    expect(brandReview.concentration_risk).toBe(true);
    expect(brandReview.tier_at_use).toBe(3); // MAX(tier) across cm1(tier2)/cm2(tier3) — both share session_id 's1', so the JOIN matches both
    // dept resolution here is admin_users.department -> linked_cowork_user_id
    // (only admin1/u1 is linked with department=Engineering — u2 has no
    // admin_users row so is NOT a dept member for this route), so only u1's
    // 'brand-review' invocations count.
    expect(body.summary.total_distinct_skills).toBe(1);
  });
});

describe('GET /api/pulse/governance-health', () => {
  it('computes queue health and alert acknowledgment with Number()-coerced aggregates', async () => {
    const { GET } = await import('../app/api/pulse/governance-health/route');
    const res = await GET(makeRequest('/api/pulse/governance-health'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.components.alert_acknowledgment.total_alerts).toBe(2);
    expect(body.components.alert_acknowledgment.resolved_alerts).toBe(1);
    expect(body.components.alert_acknowledgment.rate).toBeCloseTo(0.5, 6);
    expect(typeof body.governanceScore).toBe('number');
  });
});

describe('POST /api/pulse/briefing (all_users)', () => {
  it('queries distinct active classified users and invokes the generator per user', async () => {
    const { generateUserWeeklyBriefing } = await import('@/lib/pulse/briefings/weekly');
    const { POST } = await import('../app/api/pulse/briefing/route');
    const res = await POST(new NextRequest('http://localhost/api/pulse/briefing', {
      method: 'POST', body: JSON.stringify({ type: 'all_users' }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.generated).toBe(1); // only u1 has a classified row within 7 days
    expect(body.failed).toBe(0);
    expect(generateUserWeeklyBriefing).toHaveBeenCalledWith('u1', expect.any(Number), expect.any(Number), expect.any(String));
  });
});
