// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. Follows the
// standard pattern (app/api/pulse/code/depts/route.ts): a
// local rawAll() facade for the "latest metrics row per user" correlated
// subqueries + LEFT JOIN — clearer as raw SQL than the query builder here.
// The optional dept filter is built as a CONDITIONAL SQL fragment (omitted when
// no filter is supplied), the same shape depts/route.ts uses. Do not use a
// `(${deptFilter} IS NULL OR ...)` form: on Postgres a bound param in a bare
// `$1 IS NULL` has no inferable type ("could not determine data type of
// parameter $1"). Regression-guarded by
// test/pulse-admin-users-route-pg.test.ts. `ORDER BY ... DESC
// NULLS LAST` is native SQL on Postgres. pending_count/
// failed_count (COUNT(*)) and the three bigint *_at columns are Number()-
// coerced (raw execute bypasses Drizzle's per-column bigint codec,
// and COUNT comes back as a string on Postgres); dds/oti/ors/psr/tier_*_count
// are double precision/integer, which node-postgres already decodes as JS
// numbers, so they pass through unchanged.
import { NextRequest, NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { getAdminSession, canAccessCoworkPulse, isDeptScoped } from '@/lib/auth/admin-auth';
import { getTypedClient } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

// ─── Raw-execution facade (mirrors lib/db/queries.ts's rawAll) ────────────────
interface RawFacade {
  execute?: (q: unknown) => Promise<{ rows: unknown[]; rowCount: number | null }>;
}
async function rawAll<T>(client: unknown, query: unknown): Promise<T[]> {
  const c = client as RawFacade;
  const res = await c.execute!(query);
  return res.rows as T[];
}

interface RawUserRow {
  id: string;
  display_name: string | null;
  email: string;
  department: string | null;
  dds: number | null;
  oti: number | null;
  ors: number | null;
  psr: number | null;
  tier_1_count: number | null;
  tier_2_count: number | null;
  tier_3_count: number | null;
  last_metrics_at: number | string | null;
  last_briefing_at: number | string | null;
  last_active_at: number | string | null;
  pending_count: number | string;
  failed_count: number | string;
}

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  // Allow all roles with Work Pulse access
  if (!canAccessCoworkPulse(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  // cowork must have a department to access user lists
  if (isDeptScoped(session.role) && !session.department) {
    return NextResponse.json(
      { error: 'no_department', message: 'Your account has no department assigned. Ask your admin to set one.' },
      { status: 422 }
    );
  }

  const rawDept = request.nextUrl.searchParams.get('dept') || undefined;
  // cowork role: always filter to own department regardless of query param
  // (Note: canAccessPulseAdmin does NOT include cowork, so in practice this
  //  branch only fires if isDeptScoped is called independently on a cowork session
  //  that somehow reaches this route. But it's safe to include for defence-in-depth.)
  const deptFilter: string | undefined = isDeptScoped(session.role)
    ? (session.department ?? undefined)
    : rawDept;

  const client = await getTypedClient();

  const rawRows = await rawAll<RawUserRow>(client, sql`
     SELECT
       u.id,
       u.display_name,
       u.email,
       u.department,
       pm.dds,
       pm.oti,
       pm.ors,
       pm.psr,
       pm.tier_1_count,
       pm.tier_2_count,
       pm.tier_3_count,
       pm.computed_at   AS last_metrics_at,
       (SELECT generated_at FROM pulse_briefings
         WHERE scope_id = u.id AND scope_type = 'user'
         ORDER BY generated_at DESC LIMIT 1) AS last_briefing_at,
       (SELECT MAX(occurred_at) FROM cowork_messages
         WHERE user_id = u.id AND surface = 'cowork') AS last_active_at,
       (SELECT COUNT(*) FROM cowork_messages cm2
         WHERE cm2.user_id = u.id AND cm2.surface = 'cowork'
           AND cm2.message_type = 'cowork_user_message'
           AND cm2.id NOT IN (
             SELECT cowork_message_id FROM pulse_classifications
             WHERE classifier_status = 'classified'
                OR classifier_attempts >= 5
           )) AS pending_count,
       (SELECT COUNT(*) FROM pulse_classifications
         WHERE user_id = u.id AND classifier_status = 'failed') AS failed_count
     FROM users u
     LEFT JOIN pulse_metrics pm
       ON pm.scope_id = u.id
       AND pm.scope_type = 'user'
       AND pm.granularity = 'rolling'
       AND pm.computed_at = (
         SELECT MAX(computed_at) FROM pulse_metrics
         WHERE scope_id = u.id AND scope_type = 'user' AND granularity = 'rolling'
       )
     WHERE EXISTS (
       SELECT 1 FROM cowork_messages
       WHERE user_id = u.id AND surface = 'cowork'
     )
     ${deptFilter ? sql`AND u.department = ${deptFilter}` : sql``}
     ORDER BY pm.dds DESC NULLS LAST, u.display_name ASC
  `);

  const rows = rawRows.map(r => ({
    ...r,
    last_metrics_at: r.last_metrics_at !== null && r.last_metrics_at !== undefined ? Number(r.last_metrics_at) : null,
    last_briefing_at: r.last_briefing_at !== null && r.last_briefing_at !== undefined ? Number(r.last_briefing_at) : null,
    last_active_at: r.last_active_at !== null && r.last_active_at !== undefined ? Number(r.last_active_at) : null,
    pending_count: Number(r.pending_count ?? 0),
    failed_count: Number(r.failed_count ?? 0),
  }));

  return NextResponse.json({ users: rows });
}
