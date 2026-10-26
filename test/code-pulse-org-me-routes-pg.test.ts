// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Postgres regression test for /api/pulse/code/org-summary
// and /api/pulse/code/me's OWN inline queries (async Drizzle), the two
// heaviest route
// handlers in the Developer Pulse route group (18 + 9 .prepare( sites).
//
// Harness mirrors test/pulse-routes-pg.test.ts (the 3.13a reference): one
// runSpec() run against Postgres via createTestDbClient('postgres') (full
// migrations-pg; the shared test server when CCC_TEST_PG_URL is set, else a
// testcontainer). getAdminSession is mocked; every other read in both routes
// hits the REAL DB via a dynamic import AFTER the DB env is established
// (the database client binds to DATABASE_URL on first use).
//
// Proves on REAL Postgres:
//   - code_metrics.spend_usd (numeric on pg, STRING on read) coerces to a
//     real number in both the org-summary and me routes' single-row reads.
//   - GROUP BY SUM/COUNT aggregates (modelMix, activeRepos, darkRepos,
//     topSkills, topConnectors, skillLeverage/agentLeverage, subagentShare,
//     languageMix, githubOverlay) — all bigint-returning on pg — coerce
//     correctly.
//   - The CAST(... AS REAL) friction-ratio expression (highFrictionSessions)
//     is valid SQL on Postgres.
//   - workMix's judged-layer JOIN + CASE-SUM aggregation coerces correctly.
//   - me route's correlated scalar subquery (`source`) and models_json-priced
//     per-session spend match spend/token values seen in org-summary.
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockSession: { authenticated: boolean; role?: string; email?: string; userId?: string; department?: string | null } = {
  authenticated: true,
  role: 'admin',
  email: 'admin@test.com',
  userId: 'admin-1',
};

vi.mock('@/lib/auth/admin-auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/admin-auth')>();
  return {
    ...actual,
    getAdminSession: async () => mockSession,
  };
});

