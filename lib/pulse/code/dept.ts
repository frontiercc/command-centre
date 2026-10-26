// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Follows the pattern in (lib/db/queries.ts, lib/pulse/code/
// aggregator.ts): getTypedClient() + a local rawAll() facade for the
// UNION + correlated-subquery + LEFT JOIN below, which is far clearer as raw
// SQL than a Drizzle query-builder equivalent. `cm.spend_usd` is Postgres
// `numeric` (returned as a STRING) — Number()-coerced at the read site
// (Policy B), same for the COALESCE'd integer aggregates. `department` is
// matched with plain `=` (never LIKE), which is case-sensitive — no ILIKE
// needed.
import { sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';

export interface CodeDeptMember {
  user_id: string;
  display_name: string | null;
  email: string | null;
  department: string | null;
  spend_usd: number | null;
  autonomy_ratio: number | null;
  cache_hit_ratio: number | null;
  session_count: number;
  repo_count: number;
  commit_count: number;
  skill_leverage: number | null;
  input_tokens: number;
  output_tokens: number;
  // Populated by the dept route (app/api/pulse/code/dept/[dept]/route.ts),
  // not by the query in this file.
  github_repo_count?: number;
}

// ─── Phase 3 raw-execution facade (mirrors lib/db/queries.ts's rawAll) ────────
interface RawFacade {
  execute: (q: unknown) => Promise<{ rows: unknown[]; rowCount: number | null }>;
}
async function rawAll<T>(client: unknown, query: unknown): Promise<T[]> {
  const c = client as RawFacade;
  const res = await c.execute(query);
  return res.rows as T[];
}

interface RawDeptMemberRow {
  user_id: string;
  display_name: string | null;
  email: string | null;
  spend_usd: string | number | null;
  autonomy_ratio: number | null;
  cache_hit_ratio: number | null;
  session_count: number | string;
  repo_count: number | string;
  commit_count: number | string;
  skill_leverage: number | null;
  input_tokens: number | string;
  output_tokens: number | string;
}

/**
 * Department members for Developer Pulse — MEMBERSHIP-first (the full roster), not
 * metrics-first.
 *
 * The previous query started from `code_metrics` user-scope rows, so a member
 * only appeared if they had Code activity in the aggregation window — a 5-person
 * department where one person used Claude Code recently showed a single member.
 *
 * The roster is the union of both department-resolution paths CCC uses (and that
 * the aggregator uses for the dept rollup): `users.department` and
 * `admin_users.department → linked_cowork_user_id`. Each member LEFT JOINs their
 * latest user-scope `code_metrics`, so members with no recent Code activity still
 * appear with null/zero metrics instead of being dropped.
 */
export async function getCodeDeptMembers(dept: string): Promise<CodeDeptMember[]> {
  const client = await getTypedClient();
  const rows = await rawAll<RawDeptMemberRow>(client, sql`
     SELECT roster.id AS user_id, roster.display_name, roster.email,
            cm.spend_usd, cm.autonomy_ratio, cm.cache_hit_ratio,
            COALESCE(cm.session_count, 0) AS session_count,
            COALESCE(cm.repo_count, 0)   AS repo_count,
            COALESCE(cm.commit_count, 0) AS commit_count,
            cm.skill_leverage,
            COALESCE(cm.input_tokens, 0)  AS input_tokens,
            COALESCE(cm.output_tokens, 0) AS output_tokens
     FROM (
       SELECT id, display_name, email FROM users WHERE department = ${dept}
       UNION
       SELECT u.id, u.display_name, u.email
         FROM admin_users au JOIN users u ON u.id = au.linked_cowork_user_id
        WHERE au.department = ${dept}
     ) roster
     LEFT JOIN (
       SELECT scope_id, MAX(id) AS max_id FROM code_metrics
       WHERE scope_type = 'user' AND granularity = 'rolling' GROUP BY scope_id
     ) latest ON latest.scope_id = roster.id
     LEFT JOIN code_metrics cm ON cm.id = latest.max_id AND cm.granularity = 'rolling'
     ORDER BY cm.spend_usd DESC NULLS LAST, roster.display_name
  `);

  return rows.map(r => ({
    user_id: r.user_id,
    display_name: r.display_name,
    email: r.email,
    department: dept,
    spend_usd: r.spend_usd !== null && r.spend_usd !== undefined ? Number(r.spend_usd) : null,
    autonomy_ratio: r.autonomy_ratio,
    cache_hit_ratio: r.cache_hit_ratio,
    session_count: Number(r.session_count ?? 0),
    repo_count: Number(r.repo_count ?? 0),
    commit_count: Number(r.commit_count ?? 0),
    skill_leverage: r.skill_leverage,
    input_tokens: Number(r.input_tokens ?? 0),
    output_tokens: Number(r.output_tokens ?? 0),
  }));
}
