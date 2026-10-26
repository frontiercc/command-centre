// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. Follows the
// standard pattern: getTypedClient() + schema.<table>.
// `code_metrics.spend_usd` is numeric on pg, so it is coerced.
import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { getAdminSession, isDeptScoped, canAccessCodePulse } from '@/lib/auth/admin-auth';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getCodeDeptMembers } from '@/lib/pulse/code/dept';
import { readHumanTime } from '@/lib/pulse/human-time-summary';

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
  const cm = schema.codeMetrics;
  const csc = schema.codeSessionClassifications;
  const css = schema.codeSessionStats;
  const u = schema.users;
  const now = Math.floor(Date.now() / 1000);
  const sixWeeksAgo = now - 42 * 24 * 3600;

  // Latest department-scope rollup — the aggregator writes dept rollups as
  // scope_type='function' (not 'dept'), matching the Cowork dept route.
  const metricsRows = await client
    .select({
      spend_usd: cm.spend_usd, input_tokens: cm.input_tokens, output_tokens: cm.output_tokens,
      cache_hit_ratio: cm.cache_hit_ratio, autonomy_ratio: cm.autonomy_ratio,
      session_count: cm.session_count, repo_count: cm.repo_count, commit_count: cm.commit_count,
      skill_leverage: cm.skill_leverage, friction_index: cm.friction_index,
    })
    .from(cm)
    .where(and(eq(cm.scope_type, 'function'), eq(cm.scope_id, dept), eq(cm.granularity, 'rolling')))
    .orderBy(desc(cm.computed_at))
    .limit(1);
  const metricsRaw = metricsRows[0] ?? null;
  const metrics = metricsRaw
    ? { ...metricsRaw, spend_usd: metricsRaw.spend_usd !== null ? Number(metricsRaw.spend_usd) : null }
    : null;

  // Members — the full department roster (membership-first), so members without
  // recent Code activity still appear with null/zero metrics. See lib/pulse/code/dept.ts.
  const members = await getCodeDeptMembers(dept);

  // Per-user + dept-wide GitHub repo activity (mapped-scoped).
  // Mirrors /api/pulse/code/me's null-semantics: a 35d window
  // pre-check decides null vs count7d:0 — null = NO member rows at all in
  // the 35d window ("Not captured" rendering); count7d:0 = window rows
  // exist but none in the last 7 days (every member's github_repo_count is
  // then explicitly set to 0, not left undefined).
  let githubRepos: { count7d: number; names7d: string[] } | null = null;
  const grm = schema.githubRepoMap;
  const gurs = schema.githubUserRepoStats;
  const mappedRepoRows = await client.select({ repo: grm.repo }).from(grm);
  const mappedRepos = mappedRepoRows.map(r => r.repo);
  const memberIds = members.map(m => m.user_id);
  if (mappedRepos.length > 0 && memberIds.length > 0) {
    const since35 = new Date((now - 35 * 24 * 3600) * 1000).toISOString().slice(0, 10);
    const since7 = new Date((now - 7 * 24 * 3600) * 1000).toISOString().slice(0, 10);
    const rows = await client
      .select({ user_id: gurs.user_id, repo: gurs.repo, date: gurs.date, c: gurs.commit_count })
      .from(gurs)
      .where(and(gte(gurs.date, since35), inArray(gurs.repo, mappedRepos), inArray(gurs.user_id, memberIds)));
    if (rows.length > 0) {
      const byUser = new Map<string, Set<string>>();
      const allRepos = new Set<string>();
      for (const r of rows) {
        if (r.date < since7 || Number(r.c) <= 0) continue;
        if (!byUser.has(r.user_id)) byUser.set(r.user_id, new Set());
        byUser.get(r.user_id)!.add(r.repo);
        allRepos.add(r.repo);
      }
      for (const m of members) m.github_repo_count = byUser.get(m.user_id)?.size ?? 0;
      githubRepos = { count7d: allRepos.size, names7d: [...allRepos].sort().slice(0, 3) };
    }
  }

  // Delegation journey for the department — same convention as the per-user grid
  // (Wk 1 = most recent week, Wk 6 = oldest), aggregated over department members.
  const tierRows = await client
    .select({ tier: csc.tier, provisional: csc.provisional, last_at: css.last_at })
    .from(csc)
    .innerJoin(css, eq(css.session_id, csc.session_id))
    .innerJoin(u, eq(u.id, csc.user_id))
    .where(and(eq(u.department, dept), eq(csc.status, 'classified'), gte(css.last_at, sixWeeksAgo)));

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

  const humanTime = await readHumanTime('code', memberIds);
  return NextResponse.json({ dept, metrics, members, journeyGrid, githubRepos, humanTime });
}
