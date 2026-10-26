// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. Follows the
// standard pattern (lib/pulse/code/dept.ts): getTypedClient()
// + a local rawAll() facade for the "latest row per scope" MAX(id) derived-
// table join (clearer as raw SQL than the query builder here; `NULLS LAST` is
// native SQL on Postgres). `cm.spend_usd` (numeric) and the bigint
// `cm.computed_at` are Number()-coerced (Postgres returns bigint and numeric as strings): a raw query returns
// bigint as a STRING from node-postgres even though the query-builder's own
// bigint({mode:'number'}) codec would normally handle it (mirrors lib/pulse/
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

interface RawUserRow {
  user_id: string;
  display_name: string | null;
  email: string | null;
  department: string | null;
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

  const client = await getTypedClient();
  // Contributor roles (code, pulse) are always scoped to their own department
  const dept = isDeptScoped(session.role)
    ? (session.department ?? null)
    : request.nextUrl.searchParams.get('dept');

  // Latest user-scope code_metrics row per user, joined to identity.
  // Users with no Code activity are excluded — this is a Developer Pulse view.
  const rawRows = await rawAll<RawUserRow>(client, sql`
     SELECT cm.scope_id AS user_id,
            u.display_name, u.email, u.department,
            cm.spend_usd, cm.autonomy_ratio, cm.cache_hit_ratio,
            cm.session_count, cm.repo_count, cm.commit_count, cm.skill_leverage,
            cm.input_tokens, cm.output_tokens, cm.computed_at
     FROM code_metrics cm
     JOIN (
       SELECT scope_id, MAX(id) AS max_id
       FROM code_metrics WHERE scope_type = 'user' AND granularity = 'rolling'
       GROUP BY scope_id
     ) latest ON latest.max_id = cm.id
     LEFT JOIN users u ON u.id = cm.scope_id
     WHERE cm.scope_type = 'user' AND cm.granularity = 'rolling'
       ${dept ? sql`AND u.department = ${dept}` : sql``}
     ORDER BY cm.spend_usd DESC NULLS LAST
  `);

  const rows = rawRows.map(r => ({
    user_id: r.user_id,
    display_name: r.display_name,
    email: r.email,
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
  }));

  return NextResponse.json({ users: rows });
}
