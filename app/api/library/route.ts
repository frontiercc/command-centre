// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. Follows the
// standard pattern: getTypedClient() + schema.<table> for
// straightforward single-table aggregates/lookups (via the query builder, so
// bigint columns like created_at/updated_at decode to `number` automatically),
// and a local rawAll() facade (mirrors lib/db/queries.ts + app/api/pulse/cio/
// route.ts) for the composite multi-subquery-join gamification-signal reads
// (browse listing, leaderboard, rank window function, skills-to-try,
// dept-picks, recent entries, dept breakdown) — every COUNT/SUM aggregate
// from those raw reads is Number()-coerced (bigint/numeric come
// back as STRINGS on Postgres), and every entries-table bigint column
// (created_at/updated_at) touched by a raw read is likewise coerced, since
// raw execute() bypasses the query builder's schema-aware bigint codec.
//
// Two strict-Postgres query shapes:
//   - deptPicks: Postgres requires every non-aggregated SELECT column to be
//     part of the GROUP BY. Since `name` is UNIQUE (not just grouped-by),
//     grouping by the rest of the entry columns changes nothing about the result.
//   - deptBreakdown: Postgres does not allow SELECT-list aliases in HAVING
//     (only in ORDER BY/GROUP BY), so the aggregate expression is repeated
//     verbatim in the HAVING clause.
//
// Case-insensitive search: the `q` name/description search uses
// ILIKE, since Postgres LIKE is case-sensitive.
import { NextRequest, NextResponse } from 'next/server';
import { normaliseSourceUrl, SOURCE_URL_ERROR } from '@/lib/library/source-url';
import { callerPersonId } from '@/lib/library/author';
import { and, desc, eq, gte, inArray, isNull, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { canAccessOrgOverview, getAdminSession } from '@/lib/auth/admin-auth';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getConnectorReadWriteCounts } from '@/lib/pulse/mcp-classify';

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

const EXCLUDED_MCP_SERVERS = ['workspace', 'cowork', 'Claude_in_Chrome'];

interface LibraryEntry {
  id: number;
  name: string;
  type: string;
  surface: string;
  description: string | null;
  author_user_id: string | null;
  author_name: string | null;
  is_published: number;
  install_guide: string | null;
  source_url: string | null;
  created_at: number | string;
  updated_at: number | string;
  invocation_count: number | string;
  user_count: number | string;
  vote_count: number | string;
  user_voted: number | string;
  week_count: number | string;
  prev_week_count: number | string;
  reads?: number;
  writes?: number;
}

