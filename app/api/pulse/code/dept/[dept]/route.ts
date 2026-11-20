// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. Follows the
// standard pattern: getTypedClient() + schema.<table>.
// `code_metrics.spend_usd` is numeric on pg, so it is coerced.
import { NextRequest, NextResponse } from 'next/server';
import { visibleVendor, visibleOpenAi } from '@/lib/sources/openai-visibility';
import { and, desc, eq, gte, inArray, ne } from 'drizzle-orm';
import { AUTOMATED_WORK_TYPE } from '@/lib/pulse/code/automated-runs';
import { getAdminSession, isDeptScoped, canAccessCodePulse, canAccessPulseAdmin } from '@/lib/auth/admin-auth';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getCodeDeptMembers } from '@/lib/pulse/code/dept';
import { hasCodexData, readCodeMetrics, pickCodeMetricsSource, codeSessionVendor } from '@/lib/pulse/code/vendor-view';
import { readHumanTime } from '@/lib/pulse/human-time-summary';
import { githubRepoBasis, githubBasisColumn, type GithubRepoBasis } from '@/lib/pulse/code/github-tool-match';
import { weeklyTiers, getCodeTierNames } from '@/lib/pulse/code/weekly-tiers';
import { getCodeWorkTypeDefinitions } from '@/lib/pulse/code/tier-config';
import { codeWorkTypeLabel } from '@/lib/pulse/code/work-type-labels';
import { buildCodePeriodWork } from '@/lib/pulse/code/period-work';
import type { PulsePeriod } from '@/lib/pulse/period-shape';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ dept: string }> }
) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!canAccessCodePulse(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { dept: rawDept } = await params;
  const dept = decodeURIComponent(rawDept);

  // Dept-scoped roles can only view their own department. One with no
  // department is refused too (422, as /api/pulse/dept/[dept] does):
  // otherwise an empty session.department would skip the check and return any
  // department's members, emails and spend.
  if (isDeptScoped(session.role)) {
    if (!session.department) {
      return NextResponse.json(
        { error: 'no_department', message: 'Your account has no department assigned. Ask your admin to set one.' },
        { status: 422 }
      );
    }
    if (session.department !== dept) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  const client = await getTypedClient();
  const csc = schema.codeSessionClassifications;
  const css = schema.codeSessionStats;
  const u = schema.users;
  const now = Math.floor(Date.now() / 1000);
  const sixWeeksAgo = now - 42 * 24 * 3600;

  // Developer Pulse's All / Claude / Codex switch.
  const vendor = await visibleVendor(request.nextUrl.searchParams.get('vendor'));
  const codexPresent = await visibleOpenAi(hasCodexData());

  // Latest department-scope rollup — the aggregator writes dept rollups as
  // scope_type='function' (not 'dept'), matching the Cowork dept route.
  const latestDeptRow = (cm: typeof schema.codeMetrics, only: ReturnType<typeof eq> | undefined) => client
    .select({
      spend_usd: cm.spend_usd, input_tokens: cm.input_tokens, output_tokens: cm.output_tokens,
      cache_hit_ratio: cm.cache_hit_ratio, autonomy_ratio: cm.autonomy_ratio,
      session_count: cm.session_count, repo_count: cm.repo_count, commit_count: cm.commit_count,
      skill_leverage: cm.skill_leverage, friction_index: cm.friction_index,
    })
    .from(cm)
    .where(and(eq(cm.scope_type, 'function'), eq(cm.scope_id, dept), eq(cm.granularity, 'rolling'), only))
    .orderBy(desc(cm.computed_at))
    .limit(1);
  const toMetrics = <R extends { spend_usd: string | null }>(r: R | undefined) =>
    r ? { ...r, spend_usd: r.spend_usd !== null ? Number(r.spend_usd) : null } : null;
  const metrics = toMetrics((await readCodeMetrics(vendor, codexPresent, latestDeptRow))[0]);
  // All view, once Codex data exists: the department's Claude Code and Codex figures.
  const metricsSplit = vendor === 'all' && codexPresent
    ? {
        claude: toMetrics((await readCodeMetrics('claude', true, latestDeptRow))[0]),
        openai: toMetrics((await readCodeMetrics('openai', true, latestDeptRow))[0]),
      }
    : null;

  // Members — the full department roster (membership-first), so members without
  // recent Code activity still appear with null/zero metrics. See lib/pulse/code/dept.ts.
  const members = await getCodeDeptMembers(dept, await pickCodeMetricsSource(vendor, codexPresent));

  // Per-user + dept-wide GitHub repo activity (mapped-scoped).
  // Mirrors /api/pulse/code/me's null-semantics: a 35d window
  // pre-check decides null vs count30d:0 — null = NO member rows at all in
  // the 35d window ("Not captured" rendering); count30d:0 = window rows
  // exist but none in the last 30 days (every member's github_repo_count is
  // then explicitly set to 0, not left undefined). Claude and Codex tabs
  // count only repos with commits matched to that tool; All (and a hub without
  // Codex, which has no tabs) counts every repo.
  const githubBasis = githubRepoBasis(vendor, codexPresent);
  let githubRepos: { count30d: number; names30d: string[]; basis: GithubRepoBasis } | null = null;
  const grm = schema.githubRepoMap;
  const gurs = schema.githubUserRepoStats;
  const mappedRepoRows = await client.select({ repo: grm.repo }).from(grm);
  const mappedRepos = mappedRepoRows.map(r => r.repo);
  const memberIds = members.map(m => m.user_id);
  if (mappedRepos.length > 0 && memberIds.length > 0) {
    const since35 = new Date((now - 35 * 24 * 3600) * 1000).toISOString().slice(0, 10);
    const since30 = new Date((now - 30 * 24 * 3600) * 1000).toISOString().slice(0, 10);
    const rows = await client
      .select({ user_id: gurs.user_id, repo: gurs.repo, date: gurs.date, c: githubBasisColumn(gurs, githubBasis) })
      .from(gurs)
      .where(and(gte(gurs.date, since35), inArray(gurs.repo, mappedRepos), inArray(gurs.user_id, memberIds)));
    // A tool's count is not measured on days synced before commits were
    // matched to tools (null): with no matched day in the last 30, members'
    // counts and the department card stay not measured rather than 0.
    const measured30 = rows.some(r => r.date >= since30 && r.c != null);
    if (rows.length > 0 && (githubBasis === 'all' || measured30)) {
      const byUser = new Map<string, Set<string>>();
      const allRepos = new Set<string>();
      for (const r of rows) {
        if (r.date < since30 || Number(r.c ?? 0) <= 0) continue;
        if (!byUser.has(r.user_id)) byUser.set(r.user_id, new Set());
        byUser.get(r.user_id)!.add(r.repo);
        allRepos.add(r.repo);
      }
      for (const m of members) m.github_repo_count = byUser.get(m.user_id)?.size ?? 0;
      githubRepos = { count30d: allRepos.size, names30d: [...allRepos].sort().slice(0, 3), basis: githubBasis };
    }
  }

  // Delegation journey for the department — same convention as the per-user grid
  // (Wk 1 = most recent week, Wk 6 = oldest), aggregated over department members.
  const tierRows = await client
    .select({ tier: csc.tier, provisional: csc.provisional, last_at: css.last_at })
    .from(csc)
    .innerJoin(css, eq(css.session_id, csc.session_id))
    .innerJoin(u, eq(u.id, csc.user_id))
    .where(and(eq(u.department, dept), eq(csc.status, 'classified'), ne(csc.work_type, AUTOMATED_WORK_TYPE), gte(css.last_at, sixWeeksAgo), codeSessionVendor(css.session_id, vendor)));

  const counts = new Map<string, number>();
  const provisionalCounts = new Map<string, number>();
  for (const r of tierRows) {
    const week = Math.min(5, Math.floor((now - r.last_at) / (7 * 24 * 3600)));
    const key = `${week}-${r.tier}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (r.provisional) provisionalCounts.set(key, (provisionalCounts.get(key) ?? 0) + 1);
  }
  const journeyGrid = [...counts.entries()].map(([k, count]) => {
    const [week, tier] = k.split('-').map(Number);
    return { week, tier, count, provisionalCount: provisionalCounts.get(k) ?? 0 };
  });

  // The same weekly view as a person's page: a year of completed weeks, and the six-week grid.
  const yearAgo = now - 53 * 7 * 24 * 3600;
  const yearTierRows = await client
    .select({ tier: csc.tier, work_type: csc.work_type, last_at: css.last_at })
    .from(csc)
    .innerJoin(css, eq(css.session_id, csc.session_id))
    .innerJoin(u, eq(u.id, csc.user_id))
    .where(and(eq(u.department, dept), eq(csc.status, 'classified'), ne(csc.work_type, AUTOMATED_WORK_TYPE), gte(css.last_at, yearAgo), codeSessionVendor(css.session_id, vendor)));
  const { weeks: tierWeeks, grid: tierGrid } = weeklyTiers(yearTierRows, now);
  const tierNames = await getCodeTierNames();

  // The page's one period: this week, this month or this quarter.
  const askedPeriod = request.nextUrl.searchParams.get('period');
  const periodName: PulsePeriod = askedPeriod === 'week' || askedPeriod === 'month' || askedPeriod === 'quarter' ? askedPeriod : 'quarter';
  let periodWork = null;
  try {
    periodWork = await buildCodePeriodWork({ scopeType: 'function', scopeId: dept, period: periodName, vendor, nowS: now });
  } catch (err) {
    console.error('[pulse/code] period work failed', err);
  }

  // What kinds of coding work the department delegates, over the last 30 days.
  const thirtyDaysAgoWork = now - 30 * 24 * 3600;
  const workDefs = await getCodeWorkTypeDefinitions();
  const workCounts = new Map<string, { sessions: number; deep: number }>();
  for (const r of yearTierRows) {
    if (r.last_at < thirtyDaysAgoWork) continue;
    const e = workCounts.get(r.work_type) ?? { sessions: 0, deep: 0 };
    e.sessions++;
    if (r.tier >= 2) e.deep++;
    workCounts.set(r.work_type, e);
  }
  const workMix = [...workCounts.entries()]
    .map(([work_type, v]) => ({ work_type, label: codeWorkTypeLabel(work_type, workDefs.get(work_type)), sessions: v.sessions, deep: v.deep }))
    .sort((a, b) => b.sessions - a.sessions);

  const humanTime = await readHumanTime('code', memberIds, vendor);
  // Each member's spend: admins and managers see everyone's; anyone else sees only their own row's,
  // and a colleague's reads as hidden. The department's own total above is not about one person.
  let membersOut: Array<(typeof members)[number] & { spend_hidden?: boolean }> = members;
  if (!canAccessPulseAdmin(session.role)) {
    const au = schema.adminUsers;
    const linked = session.userId
      ? await client.select({ id: au.linked_cowork_user_id }).from(au).where(eq(au.id, session.userId)).limit(1)
      : [];
    const byEmail = session.email
      ? await client.select({ id: u.id }).from(u).where(eq(u.email, session.email)).limit(1)
      : [];
    const me = linked[0]?.id ?? byEmail[0]?.id ?? null;
    membersOut = members.map(m => (m.user_id === me ? m : { ...m, spend_usd: null, spend_hidden: true }));
  }

  return NextResponse.json({ dept, vendor, codexPresent, metricsSplit, metrics, members: membersOut, journeyGrid, tierWeeks, tierGrid, tierNames, periodWork, workMix, githubRepos, humanTime });
}
