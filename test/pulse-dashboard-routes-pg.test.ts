// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Postgres regression test for the /api/pulse/me,
// /api/pulse/cio, and /api/pulse/org-summary route handlers' OWN inline
// queries (async Drizzle). Proves on REAL Postgres:
//   - GROUP BY counts (skills/connectors used, tier breakdowns, tier-3 user
//     counts, top skills/connectors/model-mix) come back as STRINGS on pg
//     and are Number()-coerced correctly.
//   - cowork_messages.cost_usd (numeric on pg) SUMs correctly via Number().
//   - The cio route's month-bucket date expression (to_char(...)
//     AT TIME ZONE 'UTC') buckets into the correct UTC month.
//   - otel_events.tool_input (jsonb) decision extraction (Policy A jsonb
//     read, ->>'decision') counts correctly.
//
// Harness mirrors test/finance-connector-digest-pg.test.ts: one runSpec()
// against a migrated Postgres database (createTestDbClient('postgres')). Auth + the two
// already-converted lib helpers the routes call (getCoworkCostUsd/
// getCoworkFrictionIndex, getFileCategoryMix) are mocked — everything else in
// the route hits the REAL database via a fresh dynamic import (every module
// under test is imported AFTER the database env is established).
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockSession: { authenticated: boolean; role?: string; email?: string; department?: string | null } = {
  authenticated: true,
  role: 'admin',
  email: 'me@test.com',
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
    getCoworkCostUsd: async () => 5.25,
    getCoworkFrictionIndex: async () => 0.1,
  };
});

vi.mock('@/lib/pulse/cowork/file-categories', async (orig) => {
  const actual = await orig<typeof import('@/lib/pulse/cowork/file-categories')>();
  return {
    ...actual,
    getFileCategoryMix: async () => [],
  };
});