export async function GET(req: NextRequest) {
  const session = await getAdminSession(req);
  if (!session.authenticated) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const type       = searchParams.get('type') ?? '';
  const surface     = searchParams.get('surface') ?? '';
  const sort        = searchParams.get('sort') ?? 'most_used';
  const claimed     = searchParams.get('claimed') ?? '';
  const source      = searchParams.get('source') ?? '';
  const q           = searchParams.get('q') ?? '';
  const deptFilter  = searchParams.get('department') ?? '';
  const page    = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10));
  const perPage = Math.min(200, Math.max(1, parseInt(searchParams.get('per_page') ?? '20', 10)));

  const client = await getTypedClient();
  const now = Math.floor(Date.now() / 1000);
  const weekAgo = now - 7 * 86400;
  const twoWeeksAgo = now - 14 * 86400;
  const userId = session.userId ?? '';

  // Current user's department, computed here so the visibility filter can
  // use it too.
  const u0 = schema.users;
  const userDeptRows0 = userId
    ? await client.select({ department: u0.department }).from(u0).where(eq(u0.id, userId))
    : [];
  const userDept = userDeptRows0[0]?.department ?? null;
  // "The caller's department" for VISIBILITY GATING
  // is the union of session.department (admin_users) and the users-table
  // department looked up above — an entry restricted to either one is
  // visible to that caller. `userDept` itself is left untouched everywhere
  // else (dept_picks/user_dept are a personalised-picks feature keyed on
  // the users-table department specifically, not a security gate).
  // Dedupe: the common case is both sources
  // agreeing, which without this would produce a redundant
  // `e.department = $1 OR e.department = $2` with identical values.
  const callerDepts = [...new Set([session.department, userDept].filter((d): d is string => Boolean(d)))];
  const seesEverything = canAccessOrgOverview(session.role);
  // Shared OR-fragment ("department matches any of the caller's known
  // departments"), reused by the main listing condition below AND by
  // skills_to_try further down — both visibility gates must use the same
  // callerDepts union.
  const deptOr = callerDepts.length
    ? sql`(${sql.join(callerDepts.map(d => sql`e.department = ${d}`), sql` OR `)})`
    : sql`false`;

  const conditions: SQL[] = [];
  if (type) conditions.push(sql`e.type = ${type}`);
  if (surface && surface !== 'both') conditions.push(sql`(e.surface = ${surface} OR e.surface = 'both')`);
  if (surface === 'both') conditions.push(sql`e.surface = 'both'`);
  if (claimed === 'true')  conditions.push(sql`e.is_published = 1`);
  if (claimed === 'false') conditions.push(sql`e.is_published = 0`);
  if (source) conditions.push(sql`e.source = ${source}`);
  // Department visibility: unclaimed entries always stay visible (needed
  // for discovery/claiming); a claimed entry is visible if org-wide (null),
  // matches the caller's own department (either source, see callerDepts
  // above), or the caller has an org-overview role (admin/manager/viewer).
  if (!seesEverything) {
    conditions.push(sql`(e.is_published = 0 OR e.department IS NULL OR ${deptOr})`);
  }
  if (deptFilter === 'mine' && callerDepts.length) {
    const mineOr = sql.join(callerDepts.map(d => sql`e.department = ${d}`), sql` OR `);
    conditions.push(sql`(e.department IS NULL OR (${mineOr}))`);
  }
  if (q) {
    const pattern = `%${q}%`;
    // Postgres LIKE is case-sensitive; ILIKE keeps the search
    // case-insensitive.
    conditions.push(
      sql`(e.name ILIKE ${pattern} OR e.description ILIKE ${pattern})`,
    );
  }
  const whereSql = conditions.length ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;

  const orderMap: Record<string, string> = {
    most_used:  'invocation_count DESC',
    trending:   '(week_count - prev_week_count) DESC',
    most_voted: 'vote_count DESC',
    newest:     'e.created_at DESC',
  };
  // orderBy is resolved from the fixed orderMap above (never raw user input),
  // so interpolating it via sql.raw is safe.
  const orderBy = orderMap[sort] ?? orderMap.most_used;

  const rowsRaw = await rawAll<LibraryEntry>(client, sql`
    SELECT
      e.*,
      u.display_name   AS author_name,
      COALESCE(inv.cnt, 0)  AS invocation_count,
      COALESCE(inv.ucnt, 0) AS user_count,
      COALESCE(v.vcnt, 0)   AS vote_count,
      COALESCE(mv.voted, 0) AS user_voted,
      COALESCE(wk.wcnt, 0)  AS week_count,
      COALESCE(pw.pcnt, 0)  AS prev_week_count
    FROM skill_library_entries e
    LEFT JOIN users u ON u.id = e.author_user_id
    LEFT JOIN (
      SELECT skill_name, COUNT(*) AS cnt, COUNT(DISTINCT user_id) AS ucnt
      FROM cowork_skill_invocations
      GROUP BY skill_name
    ) inv ON inv.skill_name = e.name
    LEFT JOIN (
      SELECT entry_id, COUNT(*) AS vcnt FROM skill_library_votes GROUP BY entry_id
    ) v ON v.entry_id = e.id
    LEFT JOIN (
      SELECT entry_id, 1 AS voted FROM skill_library_votes WHERE voter_user_id = ${userId}
    ) mv ON mv.entry_id = e.id
    LEFT JOIN (
      SELECT skill_name, COUNT(*) AS wcnt
      FROM cowork_skill_invocations
      WHERE occurred_at >= ${weekAgo}
      GROUP BY skill_name
    ) wk ON wk.skill_name = e.name
    LEFT JOIN (
      SELECT skill_name, COUNT(*) AS pcnt
      FROM cowork_skill_invocations
      WHERE occurred_at >= ${twoWeeksAgo} AND occurred_at < ${weekAgo}
      GROUP BY skill_name
    ) pw ON pw.skill_name = e.name
    ${whereSql}
    ORDER BY ${sql.raw(orderBy)}
    LIMIT ${perPage} OFFSET ${(page - 1) * perPage}
  `);
  // Number() coercion: the six join-derived aggregates, plus the entries
  // table's own bigint (pg) created_at/updated_at columns (raw execute()
  // bypasses the query builder's schema-aware bigint decode).
  const rows: LibraryEntry[] = rowsRaw.map(r => ({
    ...r,
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
    invocation_count: Number(r.invocation_count),
    user_count: Number(r.user_count),
    vote_count: Number(r.vote_count),
    user_voted: Number(r.user_voted),
    week_count: Number(r.week_count),
    prev_week_count: Number(r.prev_week_count),
  }));

  const countRows = await rawAll<{ total: number | string }>(client, sql`
    SELECT COUNT(*) AS total FROM skill_library_entries e ${whereSql}
  `);
  const total = Number(countRows[0]?.total ?? 0);

  const e = schema.skillLibraryEntries;
  const csi = schema.coworkSkillInvocations;
  const cmi = schema.coworkMcpInvocations;

  const unclaimedRows = await client
    .select({ cnt: sql<number | string>`COUNT(*)` })
    .from(e)
    .where(and(eq(e.is_published, 0), eq(e.source, 'org')));
  const unclaimedCount = Number(unclaimedRows[0]?.cnt ?? 0);

  // Same department-visibility gate as the main listing above, so the
  // headline stats/capability aggregates can never inflate past what the
  // caller can actually see (a department-restricted entry the caller
  // cannot view/claim must not count toward these totals either).
  const visibilityWhere = seesEverything
    ? undefined
    : callerDepts.length
      ? or(eq(e.is_published, 0), isNull(e.department), ...callerDepts.map(d => eq(e.department, d)))
      : or(eq(e.is_published, 0), isNull(e.department));

  const statsRows = await client
    .select({
      skill_count: sql<number | string | null>`SUM(CASE WHEN ${e.type} = 'skill' THEN 1 ELSE 0 END)`,
      connector_count: sql<number | string | null>`SUM(CASE WHEN ${e.type} = 'connector' THEN 1 ELSE 0 END)`,
    })
    .from(e)
    .where(visibilityWhere ? and(eq(e.source, 'org'), visibilityWhere) : eq(e.source, 'org'));
  const skillCount = Number(statsRows[0]?.skill_count ?? 0);
  const connectorCount = Number(statsRows[0]?.connector_count ?? 0);

  const capabilityRows = await client
    .select({
      claimed: sql<number | string | null>`SUM(CASE WHEN ${e.is_published} = 1 THEN 1 ELSE 0 END)`,
      total: sql<number | string>`COUNT(*)`,
    })
    .from(e)
    .where(visibilityWhere ? and(eq(e.source, 'org'), visibilityWhere) : eq(e.source, 'org'));
  const capabilityClaimed = Number(capabilityRows[0]?.claimed ?? 0);
  const capabilityTotal = Number(capabilityRows[0]?.total ?? 0);

  const weekInvRows = await client
    .select({ cnt: sql<number | string>`COUNT(*)` })
    .from(csi)
    .where(gte(csi.occurred_at, weekAgo));
  const weekInvCount = Number(weekInvRows[0]?.cnt ?? 0);

  const newThisWeekRows = await client
    .select({ cnt: sql<number | string>`COUNT(*)` })
    .from(e)
    .where(
      visibilityWhere
        ? and(gte(e.created_at, weekAgo), eq(e.source, 'org'), visibilityWhere)
        : and(gte(e.created_at, weekAgo), eq(e.source, 'org')),
    );
  const newThisWeekCount = Number(newThisWeekRows[0]?.cnt ?? 0);

  const leaderboardRaw = await rawAll<{
    user_id: string; display_name: string | null;
    skill_count: number | string; connector_count: number | string; total_count: number | string;
  }>(client, sql`
    SELECT
      u.id AS user_id,
      u.display_name,
      COALESCE(s.skill_count, 0)     AS skill_count,
      COALESCE(c.connector_count, 0) AS connector_count,
      COALESCE(s.skill_count, 0) + COALESCE(c.connector_count, 0) AS total_count
    FROM users u
    LEFT JOIN (SELECT user_id, COUNT(*) AS skill_count FROM cowork_skill_invocations GROUP BY user_id) s ON s.user_id = u.id
    LEFT JOIN (SELECT user_id, COUNT(*) AS connector_count FROM cowork_mcp_invocations WHERE mcp_server NOT IN ('workspace', 'cowork', 'Claude_in_Chrome') GROUP BY user_id) c ON c.user_id = u.id
    WHERE COALESCE(s.skill_count, 0) + COALESCE(c.connector_count, 0) > 0
    ORDER BY total_count DESC
    LIMIT 5
  `);
  const leaderboard = leaderboardRaw.map(r => ({
    user_id: r.user_id,
    display_name: r.display_name,
    skill_count: Number(r.skill_count),
    connector_count: Number(r.connector_count),
    total_count: Number(r.total_count),
  }));

  // Top 3 skills and connectors per leaderboard user (for hover cards)
  const leaderboardIds = leaderboard.map(x => x.user_id);
  const topSkillRowsRaw = leaderboardIds.length
    ? await client
        .select({ user_id: csi.user_id, skill_name: csi.skill_name, cnt: sql<number | string>`COUNT(*)` })
        .from(csi)
        .where(inArray(csi.user_id, leaderboardIds))
        .groupBy(csi.user_id, csi.skill_name)
        .orderBy(csi.user_id, desc(sql`COUNT(*)`))
    : [];
  const topSkillRows = topSkillRowsRaw.map(r => ({ ...r, cnt: Number(r.cnt) }));

  const topConnectorRowsRaw = leaderboardIds.length
    ? await client
        .select({ user_id: cmi.user_id, mcp_server: cmi.mcp_server, cnt: sql<number | string>`COUNT(*)` })
        .from(cmi)
        .where(and(inArray(cmi.user_id, leaderboardIds), notInArray(cmi.mcp_server, EXCLUDED_MCP_SERVERS)))
        .groupBy(cmi.user_id, cmi.mcp_server)
        .orderBy(cmi.user_id, desc(sql`COUNT(*)`))
    : [];
  const topConnectorRows = topConnectorRowsRaw.map(r => ({ ...r, cnt: Number(r.cnt) }));

  // Group into maps: userId → top 3
  const topSkillsByUser = new Map<string, string[]>();
  for (const r of topSkillRows) {
    const list = topSkillsByUser.get(r.user_id) ?? [];
    if (list.length < 3) { list.push(r.skill_name); topSkillsByUser.set(r.user_id, list); }
  }
  const topConnectorsByUser = new Map<string, string[]>();
  for (const r of topConnectorRows) {
    const list = topConnectorsByUser.get(r.user_id) ?? [];
    if (list.length < 3) { list.push(r.mcp_server); topConnectorsByUser.set(r.user_id, list); }
  }

  const leaderboardWithDetails = leaderboard.map(x => ({
    ...x,
    top_skills: topSkillsByUser.get(x.user_id) ?? [],
    top_connectors: topConnectorsByUser.get(x.user_id) ?? [],
  }));

  // Current user's rank (even if outside top 5) — window function, kept raw.
  const userRankRaw = userId ? await rawAll<{
    rank: number | string; total_count: number | string; skill_count: number | string; connector_count: number | string;
  }>(client, sql`
    SELECT ranked.rank, ranked.total_count, ranked.skill_count, ranked.connector_count
    FROM (
      SELECT
        u.id AS user_id,
        COALESCE(s.skill_count, 0)     AS skill_count,
        COALESCE(c.connector_count, 0) AS connector_count,
        COALESCE(s.skill_count, 0) + COALESCE(c.connector_count, 0) AS total_count,
        ROW_NUMBER() OVER (ORDER BY COALESCE(s.skill_count, 0) + COALESCE(c.connector_count, 0) DESC) AS rank
      FROM users u
      LEFT JOIN (SELECT user_id, COUNT(*) AS skill_count FROM cowork_skill_invocations GROUP BY user_id) s ON s.user_id = u.id
      LEFT JOIN (SELECT user_id, COUNT(*) AS connector_count FROM cowork_mcp_invocations WHERE mcp_server NOT IN ('workspace', 'cowork', 'Claude_in_Chrome') GROUP BY user_id) c ON c.user_id = u.id
      WHERE COALESCE(s.skill_count, 0) + COALESCE(c.connector_count, 0) > 0
    ) ranked
    WHERE ranked.user_id = ${userId}
  `) : [];
  const userRankRow = userRankRaw[0]
    ? {
        rank: Number(userRankRaw[0].rank),
        total_count: Number(userRankRaw[0].total_count),
        skill_count: Number(userRankRaw[0].skill_count),
        connector_count: Number(userRankRaw[0].connector_count),
      }
    : null;

  // Skills the org uses that the current user hasn't tried. Department
  // visibility here uses the same callerDepts union (deptOr, built above)
  // as the main listing/detail routes — an entry restricted to either
  // session.department or the users-table department is visible.
  const skillsToTryRaw = userId ? await rawAll<{
    id: number; name: string; type: string; description: string | null; install_guide: string | null;
    invocation_count: number | string; user_count: number | string;
  }>(client, sql`
    SELECT e.id, e.name, e.type, e.description, e.install_guide, COALESCE(inv.cnt, 0) AS invocation_count, COALESCE(inv.ucnt, 0) AS user_count
    FROM skill_library_entries e
    JOIN (
      SELECT skill_name, COUNT(*) AS cnt, COUNT(DISTINCT user_id) AS ucnt
      FROM cowork_skill_invocations
      GROUP BY skill_name
    ) inv ON inv.skill_name = e.name
    WHERE e.is_published = 1 AND e.source = 'org'
    AND (e.department IS NULL OR ${deptOr})
    AND e.name NOT IN (
      SELECT DISTINCT skill_name FROM cowork_skill_invocations WHERE user_id = ${userId}
    )
    ORDER BY invocation_count DESC
    LIMIT 5
  `) : [];
  const skillsToTry = skillsToTryRaw.map(r => ({ ...r, invocation_count: Number(r.invocation_count), user_count: Number(r.user_count) }));

  // userDept was already computed above (needed by the visibility filter).

  // Postgres requires every non-aggregated SELECT column in GROUP BY. `name` is UNIQUE, so grouping by the full set
  // of entry columns below changes nothing about the result.
  const deptPicksRaw = userDept ? await rawAll<{
    id: number; name: string; type: string; description: string | null; install_guide: string | null;
    invocation_count: number | string; user_count: number | string;
  }>(client, sql`
    SELECT e.id, e.name, e.type, e.description, e.install_guide,
           COUNT(csi.id)               AS invocation_count,
           COUNT(DISTINCT csi.user_id) AS user_count
    FROM skill_library_entries e
    JOIN cowork_skill_invocations csi ON csi.skill_name = e.name
    JOIN users u ON u.id = csi.user_id
    WHERE e.is_published = 1 AND u.department = ${userDept} AND (e.department IS NULL OR e.department = ${userDept})
    GROUP BY e.id, e.name, e.type, e.description, e.install_guide
    ORDER BY invocation_count DESC
    LIMIT 6
  `) : [];
  const deptPicks = deptPicksRaw.map(r => ({ ...r, invocation_count: Number(r.invocation_count), user_count: Number(r.user_count) }));

  // Recently claimed/published this week
  const recentEntriesRaw = await rawAll<{
    id: number; name: string; type: string; description: string | null; install_guide: string | null;
    author_name: string | null; updated_at: number | string;
  }>(client, sql`
    SELECT e.id, e.name, e.type, e.description, e.install_guide, u.display_name AS author_name, e.updated_at
    FROM skill_library_entries e
    LEFT JOIN users u ON u.id = e.author_user_id
    WHERE e.is_published = 1 AND e.source = 'org' AND e.updated_at >= ${weekAgo}
    ORDER BY e.updated_at DESC
    LIMIT 6
  `);
  const recentEntries = recentEntriesRaw.map(r => ({ ...r, updated_at: Number(r.updated_at) }));

  // Department activity breakdown — pre-aggregate per user to avoid cross-join
  // inflation. Postgres does not allow a SELECT-list alias in HAVING (only
  // ORDER BY/GROUP BY), so the aggregate expression is repeated verbatim.
  const deptBreakdownRaw = await rawAll<{
    department: string; user_count: number | string; skill_uses: number | string;
    connector_uses: number | string; total_uses: number | string;
  }>(client, sql`
    SELECT
      u.department,
      COUNT(DISTINCT u.id)           AS user_count,
      COALESCE(SUM(s.skill_count), 0)     AS skill_uses,
      COALESCE(SUM(c.connector_count), 0) AS connector_uses,
      COALESCE(SUM(s.skill_count), 0) + COALESCE(SUM(c.connector_count), 0) AS total_uses
    FROM users u
    LEFT JOIN (
      SELECT user_id, COUNT(*) AS skill_count
      FROM cowork_skill_invocations
      GROUP BY user_id
    ) s ON s.user_id = u.id
    LEFT JOIN (
      SELECT user_id, COUNT(*) AS connector_count
      FROM cowork_mcp_invocations
      WHERE mcp_server NOT IN ('workspace', 'cowork', 'Claude_in_Chrome')
      GROUP BY user_id
    ) c ON c.user_id = u.id
    WHERE u.department IS NOT NULL AND u.department != ''
    GROUP BY u.department
    HAVING COALESCE(SUM(s.skill_count), 0) + COALESCE(SUM(c.connector_count), 0) > 0
    ORDER BY total_uses DESC
    LIMIT 6
  `);
  const deptBreakdown = deptBreakdownRaw.map(r => ({
    department: r.department,
    user_count: Number(r.user_count),
    skill_uses: Number(r.skill_uses),
    connector_uses: Number(r.connector_uses),
    total_uses: Number(r.total_uses),
  }));

  const readWriteCounts = await getConnectorReadWriteCounts();

  const entries = rows.map(r => {
    const rw = r.type === 'connector' ? readWriteCounts.get(r.name) : undefined;
    const weekCountNum = Number(r.week_count);
    const prevWeekCountNum = Number(r.prev_week_count);
    return {
      ...r,
      trend_pct: prevWeekCountNum > 0
        ? Math.round(((weekCountNum - prevWeekCountNum) / prevWeekCountNum) * 100)
        : weekCountNum > 0 ? 100 : 0,
      ...(rw ? { reads: rw.reads, writes: rw.writes } : {}),
    };
  });

  return NextResponse.json({
    entries,
    total,
    unclaimed_count: unclaimedCount,
    stats: {
      skill_count:           skillCount,
      connector_count:       connectorCount,
      invocations_this_week: weekInvCount,
      new_this_week:         newThisWeekCount,
    },
    capability: {
      claimed: capabilityClaimed,
      total:   capabilityTotal,
    },
    leaderboard: leaderboardWithDetails,
    user_rank: userRankRow,
    recent_entries: recentEntries,
    dept_breakdown: deptBreakdown,
    user_dept:  userDept,
    dept_picks: deptPicks,
    skills_to_try: skillsToTry,
  });
}