function makeRequest(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`);
}

const NOW = Math.floor(Date.now() / 1000);
const DAY = 24 * 3600;
const ORG_SCOPE_ID = 'org';

async function runSpec(): Promise<void> {
  const { createTestDbClient } = await import('./helpers/db');
  const h = await createTestDbClient('postgres');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = h.client;
  const cleanup = h.cleanup;

  try {
    const { schema } = await import('@/lib/db/schema');

    // ── users ──
    await client.insert(schema.users).values({
      id: 'u1', email: 'u1@test.com', display_name: 'Ada Lovelace', department: 'Engineering',
    });

    // ── code_session_stats: s1 (active, high-friction, priced session with
    // models_json) + s3 (dark repo, silent for 40 days, no models_json) ──
    await client.insert(schema.codeSessionStats).values([
      {
        session_id: 's1', user_id: 'u1', repo: 'repo-a', git_branch: 'main',
        first_at: NOW - 2 * DAY, last_at: NOW - 1 * DAY,
        user_msg_count: 5, assistant_turns: 5, tool_use_count: 20, error_count: 8,
        input_tokens: 1_500_000, output_tokens: 500_000, cache_creation_tokens: 0, cache_read_tokens: 0,
        models_json: JSON.stringify({ 'claude-sonnet-4-6': { input: 1_500_000, output: 500_000, cache_creation: 0, cache_read: 0 } }),
        computed_at: NOW, commit_count: 3,
      },
      {
        session_id: 's3', user_id: 'u1', repo: 'repo-b', git_branch: 'main',
        first_at: NOW - 41 * DAY, last_at: NOW - 40 * DAY,
        user_msg_count: 1, assistant_turns: 1, tool_use_count: 5, error_count: 0,
        input_tokens: 100_000, output_tokens: 50_000, cache_creation_tokens: 0, cache_read_tokens: 0,
        models_json: null, computed_at: NOW - 40 * DAY, commit_count: 0,
      },
    ]);

    // ── code_assistant_meta: two priced rows on session s1 (one skill-
    // attributed, one agent-attributed) + one unpriced-model row ──
    await client.insert(schema.codeAssistantMeta).values([
      {
        id: 'a1', user_id: 'u1', session_id: 's1', model: 'claude-sonnet-4-6',
        input_tokens: 1_000_000, output_tokens: 500_000, occurred_at: NOW - 2 * DAY,
        skill_name: 'brand-review', source: 'agent', commit_count: 2,
      },
      {
        id: 'a2', user_id: 'u1', session_id: 's1', model: 'claude-sonnet-4-6',
        input_tokens: 500_000, output_tokens: 0, occurred_at: NOW - 3 * DAY,
        agent_name: 'reviewer-agent', source: 'agent',
      },
      {
        id: 'a3', user_id: 'u1', session_id: 's1', model: 'made-up-model-unpriced',
        input_tokens: 200_000, output_tokens: 100_000, occurred_at: NOW - 1 * DAY, source: 'agent',
      },
    ]);

    // ── code_session_classifications (judged layer — workMix + journeyGrid) ──
    await client.insert(schema.codeSessionClassifications).values({
      session_id: 's1', user_id: 'u1', work_type: 'feature', tier: 3, confidence: 0.9,
      classifier_model: 'haiku', status: 'classified', classified_at: NOW - 1 * DAY, provisional: 0,
    });

    // ── code_otel_metrics (Language Mix) ──
    await client.insert(schema.codeOtelMetrics).values([
      { id: 'lm1', metric_name: 'claude_code.code_edit_tool.decision', value: 12, language: 'typescript', occurred_at: NOW - 1 * DAY },
      { id: 'lm2', metric_name: 'claude_code.code_edit_tool.decision', value: 5, language: 'python', occurred_at: NOW - 2 * DAY },
    ]);

    // ── GitHub overlay: one tracked+covered repo, one row inside the 7-day
    // window and one outside it but inside the 30-day window ──
    await client.insert(schema.githubRepoMap).values({ repo: 'repo-a', github_repo: 'org/repo-a' });
    const today = new Date(NOW * 1000).toISOString().slice(0, 10);
    const tenDaysAgo = new Date((NOW - 10 * DAY) * 1000).toISOString().slice(0, 10);
    await client.insert(schema.githubRepoStats).values([
      { repo: 'repo-a', date: today, commit_count: 3, prs_merged: 1, synced_at: NOW },
      { repo: 'repo-a', date: tenDaysAgo, commit_count: 2, prs_merged: 0, synced_at: NOW },
    ]);

    // ── skill/connector invocations (topSkills/topConnectors; 'workspace' is
    // excluded by the NOT IN filter) ──
    await client.insert(schema.coworkSkillInvocations).values({
      id: 'si1', user_id: 'u1', session_id: 's1', skill_name: 'brand-review',
      occurred_at: NOW - 1 * DAY, invocation_type: 'agent_chained',
    });
    await client.insert(schema.coworkMcpInvocations).values([
      { id: 'mi1', user_id: 'u1', session_id: 's1', mcp_server: 'slack', mcp_tool: 'send', occurred_at: NOW - 1 * DAY },
      { id: 'mi2', user_id: 'u1', session_id: 's1', mcp_server: 'workspace', mcp_tool: 'x', occurred_at: NOW - 1 * DAY },
    ]);

    // ── code_metrics: org + user scope, current (rolling) + prior rows.
    // spend_usd is written as a STRING — numeric on pg requires it (mirrors
    // lib/pulse/code/aggregator.ts's writeCodeMetric). ──
    await client.insert(schema.codeMetrics).values([
      {
        scope_type: 'organisation', scope_id: ORG_SCOPE_ID, period_start: NOW - 7 * DAY, period_end: NOW,
        spend_usd: '12.0', session_count: 2, repo_count: 2, commit_count: 3, skill_leverage: 0.5,
        friction_index: 0.4, active_time_user_s: 3600, active_time_cli_s: 1800, lines_added: 100,
        lines_removed: 20, pr_count: 1, edit_accept_count: 10, edit_reject_count: 2,
        granularity: 'rolling', computed_at: NOW,
      },
      {
        scope_type: 'organisation', scope_id: ORG_SCOPE_ID, period_start: NOW - 17 * DAY, period_end: NOW - 10 * DAY,
        spend_usd: '8.0', autonomy_ratio: 0.4, cache_hit_ratio: 0.3, session_count: 1, repo_count: 1,
        granularity: 'rolling', computed_at: NOW - 10 * DAY,
      },
      // Oldest-first so the newest row gets the highest id: /api/pulse/code/{users,depts}
      // pick the latest per-scope row by MAX(id) (the aggregator writes append-only,
      // so higher id == newer), unlike org-summary/me which use MAX(computed_at).
      {
        scope_type: 'user', scope_id: 'u1', period_start: NOW - 17 * DAY, period_end: NOW - 10 * DAY,
        spend_usd: '5.0', session_count: 1, repo_count: 1,
        granularity: 'rolling', computed_at: NOW - 10 * DAY,
      },
      {
        scope_type: 'user', scope_id: 'u1', period_start: NOW - 7 * DAY, period_end: NOW,
        spend_usd: '12.0', session_count: 2, repo_count: 2, commit_count: 3,
        active_time_user_s: 3600, active_time_cli_s: 1800, lines_added: 100,
        granularity: 'rolling', computed_at: NOW,
      },
      // Function (department) scope — drives /api/pulse/code/depts (A2).
      {
        scope_type: 'function', scope_id: 'Engineering', period_start: NOW - 7 * DAY, period_end: NOW,
        spend_usd: '12.0', session_count: 2, repo_count: 2, commit_count: 3,
        input_tokens: 2_000_000, output_tokens: 500_000,
        granularity: 'rolling', computed_at: NOW,
      },
    ]);

    // ═══════════════════════════ /api/pulse/code/org-summary ═══════════════════════════
    const { GET: orgGET } = await import('../app/api/pulse/code/org-summary/route');
    const orgRes = await orgGET(makeRequest('/api/pulse/code/org-summary'));
    expect(orgRes.status).toBe(200);
    const org = await orgRes.json();

    // Single-row numeric() spend coercion (org current + prior).
    expect(org.metrics.spend_usd).toBeCloseTo(12.0, 6);
    expect(org.metrics.session_count).toBe(2);
    expect(org.metrics.commit_count).toBe(3);
    expect(org.metrics.active_time_user_s).toBe(3600);
    expect(org.metrics.lines_added).toBe(100);
    expect(org.metrics.pr_count).toBe(1);
    expect(org.priorMetrics.spend_usd).toBeCloseTo(8.0, 6);
    expect(org.priorMetrics.session_count).toBe(1);

    // modelMix — GROUP BY SUM/COUNT, ordered by total tokens desc.
    expect(org.modelMix).toHaveLength(2);
    expect(org.modelMix[0]).toEqual({
      model: 'claude-sonnet-4-6', input_tokens: 1_500_000, output_tokens: 500_000,
      cache_creation_tokens: 0, cache_read_tokens: 0, turns: 2,
    });
    expect(org.modelMix[1].model).toBe('made-up-model-unpriced');
    expect(org.modelMix[1].input_tokens).toBe(200_000);
    expect(org.unpricedModels).toEqual(['made-up-model-unpriced']);
    expect(org.spendIsPartlyEstimated).toBe(false);

    // activeRepos (30d) vs darkRepos (silent, seen before) — GROUP BY + HAVING.
    expect(org.activeRepos).toEqual([{ repo: 'repo-a', sessions: 1, tokens: 2_000_000, commits: 3 }]);
    expect(org.darkRepos).toEqual([{ repo: 'repo-b', last_seen: NOW - 40 * DAY }]);

    // topSkills/topConnectors — GROUP BY JOIN, NOT IN filter excludes 'workspace'.
    expect(org.topSkills).toEqual([{ skill_name: 'brand-review', uses: 1, agent_chained: 1 }]);
    expect(org.topConnectors).toEqual([{ mcp_server: 'slack', uses: 1 }]);

    // Leverage — dynamic-column GROUP BY + per-row pricing.
    expect(org.skillLeverage).toEqual([{ name: 'brand-review', turns: 1, tokens: 1_500_000, spend_usd: 10.5 }]);
    expect(org.agentLeverage).toEqual([{ name: 'reviewer-agent', turns: 1, tokens: 500_000, spend_usd: 1.5 }]);

    // Autonomy: 1 of 3 turns has a subagent (a2).
    expect(org.subagentShare).toBeCloseTo(1 / 3, 6);

    // Spend concentration hidden below MIN_SPENDERS_FOR_CONCENTRATION (only 1 spender).
    expect(org.spendConcentration).toBeNull();

    // Spend projection — priced spend exists in the last 7 days (a1+a2, both within 3 days).
    expect(org.spendProjection).not.toBeNull();
    expect(org.spendProjection.projected).toBeGreaterThan(0);

    // Language Mix — SUM(doublePrecision), ordered desc.
    expect(org.languageMix).toEqual([
      { language: 'typescript', edits: 12 },
      { language: 'python', edits: 5 },
    ]);

    // GitHub overlay — 7d window picks only today's row; 30d sums both.
    const ov = org.githubOverlay;
    expect(ov.trackedRepoCount).toBe(1);
    expect(ov.totalCommits7d).toBe(3);
    expect(ov.totalPrs7d).toBe(1);
    expect(ov.totalCommits30dByRepo).toEqual({ 'repo-a': 5 });
    // Shipping alignment additions: both seeded github_repo_stats
    // rows (today, 3 commits; 10 days ago, 2 commits) fall inside the
    // 30-entry window (today back 29 days inclusive), so the series/card
    // totals match totalCommits30dByRepo above.
    expect(ov.shippingSeries).toHaveLength(30);
    const seriesGhTotal = ov.shippingSeries.reduce((s: number, d: { ghCommits: number }) => s + d.ghCommits, 0);
    expect(seriesGhTotal).toBe(5);
    // AI-assisted commits day-bucketing: only a1 (occurred_at NOW - 2*DAY) has
    // commit_count set (2); this proves the day expression (to_char(...))
    // actually buckets and sums rows instead of silently producing an
    // all-zero series that would pass by accident.
    const seriesAiTotal = ov.shippingSeries.reduce((s: number, d: { aiCommits: number }) => s + d.aiCommits, 0);
    expect(seriesAiTotal).toBe(2);
    const twoDaysAgoDate = new Date((NOW - 2 * DAY) * 1000).toISOString().slice(0, 10);
    const twoDaysAgoRow = ov.shippingSeries.find((d: { date: string }) => d.date === twoDaysAgoDate);
    expect(twoDaysAgoRow?.aiCommits).toBe(2);
    // Only today's row (3 commits) falls in the window's last 7 days — the
    // 10-days-ago row is outside it — so exactly 1 repo is active in 7d.
    expect(ov.reposActive7d).toBe(1);
    expect(ov.repoCards).toHaveLength(1);
    expect(ov.repoCards[0].repo).toBe('repo-a');
    expect(ov.repoCards[0].commits30d).toBe(5);
    expect(ov.repoCards[0].daily).toHaveLength(30);

    // High-friction sessions — CAST(... AS REAL) ratio, valid on Postgres.
    expect(org.highFrictionSessions).toHaveLength(1);
    expect(org.highFrictionSessions[0]).toMatchObject({ session_id: 's1', error_count: 8, tool_use_count: 20 });

    // Judged-layer work mix — JOIN + CASE-SUM tier breakdown.
    expect(org.workMix).toEqual([{ work_type: 'feature', label: 'New functionality', definition: 'new functionality', sessions: 1, tier3: 1, tier2: 0, tier1: 0, provisional: 0 }]);

    // Trends — sanity shape (values come from 'week' rows, none seeded here).
    expect(org.trends.spend.series).toHaveLength(8);

    // ═══════════════════════════ /api/pulse/code/me ═══════════════════════════
    const { GET: meGET } = await import('../app/api/pulse/code/me/route');
    const meRes = await meGET(makeRequest('/api/pulse/code/me?userId=u1'));
    expect(meRes.status).toBe(200);
    const me = await meRes.json();

    expect(me.userId).toBe('u1');
    expect(me.displayName).toBe('Ada Lovelace');
    expect(me.metrics.spend_usd).toBeCloseTo(12.0, 6);
    expect(me.priorMetrics.spend_usd).toBeCloseTo(5.0, 6);

    // Sessions — ordered by last_at desc, models_json-priced spend per session,
    // correlated-subquery `source`.
    expect(me.sessions).toHaveLength(2);
    expect(me.sessions[0].session_id).toBe('s1');
    expect(me.sessions[0].spend_usd).toBeCloseTo(12.0, 6);
    expect(me.sessions[0].source).toBe('agent');
    expect(me.sessions[1].session_id).toBe('s3');
    expect(me.sessions[1].spend_usd).toBeNull();

    // modelMix (user-scoped) — same GROUP BY shape as org-summary, one contributing user,
    // now including cache_creation_tokens/cache_read_tokens like org-summary already did.
    expect(me.modelMix).toHaveLength(2);
    const sonnetMix = me.modelMix.find((m: { model: string }) => m.model === 'claude-sonnet-4-6');
    expect(sonnetMix.input_tokens).toBe(1_500_000);
    expect(sonnetMix.output_tokens).toBe(500_000);
    expect(sonnetMix.cache_creation_tokens).toBe(0);
    expect(sonnetMix.cache_read_tokens).toBe(0);
    expect(sonnetMix.turns).toBe(2);

    // Journey grid — tier-3 classification in week 0.
    expect(me.journeyGrid).toEqual([{ week: 0, tier: 3, count: 1, provisionalCount: 0 }]);

    expect(me.trends.engagedTime.series).toHaveLength(8);

    // ═══════════════════════ /api/pulse/code/users (A2 — PR#6 regression guard) ═══════════════════════
    // PR #6 fixed a PG-only 500 in these two routes: the pre-#6 dept filter was
    // `(${dept} IS NULL OR col = ${dept})`, and on Postgres a bound param in a
    // bare `$1 IS NULL` has no inferable type → "could not determine data type
    // of parameter $1" → 500. The no-dept branch (admin, no ?dept → dept null)
    // is exactly that failing case, which only Postgres catches. These assertions were
    // proven red against the reverted pre-#6 pattern before landing.
    const { GET: usersGET } = await import('../app/api/pulse/code/users/route');

    const usersRes = await usersGET(makeRequest('/api/pulse/code/users'));
    expect(usersRes.status).toBe(200);
    const usersBody = await usersRes.json();
    expect(usersBody.users).toHaveLength(1);
    expect(usersBody.users[0].user_id).toBe('u1');
    expect(usersBody.users[0].department).toBe('Engineering');
    expect(usersBody.users[0].spend_usd).toBeCloseTo(12.0, 6);
    expect(typeof usersBody.users[0].spend_usd).toBe('number');

    // Dept-filter branch (admin ?dept=): a match and a miss.
    const usersDeptRes = await usersGET(makeRequest('/api/pulse/code/users?dept=Engineering'));
    expect(usersDeptRes.status).toBe(200);
    expect((await usersDeptRes.json()).users).toHaveLength(1);
    const usersMissRes = await usersGET(makeRequest('/api/pulse/code/users?dept=Nonexistent'));
    expect(usersMissRes.status).toBe(200);
    expect((await usersMissRes.json()).users).toHaveLength(0);

    // ═══════════════════════ /api/pulse/code/depts (A2 — PR#6 regression guard) ═══════════════════════
    // For an admin, deptFilter is ALWAYS null → the no-filter branch = the
    // pre-#6 PG-500 case, hit by the plain admin call below.
    const { GET: deptsGET } = await import('../app/api/pulse/code/depts/route');
    const deptsRes = await deptsGET(makeRequest('/api/pulse/code/depts'));
    expect(deptsRes.status).toBe(200);
    const deptsBody = await deptsRes.json();
    expect(deptsBody.depts).toHaveLength(1);
    expect(deptsBody.depts[0].department).toBe('Engineering');
    expect(deptsBody.depts[0].member_count).toBe(1);
    expect(deptsBody.depts[0].spend_usd).toBeCloseTo(12.0, 6);
    expect(typeof deptsBody.depts[0].spend_usd).toBe('number');

    // Dept-filter branch: a dept-scoped 'code' session pins deptFilter to its
    // own department, exercising the `AND cm.scope_id = ${deptFilter}` fragment
    // on both routes. Restore the admin session afterward.
    mockSession.role = 'code';
    mockSession.department = 'Engineering';
    try {
      const deptsScopedRes = await deptsGET(makeRequest('/api/pulse/code/depts'));
      expect(deptsScopedRes.status).toBe(200);
      expect((await deptsScopedRes.json()).depts).toHaveLength(1);

      const usersScopedRes = await usersGET(makeRequest('/api/pulse/code/users'));
      expect(usersScopedRes.status).toBe(200);
      expect((await usersScopedRes.json()).users).toHaveLength(1);
    } finally {
      mockSession.role = 'admin';
      mockSession.department = undefined;
    }
  } finally {
    await cleanup();
  }
}

describe('Developer Pulse org-summary/me routes (postgres)', () => {
  it(
    'return correctly-aggregated JSON with numeric()/bigint coercion and CAST(...AS REAL) friction ratio on real postgres',
    async () => {
      await runSpec();
    },
    180_000,
  );
});
