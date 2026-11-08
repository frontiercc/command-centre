// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. Follows the
// standard pattern: getTypedClient() + a local rawAll()
// facade for the "latest row per scope" tuple-IN-subquery + double LEFT JOIN
// below (far clearer as raw SQL than a Drizzle query-builder equivalent, and
// this exact shape is what test/pulse-granularity-readers.test.ts already
// pins as "the exact patched SQL from depts route"). Postgres supports
// row-value `(a, b) IN (SELECT a, MAX(b) ... GROUP BY a)` natively.
// AVG(...) results are Number()-coerced (numeric/double precision aggregates can come back as STRINGS on Postgres).
import { NextRequest, NextResponse } from 'next/server';
import { visibleVendor } from '@/lib/sources/openai-visibility';
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

interface RawDeptRow {
  department: string;
  member_count: number | string;
  avg_dds: number | string | null;
  avg_oti: number | string | null;
  avg_ors: number | string | null;
}

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated || !canAccessCoworkPulse(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Contributor roles (cowork, pulse) see only their own department, the same
  // rule as the department page's route and Developer Pulse's department list.
  if (isDeptScoped(session.role) && !session.department) {
    return NextResponse.json(
      { error: 'no_department', message: 'Your account has no department assigned. Ask your admin to set one.' },
      { status: 422 }
    );
  }
  const ownDept = isDeptScoped(session.role) ? session.department! : null;

  const client = await getTypedClient();
  // The Claude / OpenAI switch: a vendor view reads the aggregator's per-vendor figures.
  const vendor = await visibleVendor(request.nextUrl.searchParams.get('vendor'));
  const metrics = vendor === 'all' ? sql`pulse_metrics` : sql`pulse_metrics_vendor`;
  const only = vendor === 'all' ? sql`` : sql`AND vendor = ${vendor}`;

  // Departments with member count and per-dept metric averages.
  // Metrics are aggregated from user-scoped pulse_metrics rows joined through
  // users.department so this works immediately without waiting for dept-level
  // aggregator runs (scope_type='dept').
  const rows = await rawAll<RawDeptRow>(client, sql`
     SELECT
       u.department,
       COUNT(DISTINCT u.id)           AS member_count,
       AVG(pm.dds)                    AS avg_dds,
       AVG(pm.oti)                    AS avg_oti,
       AVG(tm.ors)                    AS avg_ors
     FROM users u
     LEFT JOIN (
       -- Most recent user-level metric per user (for DDS/OTI)
       SELECT scope_id AS user_id, dds, oti
       FROM ${metrics}
       WHERE scope_type = 'user' AND granularity = 'rolling' ${only}
         AND (scope_id, computed_at) IN (
           SELECT scope_id, MAX(computed_at)
           FROM ${metrics}
           WHERE scope_type = 'user' AND granularity = 'rolling' ${only}
           GROUP BY scope_id
         )
     ) pm ON pm.user_id = u.id
     LEFT JOIN (
       -- Most recent department-level ORS. Read per department, as the
       -- overview's headline does: the team grouping (users.team_id) is never
       -- filled in, so joining on it left this column blank. Only rows that
       -- carry ORS count: the daily run writes newer department rows without it.
       SELECT scope_id AS department, ors
       FROM ${metrics}
       WHERE scope_type = 'function' AND granularity = 'rolling' AND ors IS NOT NULL ${only}
         AND (scope_id, computed_at) IN (
           SELECT scope_id, MAX(computed_at)
           FROM ${metrics}
           WHERE scope_type = 'function' AND granularity = 'rolling' AND ors IS NOT NULL ${only}
           GROUP BY scope_id
         )
     ) tm ON tm.department = u.department
     WHERE u.department IS NOT NULL AND u.department != ''
       ${ownDept !== null ? sql`AND u.department = ${ownDept}` : sql``}
     GROUP BY u.department
     ORDER BY u.department
  `);

  const depts = rows.map(r => ({
    department: r.department,
    member_count: Number(r.member_count),
    avg_dds: r.avg_dds !== null && r.avg_dds !== undefined ? Number(r.avg_dds) : null,
    avg_oti: r.avg_oti !== null && r.avg_oti !== undefined ? Number(r.avg_oti) : null,
    avg_ors: r.avg_ors !== null && r.avg_ors !== undefined ? Number(r.avg_ors) : null,
  }));

  return NextResponse.json({ depts });
}
