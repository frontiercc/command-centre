// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. Follows the
// standard pattern: getTypedClient() + schema.<table> +
// query-builder groupBy + notInArray for the NOT IN literal list. Every
// COUNT/COUNT(DISTINCT) aggregate is Number()-coerced (bigint
// comes back as a STRING on Postgres).
import { NextRequest, NextResponse } from 'next/server';
import { notBoardHiddenConnector, entryNotBoardHidden } from '@/lib/library/built-in-connectors';
import { and, eq, gte, notInArray, sql } from 'drizzle-orm';
import { canAccessOrgOverview, getAdminSession } from '@/lib/auth/admin-auth';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { vendorExpr, toolTagExpr } from '@/lib/dashboard/product-sql';

export const dynamic = 'force-dynamic';

const EXCLUDED_CONNECTORS = ['workspace', 'cowork'];

// A skill or connector of the same name from Claude and from OpenAI is two
// different tools, so every list is grouped by name and vendor.
const skillVendorSql = sql.raw(vendorExpr('cowork_skill_invocations.'));
const connectorVendorSql = sql.raw(vendorExpr('cowork_mcp_invocations.'));
// The product each row came from, as its tag reads (Claude, ChatGPT or Codex).
const skillTagSql = sql.raw(toolTagExpr('cowork_skill_invocations.'));
const connectorTagSql = sql.raw(toolTagExpr('cowork_mcp_invocations.'));
type RowVendor = 'claude' | 'openai';

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const client = await getTypedClient();
  const now = Math.floor(Date.now() / 1000);
  const thirtyDaysAgo = now - 30 * 24 * 3600;

  const au = schema.adminUsers;
  const u = schema.users;
  const csi = schema.coworkSkillInvocations;
  const cmi = schema.coworkMcpInvocations;

  // Resolve the current user's cowork user_id: the linked activity record,
  // else the users row with the same email.
  const resolveUserId = async (): Promise<string | null> => {
    const linkedRows = await client
      .select({ linked_cowork_user_id: au.linked_cowork_user_id })
      .from(au)
      .where(eq(au.email, session.email!))
      .limit(1);
    const linked = linkedRows[0];
    if (linked?.linked_cowork_user_id) return linked.linked_cowork_user_id;
    const byEmailRows = await client.select({ id: u.id }).from(u).where(eq(u.email, session.email!)).limit(1);
    return byEmailRows[0]?.id ?? null;
  };

  const sixtyDaysAgo = now - 60 * 24 * 3600;
  interface Exec { execute: (q: ReturnType<typeof sql>) => Promise<{ rows: unknown[] }> }
  const raw = client as unknown as Exec;
  const num = (v: unknown) => Number(v ?? 0);

  // Stage 1: the caller's activity record and the organisation-wide reads.
  // None depends on another, so they all run at the same time.
  const [userId, topSkillsRows, topConnectorsRows, spreadResult, soleResult] = await Promise.all([
    resolveUserId(),

    // Org top skills (30 days)
    client
      .select({
        skill_name: csi.skill_name,
        vendor: sql<string>`${skillVendorSql}`,
        tag: sql<string>`${skillTagSql}`,
        usage_count: sql<number | string>`COUNT(*)`,
        user_count: sql<number | string>`COUNT(DISTINCT ${csi.user_id})`,
      })
      .from(csi)
      .where(gte(csi.occurred_at, thirtyDaysAgo))
      .groupBy(csi.skill_name, skillVendorSql, skillTagSql)
      .orderBy(sql`COUNT(*) DESC`)
      .limit(10),

    // Org top connectors (30 days, exclude system defaults)
    client
      .select({
        mcp_server: cmi.mcp_server,
        vendor: sql<string>`${connectorVendorSql}`,
        tag: sql<string>`${connectorTagSql}`,
        usage_count: sql<number | string>`COUNT(*)`,
        user_count: sql<number | string>`COUNT(DISTINCT ${cmi.user_id})`,
      })
      .from(cmi)
      .where(and(gte(cmi.occurred_at, thirtyDaysAgo), notInArray(cmi.mcp_server, EXCLUDED_CONNECTORS)))
      .groupBy(cmi.mcp_server, connectorVendorSql, connectorTagSql)
      .orderBy(sql`COUNT(*) DESC`)
      .limit(10),

    // ── What is spreading: people using each one now against the 30 days before ──
    raw.execute(sql`
    SELECT kind, name, tag,
           COUNT(DISTINCT CASE WHEN occurred_at >= ${thirtyDaysAgo} THEN user_id END) AS people,
           COUNT(DISTINCT CASE WHEN occurred_at >= ${sixtyDaysAgo} AND occurred_at < ${thirtyDaysAgo} THEN user_id END) AS before,
           COUNT(CASE WHEN occurred_at >= ${thirtyDaysAgo} THEN 1 END) AS uses,
           MIN(occurred_at) AS first_at
    FROM (
      SELECT 'skill' AS kind, skill_name AS name, ${skillTagSql} AS tag, user_id, occurred_at
        FROM cowork_skill_invocations
      UNION ALL
      SELECT 'connector' AS kind, mcp_server AS name, ${connectorTagSql} AS tag, user_id, occurred_at
        FROM cowork_mcp_invocations
        WHERE ${notBoardHiddenConnector(sql.raw('mcp_server'))}
    ) t
    GROUP BY kind, name, tag
    HAVING COUNT(DISTINCT CASE WHEN occurred_at >= ${thirtyDaysAgo} THEN user_id END) > 0
    ORDER BY 4 DESC, 2
  `),

    // ── Stuck with one person: used by exactly one person in the last 30 days ──
    raw.execute(sql`
    SELECT t.kind, t.name, t.tag, MIN(t.user_id) AS user_id, COUNT(*) AS uses
    FROM (
      SELECT 'skill' AS kind, skill_name AS name, ${skillTagSql} AS tag, user_id
        FROM cowork_skill_invocations WHERE occurred_at >= ${thirtyDaysAgo}
      UNION ALL
      SELECT 'connector' AS kind, mcp_server AS name, ${connectorTagSql} AS tag, user_id
        FROM cowork_mcp_invocations
        WHERE occurred_at >= ${thirtyDaysAgo} AND ${notBoardHiddenConnector(sql.raw('mcp_server'))}
    ) t
    GROUP BY t.kind, t.name, t.tag
    HAVING COUNT(DISTINCT t.user_id) = 1
    ORDER BY COUNT(*) DESC
    LIMIT 12
  `),
  ]);

  const topSkills = topSkillsRows.map(r => ({ skill_name: r.skill_name, vendor: r.vendor as RowVendor, tag: r.tag, usage_count: Number(r.usage_count), user_count: Number(r.user_count) }));
  const topConnectors = topConnectorsRows.map(r => ({ mcp_server: r.mcp_server, vendor: r.vendor as RowVendor, tag: r.tag, usage_count: Number(r.usage_count), user_count: Number(r.user_count) }));

  const spreadRows = spreadResult.rows as Array<{ kind: 'skill' | 'connector'; name: string; tag: string; people: number | string; before: number | string; uses: number | string; first_at: number | string }>;
  const spread = spreadRows.map(r => ({
    kind: r.kind, name: r.name, tag: r.tag,
    people: num(r.people), before: num(r.before), uses: num(r.uses),
    isNew: num(r.first_at) >= thirtyDaysAgo,
  }));

  const soleRows = soleResult.rows as Array<{ kind: 'skill' | 'connector'; name: string; tag: string; user_id: string; uses: number | string }>;
  const soleIds = [...new Set(soleRows.map(r => r.user_id))];

  // The "used by nobody" list needs the caller's department first, so the two
  // run one after the other, alongside the other stage 2 reads.
  const readUnused = async () => {
    // The S&C Board's own department rule (app/api/library/route.ts): an entry an admin or manager
    // restricted to a department is shown only to that department, and to admins, managers and
    // viewers. The caller's department is the sign-in account's or the activity record's.
    const usersDeptRows = userId ? await client.select({ department: u.department }).from(u).where(eq(u.id, userId)) : [];
    const callerDepts = [...new Set([session.department, usersDeptRows[0]?.department ?? null].filter((d): d is string => Boolean(d)))];
    const boardVisible = canAccessOrgOverview(session.role)
      ? sql`TRUE`
      : callerDepts.length
        ? sql`(e.department IS NULL OR ${sql.join(callerDepts.map(d => sql`e.department = ${d}`), sql` OR `)})`
        : sql`e.department IS NULL`;

    // ── Used by nobody: the organisation's OWN published Board entries with no use in the last 30
    // days. Unclaimed entries are left out (the Board registers every name telemetry sees, so an
    // unused name nobody chose is not a finding) and so is Anthropic's catalogue, which publishes
    // itself. What is left is what this organisation put its name to: a nudge or a retirement. ──
    return (await raw.execute(sql`
    SELECT e.id, e.name, e.type, e.is_published,
           COALESCE(NULLIF(au.display_name, ''), ou.display_name, ou.email) AS author,
           (SELECT MAX(occurred_at) FROM (
              SELECT occurred_at FROM cowork_skill_invocations WHERE skill_name = e.name
              UNION ALL
              SELECT occurred_at FROM cowork_mcp_invocations WHERE mcp_server = e.name
            ) a) AS last_at
    FROM skill_library_entries e
    LEFT JOIN users ou ON ou.id = e.author_user_id
    LEFT JOIN admin_users au ON au.linked_cowork_user_id = e.author_user_id
    WHERE e.is_published = 1 AND e.source <> 'anthropic'
      AND ${entryNotBoardHidden(sql.raw('e.type'), sql.raw('e.name'))}
      AND ${boardVisible}
    ORDER BY e.name
  `)).rows as Array<{ id: number | string; name: string; type: string; is_published: number | string; author: string | null; last_at: number | string | null }>;
  };

  // Stage 2: reads that need stage 1's answers (the caller's own uses, the
  // names behind the one-person list, and the unused list). They run together.
  const [mySkillsRows, myConnectorsRows, soleNamesResult, unusedRows] = await Promise.all([
    // User's own skills and connectors (30 days)
    userId
      ? client
          .select({ skill_name: csi.skill_name, vendor: sql<string>`${skillVendorSql}`, usage_count: sql<number | string>`COUNT(*)` })
          .from(csi)
          .where(and(eq(csi.user_id, userId), gte(csi.occurred_at, thirtyDaysAgo)))
          .groupBy(csi.skill_name, skillVendorSql)
      : Promise.resolve([]),
    userId
      ? client
          .select({ mcp_server: cmi.mcp_server, vendor: sql<string>`${connectorVendorSql}`, usage_count: sql<number | string>`COUNT(*)` })
          .from(cmi)
          .where(and(eq(cmi.user_id, userId), gte(cmi.occurred_at, thirtyDaysAgo), notInArray(cmi.mcp_server, EXCLUDED_CONNECTORS)))
          .groupBy(cmi.mcp_server, connectorVendorSql)
      : Promise.resolve([]),
    soleIds.length === 0 ? Promise.resolve({ rows: [] as unknown[] }) : raw.execute(sql`
    SELECT u.id, COALESCE(NULLIF(au.display_name, ''), u.display_name, u.email) AS name,
           COALESCE(NULLIF(au.department, ''), u.department) AS department
    FROM users u LEFT JOIN admin_users au ON au.linked_cowork_user_id = u.id
    WHERE u.id IN (${sql.join(soleIds.map(id => sql`${id}`), sql`, `)})
  `),
    readUnused(),
  ]);

  const mySkills: Array<{ skill_name: string; vendor: RowVendor; usage_count: number }> =
    mySkillsRows.map(r => ({ skill_name: r.skill_name, vendor: r.vendor as RowVendor, usage_count: Number(r.usage_count) }));
  const myConnectors: Array<{ mcp_server: string; vendor: RowVendor; usage_count: number }> =
    myConnectorsRows.map(r => ({ mcp_server: r.mcp_server, vendor: r.vendor as RowVendor, usage_count: Number(r.usage_count) }));

  // Compute gap: org top items the current user hasn't used
  const mySkillSet = new Set(mySkills.map(s => `${s.skill_name}|${s.vendor}`));
  const myConnectorSet = new Set(myConnectors.map(c => `${c.mcp_server}|${c.vendor}`));

  const skillGap = topSkills.filter(s => !mySkillSet.has(`${s.skill_name}|${s.vendor}`));
  const connectorGap = topConnectors.filter(c => !myConnectorSet.has(`${c.mcp_server}|${c.vendor}`));

  const soleNames = soleNamesResult.rows as Array<{ id: string; name: string | null; department: string | null }>;
  const whoById = new Map(soleNames.map(r => [r.id, r]));
  const sole = soleRows.map(r => ({
    kind: r.kind, name: r.name, tag: r.tag, uses: num(r.uses),
    who: whoById.get(r.user_id)?.name ?? null,
    department: whoById.get(r.user_id)?.department ?? null,
  }));

  const unused = unusedRows
    .filter(r => r.last_at === null || num(r.last_at) < thirtyDaysAgo)
    .map(r => ({
      id: num(r.id), name: r.name, kind: r.type,
      author: r.author,
      claimed: true,
      lastUsed: r.last_at === null ? null : num(r.last_at),
    }))
    // Never used first, then the longest since anyone used it.
    .sort((a, b) => (a.lastUsed === null ? -1 : b.lastUsed === null ? 1 : a.lastUsed - b.lastUsed));

  return NextResponse.json({
    spread,
    sole,
    unused,
    unusedOf: unusedRows.length,
    topSkills,
    topConnectors,
    mySkills,
    myConnectors,
    skillGap,
    connectorGap,
  });
}
