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
import { sql } from 'drizzle-orm';
import { getAdminSession, canAccessCoworkPulse } from '@/lib/auth/admin-auth';
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

  const client = await getTypedClient();

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
       FROM pulse_metrics
       WHERE scope_type = 'user' AND granularity = 'rolling'
         AND (scope_id, computed_at) IN (
           SELECT scope_id, MAX(computed_at)
           FROM pulse_metrics
           WHERE scope_type = 'user' AND granularity = 'rolling'
           GROUP BY scope_id
         )
     ) pm ON pm.user_id = u.id
     LEFT JOIN (
       -- Most recent team-level metric per team (for ORS)
       SELECT scope_id AS team_id, ors
       FROM pulse_metrics
       WHERE scope_type = 'team' AND granularity = 'rolling'
         AND (scope_id, computed_at) IN (
           SELECT scope_id, MAX(computed_at)
           FROM pulse_metrics
           WHERE scope_type = 'team' AND granularity = 'rolling'
           GROUP BY scope_id
         )
     ) tm ON tm.team_id = u.team_id
     WHERE u.department IS NOT NULL AND u.department != ''
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
