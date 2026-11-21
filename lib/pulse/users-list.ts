// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The Work Pulse Users list (app/api/pulse/admin/users). Async Drizzle on Postgres. Follows the
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
import { sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { isWorkPulseSurface, classifiableSource, classifyChatgptOn } from '@/lib/pulse/work-surfaces';
import { productExpr } from '@/lib/dashboard/product-sql';
import type { Vendor } from '@/lib/dashboard/vendor';

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

/** Every Work Pulse user's latest figures, optionally for one department, in one vendor view. */
export async function buildUsersList(deptFilter: string | undefined, vendor: Vendor) {
  const metricsTable = sql.raw(vendor === 'all' ? 'pulse_metrics' : 'pulse_metrics_vendor');
  const metricsVendor = vendor === 'all' ? sql`` : sql`AND vendor = ${vendor}`;

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
       act.last_active_at,
       COALESCE(pend.n, 0) AS pending_count,
       COALESCE(fail.n, 0) AS failed_count
     FROM users u
     -- Each figure is worked out for everyone in one pass, not person by person.
     JOIN (
       SELECT user_id, MAX(occurred_at) AS last_active_at FROM cowork_messages
        WHERE ${isWorkPulseSurface(sql`surface`)} GROUP BY user_id
     ) act ON act.user_id = u.id
     LEFT JOIN (
       SELECT cm2.user_id, COUNT(*) AS n FROM cowork_messages cm2
        WHERE ${isWorkPulseSurface(sql`cm2.surface`)}
          AND cm2.message_type = 'cowork_user_message'
          AND ${classifiableSource(sql`cm2.source`, await classifyChatgptOn())}
          AND cm2.id NOT IN (
            SELECT cowork_message_id FROM pulse_classifications
            WHERE classifier_status = 'classified'
               OR classifier_attempts >= 5
          )
        GROUP BY cm2.user_id
     ) pend ON pend.user_id = u.id
     LEFT JOIN (
       SELECT user_id, COUNT(*) AS n FROM pulse_classifications WHERE classifier_status = 'failed' GROUP BY user_id
     ) fail ON fail.user_id = u.id
     LEFT JOIN ${metricsTable} pm
       ON pm.scope_id = u.id
       AND pm.scope_type = 'user'
       AND pm.granularity = 'rolling'
       ${vendor === 'all' ? sql`` : sql`AND pm.vendor = ${vendor}`}
       AND pm.computed_at = (
         SELECT MAX(computed_at) FROM ${metricsTable}
         WHERE scope_id = u.id AND scope_type = 'user' AND granularity = 'rolling' ${metricsVendor}
       )
     ${deptFilter ? sql`WHERE u.department = ${deptFilter}` : sql``}
     ORDER BY pm.dds DESC NULLS LAST, u.display_name ASC
  `);

  // The Work Pulse products each person used in the last 30 days (Claude
  // Cowork, Claude Chat, ChatGPT Work, ChatGPT Chat), for the tags beside a name.
  const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 86400;
  const productRows = rawRows.length === 0 ? [] : await rawAll<{ user_id: string; product: string }>(client, sql`
     SELECT DISTINCT user_id, ${sql.raw(productExpr())} AS product
     FROM cowork_messages
     WHERE ${isWorkPulseSurface(sql`surface`)}
       AND message_type = 'cowork_user_message'
       AND occurred_at >= ${thirtyDaysAgo}
       AND user_id IN (${sql.join(rawRows.map(r => sql`${r.id}`), sql`, `)})
  `);
  const productsByUser = new Map<string, string[]>();
  for (const r of productRows) productsByUser.set(r.user_id, [...(productsByUser.get(r.user_id) ?? []), r.product]);

  const rows = rawRows.map(r => ({
    ...r,
    products: productsByUser.get(r.id) ?? [],
    last_metrics_at: r.last_metrics_at !== null && r.last_metrics_at !== undefined ? Number(r.last_metrics_at) : null,
    last_briefing_at: r.last_briefing_at !== null && r.last_briefing_at !== undefined ? Number(r.last_briefing_at) : null,
    last_active_at: r.last_active_at !== null && r.last_active_at !== undefined ? Number(r.last_active_at) : null,
    pending_count: Number(r.pending_count ?? 0),
    failed_count: Number(r.failed_count ?? 0),
  }));

  return { users: rows };
}