export async function POST(req: NextRequest) {
  const session = await getAdminSession(req);
  if (!session.authenticated) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body?.name) return NextResponse.json({ error: 'name is required' }, { status: 400 });
  if (!['skill', 'connector'].includes(body.type ?? 'skill')) {
    return NextResponse.json({ error: 'type must be skill or connector' }, { status: 400 });
  }
  const sourceUrl = normaliseSourceUrl(body.source_url);
  if (sourceUrl === undefined) return NextResponse.json({ error: SOURCE_URL_ERROR }, { status: 400 });

  const client = await getTypedClient();
  const e = schema.skillLibraryEntries;
  const now = Math.floor(Date.now() / 1000);

  // The caller's person record, not their sign-in id: the two differ for
  // admin-created and linked accounts, where the sign-in id would leave no
  // author recorded.
  const authorId = await callerPersonId(session);

  const existingEntryRows = await client
    .select({ id: e.id, is_published: e.is_published })
    .from(e)
    .where(eq(e.name, body.name));
  const existing = existingEntryRows[0];

  if (existing) {
    if (existing.is_published === 1) {
      return NextResponse.json({ error: 'An entry for this skill already exists' }, { status: 409 });
    }

    // .returning() (not a separate SELECT / lastInsertRowid) so the updated
    // record is read straight off the write.
    const updatedRows = await client
      .update(e)
      .set({
        description: body.description ?? null,
        author_user_id: authorId,
        is_published: 1,
        install_guide: body.install_guide ?? null,
        source_url: sourceUrl,
        updated_at: now,
      })
      .where(eq(e.id, existing.id))
      .returning();

    return NextResponse.json(updatedRows[0]);
  }

  // .returning() for the new id.
  const insertedRows = await client
    .insert(e)
    .values({
      name: body.name,
      type: body.type ?? 'skill',
      surface: body.surface ?? 'cowork',
      description: body.description ?? null,
      author_user_id: authorId,
      is_published: 1,
      install_guide: body.install_guide ?? null,
      source_url: sourceUrl,
      created_at: now,
      updated_at: now,
    })
    .returning();

  return NextResponse.json(insertedRows[0], { status: 201 });
}