function makeRequest(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`);
}

const NOW = Math.floor(Date.now() / 1000);
const DAY = 24 * 3600;

// Month-boundary anchor for the classified fixture rows (cm1/cm2/cm3/cm7).
// The cio adoption funnel buckets by the UTC calendar month of classified_at,
// and these rows sit 2–4 days back — so in the first 4 UTC days of a month a
// NOW-anchored fixture lands in the PREVIOUS month (or straddles two), while
// a naive `expectedMonth` derived from NOW picks the current one. This failed
// for real. Anchoring at NOW-3d+1h during
// those first 4 days keeps all three offsets (BASE-2d..BASE-4d) inside ONE
// month AND inside the route's 7-day weekly-active window (BASE-4d =
// NOW-7d+1h at worst); from day 5 onward NOW itself is safe. Invariants
// (same-month, within-7d, never-future) verified by sweep over every date
// 2024–2027 — zero violations.
const DAY_OF_MONTH_UTC = new Date(NOW * 1000).getUTCDate();
const CLASS_BASE = DAY_OF_MONTH_UTC >= 5 ? NOW : NOW - 3 * DAY + 3600;

async function runSpec(): Promise<void> {
  const { createTestDbClient } = await import('./helpers/db');
  const h = await createTestDbClient('postgres');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = h.client;
  const cleanup = h.cleanup;

  try {
    const { schema } = await import('@/lib/db/schema');
    const { textToJsonValue } = await import('@/lib/db/json');
    const { weekStarts } = await import('@/lib/pulse/period');

    // ── Users + admin link (u1 is "me", linked via admin_users) ──
    await client.insert(schema.users).values([
      { id: 'u1', email: 'u1@test.com', display_name: 'Ada Lovelace', team_id: 'team1' },
      { id: 'u2', email: 'u2@test.com', display_name: 'Grace Hopper', team_id: 'team1' },
    ]);
    await client.insert(schema.adminUsers).values({
      id: 'admin1', email: 'me@test.com', password_hash: 'x', role: 'admin',
      linked_cowork_user_id: 'u1', department: 'Engineering',
    });

    // ── pulse_metrics: user-scope rolling (current + prior) + function-scope
    // (department) ORS — 'function' is the scope real deployments actually
    // populate (users.team_id is never written), matching admin1's
    // department='Engineering' above. ──
    await client.insert(schema.pulseMetrics).values([
      { scope_type: 'user', scope_id: 'u1', period_start: NOW - 7 * DAY, period_end: NOW, oti: 1.8, dds: 2.5, event_count: 10, tier_1_count: 3, tier_2_count: 5, tier_3_count: 2, granularity: 'rolling', computed_at: NOW },
      { scope_type: 'user', scope_id: 'u1', period_start: NOW - 14 * DAY, period_end: NOW - 7 * DAY, oti: 1.0, dds: 2.0, event_count: 4, tier_1_count: 2, tier_2_count: 1, tier_3_count: 1, granularity: 'rolling', computed_at: NOW - 10 * DAY },
      { scope_type: 'function', scope_id: 'Engineering', period_start: NOW - 7 * DAY, period_end: NOW, ors: 3.3, ors_breadth: 0.5, ors_overlap: 0.4, ors_propagation: 0.3, granularity: 'rolling', computed_at: NOW },
    ]);

    // 8 weekly org-wide rows (user scope) for the cio weeklyVolume trend —
    // event_count = index+1 (1..8), tier_3_count = index (0..7) so the
    // completed-week delta is deterministic: current(week7)=7 prior(week6)=6,
    // tier3 current=6 prior=5 (last row is the partial current week, excluded).
    const weeks = weekStarts(NOW, 8);
    await client.insert(schema.pulseMetrics).values(
      weeks.map((ws, i) => ({
        scope_type: 'user', scope_id: 'u1', period_start: ws, period_end: ws + 7 * DAY,
        event_count: i + 1, tier_3_count: i, granularity: 'week', computed_at: NOW,
      }))
    );

    // ── pulse_events: frontier push + capability creations (org PSR + capabilityLog) ──
    const t3day = NOW - 3 * DAY;
    await client.insert(schema.pulseEvents).values([
      { user_id: 'u1', event_type: 'frontier_push', status: 'confirmed', title: 'Frontier Push', tier: 3, detected_at: t3day, confirmed_at: t3day, team_id: 'team1' },
      { user_id: 'u1', event_type: 'capability_creation', status: 'confirmed', title: 'Cap One', tier: 2, detected_at: t3day, confirmed_at: t3day },
      { user_id: 'u1', event_type: 'capability_creation', status: 'confirmed', title: 'Cap Two', tier: 2, detected_at: t3day - DAY, confirmed_at: t3day - DAY },
      { user_id: 'u1', event_type: 'capability_creation', status: 'candidate', title: 'Cap Pending', tier: 1, detected_at: t3day },
      { user_id: 'u2', event_type: 'capability_creation', status: 'confirmed', title: 'Cap U2', tier: 2, detected_at: t3day, confirmed_at: t3day },
    ]);

    // ── cowork_messages: cowork_user_message (for classifications/pending)
    // + cowork_api_request (numeric cost_usd + model, for org cost SUM +
    // modelMix GROUP BY) ──
    await client.insert(schema.coworkMessages).values([
      { id: 'cm1', session_id: 's1', user_id: 'u1', message_type: 'cowork_user_message', surface: 'cowork', occurred_at: CLASS_BASE - 2 * DAY },
      { id: 'cm2', session_id: 's1', user_id: 'u1', message_type: 'cowork_user_message', surface: 'cowork', occurred_at: CLASS_BASE - 3 * DAY },
      { id: 'cm3', session_id: 's2', user_id: 'u2', message_type: 'cowork_user_message', surface: 'cowork', occurred_at: CLASS_BASE - 2 * DAY },
      { id: 'cm7', session_id: 's1', user_id: 'u1', message_type: 'cowork_user_message', surface: 'cowork', occurred_at: CLASS_BASE - 4 * DAY },
      // Unclassified pending message for u1 (proves pendingClassifications NOT-IN count)
      { id: 'cm4', session_id: 's1', user_id: 'u1', message_type: 'cowork_user_message', surface: 'cowork', occurred_at: NOW - DAY },
      // Cowork API requests with real money (numeric) + model, for cost SUM + modelMix
      { id: 'cm5', session_id: 's1', user_id: 'u1', message_type: 'cowork_api_request', occurred_at: NOW - DAY, cost_usd: '2.50', model: 'claude-sonnet-5' },
      { id: 'cm6', session_id: 's2', user_id: 'u2', message_type: 'cowork_api_request', occurred_at: NOW - DAY, cost_usd: '1.75', model: 'claude-haiku-4-5' },
    ]);

    // ── pulse_classifications: u1 has 2x tier-3 (cm2, cm7) + 1x tier-2 (cm1)
    // — unambiguous dominant tier (3) for the adoption-funnel month bucket.
    // u2 has 1x tier-1 (cm3). ──
    await client.insert(schema.pulseClassifications).values([
      { cowork_message_id: 'cm1', user_id: 'u1', tier: 2, task_type: 'drafting', classifier_confidence: 0.9, classifier_model: 'haiku', classifier_status: 'classified', classified_at: CLASS_BASE - 2 * DAY },
      { cowork_message_id: 'cm2', user_id: 'u1', tier: 3, task_type: 'coding', classifier_confidence: 0.9, classifier_model: 'haiku', classifier_status: 'classified', classified_at: CLASS_BASE - 3 * DAY },
      { cowork_message_id: 'cm7', user_id: 'u1', tier: 3, task_type: 'coding', classifier_confidence: 0.9, classifier_model: 'haiku', classifier_status: 'classified', classified_at: CLASS_BASE - 4 * DAY },
      { cowork_message_id: 'cm3', user_id: 'u2', tier: 1, task_type: 'chat', classifier_confidence: 0.9, classifier_model: 'haiku', classifier_status: 'classified', classified_at: CLASS_BASE - 2 * DAY },
    ]);

    // ── pulse_briefings (user + org scope) ──
    await client.insert(schema.pulseBriefings).values([
      { scope_type: 'user', scope_id: 'u1', period_start: NOW - 7 * DAY, period_end: NOW, body: 'Great week', model: 'haiku', generated_at: NOW },
      { scope_type: 'organisation', scope_id: 'org', period_start: NOW - 7 * DAY, period_end: NOW, body: 'Org briefing', model: 'haiku', generated_at: NOW },
    ]);

    // ── pulse_skills (team skill exchange) ──
    await client.insert(schema.pulseSkills).values({
      skill_name: 'brand-review', team_id: 'team1', author_user_id: 'u1', run_count: 4,
      first_seen_at: NOW - 30 * DAY, last_seen_at: NOW,
    });

    // ── cowork_skill_invocations / cowork_mcp_invocations — GROUP BY count
    // coercion proof (3x skill, 2x connector) ──
    await client.insert(schema.coworkSkillInvocations).values([
      { id: 'si1', user_id: 'u1', session_id: 's1', skill_name: 'brand-review', occurred_at: NOW - DAY },
      { id: 'si2', user_id: 'u1', session_id: 's1', skill_name: 'brand-review', occurred_at: NOW - DAY },
      { id: 'si3', user_id: 'u1', session_id: 's1', skill_name: 'brand-review', occurred_at: NOW - DAY },
    ]);
    await client.insert(schema.coworkMcpInvocations).values([
      { id: 'mi1', user_id: 'u1', session_id: 's1', mcp_server: 'slack', mcp_tool: 'send', occurred_at: NOW - DAY },
      // Dedup unique index is (session_id, mcp_server, mcp_tool, occurred_at) —
      // offset by 1s so this is a distinct invocation, not a duplicate.
      { id: 'mi2', user_id: 'u1', session_id: 's1', mcp_server: 'slack', mcp_tool: 'send', occurred_at: NOW - DAY + 1 },
    ]);

    // ── cowork_sessions + cowork_session_stats — native tools JSON array +
    // upload_count (docSessions) ──
    await client.insert(schema.coworkSessions).values({
      id: 'cs1', conversation_id: 'conv1', user_id: 'u1', started_at: NOW - DAY,
    });
    await client.insert(schema.coworkSessionStats).values({
      session_id: 'cs1', user_id: 'u1', unique_tools: JSON.stringify(['bash', 'read']),
      upload_count: 2, computed_at: NOW,
    });

    // ── otel_events: tool_decision rows with jsonb tool_input (Policy A —
    // ->>'decision'). 2 accept, 1 reject. ──
    await client.insert(schema.otelEvents).values([
      { id: 'oe1', user_id: 'u1', event_type: 'tool_decision', tool_input: textToJsonValue(JSON.stringify({ decision: 'accept' })), occurred_at: NOW - DAY },
      { id: 'oe2', user_id: 'u1', event_type: 'tool_decision', tool_input: textToJsonValue(JSON.stringify({ decision: 'reject' })), occurred_at: NOW - DAY },
      { id: 'oe3', user_id: 'u1', event_type: 'tool_decision', tool_input: textToJsonValue(JSON.stringify({ decision: 'accept' })), occurred_at: NOW - DAY },
    ]);

    // ═══════════════════════════ /api/pulse/me ═══════════════════════════
    const { GET: meGET } = await import('../app/api/pulse/me/route');
    const meRes = await meGET(makeRequest('/api/pulse/me'));
    expect(meRes.status).toBe(200);
    const meBody = await meRes.json();

    expect(meBody.userId).toBe('u1');
    expect(meBody.department).toBe('Engineering');
    expect(meBody.metrics.oti).toBeCloseTo(1.8, 6);
    expect(meBody.metrics.dds).toBeCloseTo(2.5, 6);
    expect(meBody.metrics.tier_1_count).toBe(3);
    expect(meBody.priorMetrics.oti).toBeCloseTo(1.0, 6);

    // NOT-IN-subquery COUNT: only cm4 is unclassified for u1.
    expect(meBody.pendingClassifications).toBe(1);
    expect(typeof meBody.pendingClassifications).toBe('number');

    // 2 confirmed capability_creation rows for u1 (Cap One, Cap Two) — Cap
    // Pending is a candidate, Cap U2 belongs to u2.
    expect(meBody.capabilitiesDetail.count).toBe(2);
    expect(meBody.capabilitiesDetail.confirmed).toHaveLength(2);
    expect(meBody.capabilitiesDetail.pending).toHaveLength(1);

    // GROUP BY count coercion proof (skills/connectors used).
    const toolsMap = new Map(meBody.toolsUsed.map((t: { name: string; count: number }) => [t.name, t.count]));
    expect(toolsMap.get('brand-review')).toBe(3);
    expect(typeof toolsMap.get('brand-review')).toBe('number');
    expect(toolsMap.get('slack')).toBe(2);

    // Native tools JSON aggregation.
    expect(meBody.topNativeTools.map((t: { tool_name: string }) => t.tool_name).sort()).toEqual(['bash', 'read']);

    // ORS resolves via the preferred dept-scope (scope_type='function') path,
    // matching admin1's linked department — the realistic case, since
    // users.team_id is never populated in any real deployment.
    expect(meBody.teamMetrics.ors).toBeCloseTo(3.3, 6);

    // Mocked OTel enrichment passthroughs.
    expect(meBody.coworkCostUsd).toBe(5.25);
    expect(meBody.coworkFrictionIndex).toBe(0.1);

    expect(meBody.skillExchange).toHaveLength(1);
    expect(meBody.skillExchange[0].skill_name).toBe('brand-review');

    // ═══════════════════════════ /api/pulse/cio ═══════════════════════════
    const { GET: cioGET } = await import('../app/api/pulse/cio/route');
    const cioRes = await cioGET(makeRequest('/api/pulse/cio'));
    expect(cioRes.status).toBe(200);
    const cioBody = await cioRes.json();

    // COUNT(DISTINCT user_id) coercion: u1 + u2 both classified within 7 days.
    expect(cioBody.adoptionHero.weeklyActive).toBe(2);
    expect(cioBody.adoptionHero.totalActive).toBe(2);

    // Tier breakdown (30d): u1 has 1x tier2 (cm1) + 2x tier3 (cm2,cm7); u2 has
    // 1x tier1 (cm3). meaningfulWorkPct = round((1+2)/4*100) = 75.
    expect(cioBody.adoptionHero.meaningfulWorkPct).toBe(75);

    // Tier-3 concentration (14d): only u1 has tier-3 activity (cnt=2) → 100%
    // on the top-3 (only 1 user exists).
    expect(cioBody.adoptionHero.concentrationPct).toBe(100);

    // AVG(dds)/AVG(oti) coercion + windowing: current (7d) row vs prior
    // (7-60d) row.
    expect(cioBody.adoptionHero.avgDds).toBeCloseTo(2.5, 6);
    expect(cioBody.adoptionHero.priorAvgDds).toBeCloseTo(2.0, 6);
    expect(cioBody.adoptionHero.avgOti).toBeCloseTo(1.8, 6);
    expect(cioBody.adoptionHero.priorAvgOti).toBeCloseTo(1.0, 6);

    // Org signal cards — psr = COUNT(*) confirmed capability_creation
    // org-wide (Cap One, Cap Two, Cap U2 = 3); ors + components from the
    // team-scope row.
    expect(cioBody.signalCards.psr).toBe(3);
    expect(typeof cioBody.signalCards.psr).toBe('number');
    expect(cioBody.signalCards.ors).toBeCloseTo(3.3, 6);
    expect(cioBody.signalCards.orsBreadth).toBeCloseTo(0.5, 6);
    expect(cioBody.signalCards.orsOverlap).toBeCloseTo(0.4, 6);
    expect(cioBody.signalCards.orsPropagation).toBeCloseTo(0.3, 6);

    // Month-bucket date expression: buckets to the
    // UTC-month key — the month the fixture rows actually sit in (anchored via
    // CLASS_BASE, which is NOT always NOW's month near a month boundary).
    // Dominant tier for u1 in that month is unambiguously 3 (2 tier-3 vs 1
    // tier-2), for u2 it's 1.
    const expectedMonth = new Date((CLASS_BASE - 4 * DAY) * 1000).toISOString().slice(0, 7);
    expect(cioBody.adoptionFunnel).toContainEqual({ month: expectedMonth, tier1: 1, tier2: 0, tier3: 1 });

    // Capability creation log — 3 confirmed rows org-wide, LEFT JOINed to
    // users + cowork_messages.
    expect(cioBody.capabilityLog).toHaveLength(3);
    expect(cioBody.capabilityLog.map((r: { title: string }) => r.title).sort()).toEqual(['Cap One', 'Cap Two', 'Cap U2']);

    // Numeric-money coercion proof: cost_usd (`numeric` on pg → STRING) SUM.
    expect(cioBody.coworkCostUsd).toBeCloseTo(4.25, 6);
    expect(typeof cioBody.coworkCostUsd).toBe('number');

    // Weekly volume trend — 8 rows, deterministic completed-week delta.
    expect(cioBody.weeklyVolume.series).toHaveLength(8);
    expect(cioBody.weeklyVolume.delta.current).toBe(7);
    expect(cioBody.weeklyVolume.delta.prior).toBe(6);
    expect(cioBody.weeklyVolume.tier3Delta.current).toBe(6);
    expect(cioBody.weeklyVolume.tier3Delta.prior).toBe(5);

    // ═══════════════════════ /api/pulse/org-summary ═══════════════════════
    const { GET: orgSummaryGET } = await import('../app/api/pulse/org-summary/route');
    const orgSummaryRes = await orgSummaryGET(makeRequest('/api/pulse/org-summary'));
    expect(orgSummaryRes.status).toBe(200);
    const orgSummaryBody = await orgSummaryRes.json();

    expect(orgSummaryBody.signalCards.dds).toBeCloseTo(2.5, 6);
    expect(orgSummaryBody.signalCards.oti).toBeCloseTo(1.8, 6);
    expect(orgSummaryBody.signalCards.psr).toBe(3);
    expect(orgSummaryBody.signalCards.ors).toBeCloseTo(3.3, 6);

    // Tier counts (30d) bucketed by cowork_messages.occurred_at.
    expect(orgSummaryBody.tierCounts).toEqual({ t1: 1, t2: 1, t3: 2 });

    // Work Mix (30d) — same classified rows grouped by task_type instead of flattened by tier.
    expect(orgSummaryBody.workMix).toContainEqual({ task_type: 'coding', messages: 2, tier3: 2, tier2: 0, tier1: 0 });
    expect(orgSummaryBody.workMix).toContainEqual({ task_type: 'drafting', messages: 1, tier3: 0, tier2: 1, tier1: 0 });
    expect(orgSummaryBody.workMix).toContainEqual({ task_type: 'chat', messages: 1, tier3: 0, tier2: 0, tier1: 1 });

    // GROUP BY + COUNT(DISTINCT) coercion — topSkills/topConnectors.
    expect(orgSummaryBody.topSkills).toContainEqual({ skill_name: 'brand-review', usage_count: 3, user_count: 1 });
    expect(orgSummaryBody.topConnectors).toContainEqual({ mcp_server: 'slack', usage_count: 2, user_count: 1 });

    // modelMix GROUP BY count coercion.
    const modelCnt = new Map(orgSummaryBody.modelMix.map((m: { model: string; cnt: number }) => [m.model, m.cnt]));
    expect(modelCnt.get('claude-sonnet-5')).toBe(1);
    expect(modelCnt.get('claude-haiku-4-5')).toBe(1);

    // jsonb Policy A extraction: 2 accept / 3 total = 66.7%.
    expect(orgSummaryBody.permissionDecisions).toEqual({ accepted: 2, total: 3, approval_rate: 66.7 });

    // Document-upload sessions aggregate (COUNT + SUM coercion).
    expect(orgSummaryBody.docSessions).toEqual({ sessions_with_uploads: 1, total_uploads: 2 });

    // Native tools aggregated from the same cowork_session_stats row.
    expect(orgSummaryBody.topNativeTools.map((t: { tool_name: string }) => t.tool_name).sort()).toEqual(['bash', 'read']);
  } finally {
    await cleanup();
  }
}

describe('pulse me/cio/org-summary dashboard routes (postgres)', () => {
  it(
    'return correctly-aggregated JSON with GROUP BY counts, numeric SUMs, month-bucket dates, and jsonb decision extraction coerced correctly on real postgres',
    async () => {
      await runSpec();
    },
    180_000,
  );
});
