// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. Follows the
// standard pattern (lib/pulse/code/dept.ts): getTypedClient()
// + a local rawAll() facade for the "latest row per scope" MAX(id) derived-
// table join — clearer as raw SQL than the query builder here, matching
// dept.ts's exact convention (`NULLS LAST` is native SQL on Postgres).
// `cm.spend_usd` (numeric) and the correlated COUNT(*) member_count (bigint on
// pg) are Number()-coerced (Postgres returns bigint and numeric as strings). `cm.computed_at` is bigint; a raw
// query (unlike the query-builder's own bigint({mode:'number'}) codec) returns
// it as a STRING from node-postgres, so it is coerced too (mirrors lib/pulse/
// trends.ts's rawAll reads).
import { NextRequest, NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { getAdminSession, canAccessCodePulse, isDeptScoped } from '@/lib/auth/admin-auth';
import { getTypedClient } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

interface RawFacade {
  execute?: (q: unknown) => Promise<{ rows: unknown[]; rowCount: number | null }>;
}
async function rawAll<T>(client: unknown, query: unknown): Promise<T[]> {
  const c = client as RawFacade;
  const res = await c.execute!(query);
  return res.rows as T[];
}

interface RawDeptRow {
  department: string;
  spend_usd: string | number | null;
  autonomy_ratio: number | null;
  cache_hit_ratio: number | null;
  session_count: number;
  repo_count: number;
  commit_count: number;
  skill_leverage: number | null;
  input_tokens: number;
  output_tokens: number;
  computed_at: string | number;
  member_count: string | number;
}

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!canAccessCodePulse(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  if (isDeptScoped(session.role) && !session.department) {
    return NextResponse.json(
      { error: 'no_department', message: 'Your account has no department assigned. Ask your admin to set one.' },
      { status: 422 }
    );
  }

  // Contributor roles (code, pulse) see only their own department
  const deptFilter = isDeptScoped(session.role) ? (session.department ?? null) : null;

  const client = await getTypedClient();

  // Latest function-scope code_metrics row per department + member counts
  const rawRows = await rawAll<RawDeptRow>(client, sql`
     SELECT cm.scope_id AS department,
            cm.spend_usd, cm.autonomy_ratio, cm.cache_hit_ratio,
            cm.session_count, cm.repo_count, cm.commit_count, cm.skill_leverage,
            cm.input_tokens, cm.output_tokens, cm.computed_at,
            (SELECT COUNT(*) FROM users u WHERE u.department = cm.scope_id) AS member_count
     FROM code_metrics cm
     JOIN (
       SELECT scope_id, MAX(id) AS max_id
       FROM code_metrics WHERE scope_type = 'function' AND granularity = 'rolling'
       GROUP BY scope_id
     ) latest ON latest.max_id = cm.id
     WHERE cm.scope_type = 'function' AND cm.granularity = 'rolling'
       ${deptFilter ? sql`AND cm.scope_id = ${deptFilter}` : sql``}
     ORDER BY cm.spend_usd DESC NULLS LAST
  `);

  const depts = rawRows.map(r => ({
    department: r.department,
    spend_usd: r.spend_usd !== null && r.spend_usd !== undefined ? Number(r.spend_usd) : null,
    autonomy_ratio: r.autonomy_ratio,
    cache_hit_ratio: r.cache_hit_ratio,
    session_count: Number(r.session_count),
    repo_count: Number(r.repo_count),
    commit_count: Number(r.commit_count),
    skill_leverage: r.skill_leverage,
    input_tokens: Number(r.input_tokens),
    output_tokens: Number(r.output_tokens),
    computed_at: Number(r.computed_at),
    member_count: Number(r.member_count),
  }));

  return NextResponse.json({ depts });
}
