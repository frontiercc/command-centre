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
import { entryProducts } from '@/lib/library/products';
import { boardUses, hideOpenAiOnlyEntries } from '@/lib/library/visible-uses';
import { NextRequest, NextResponse } from 'next/server';
import { normaliseSourceUrl, SOURCE_URL_ERROR } from '@/lib/library/source-url';
import { callerPersonId } from '@/lib/library/author';
import { and, desc, eq, gte, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { canAccessOrgOverview, getAdminSession } from '@/lib/auth/admin-auth';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { alias } from 'drizzle-orm/pg-core';
import { getConnectorReadWriteCounts } from '@/lib/pulse/mcp-classify';
import { notBoardHiddenConnector, entryNotBoardHidden } from '@/lib/library/built-in-connectors';

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
  week_user_count: number | string;
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
  // Stage 1: who the caller is, and which uses the Board counts. Neither
  // depends on the other, so both are looked up at the same time.
  // The caller's person record (users.id), not their sign-in id: the two
  // differ for admin-created and linked accounts, whose uses, standing,
  // skills to try and department picks are recorded against the person.
  const [callerPerson, uses] = await Promise.all([callerPersonId(session), boardUses()]);
  const personId = callerPerson ?? '';
  // Votes are written with the sign-in id (the vote route); older ones may
  // carry the person id, so either counts as the caller's own vote.
  const voterIds = [...new Set([userId, personId].filter(Boolean))];

  // Stage 2: the caller's department, which needs the person id above and
  // which the visibility filter below needs.
  const u0 = schema.users;
  const userDeptRows0 = personId
    ? await client.select({ department: u0.department }).from(u0).where(eq(u0.id, personId))
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

  // ChatGPT and Codex hidden (the OpenAI panel): the Board counts Claude's uses
  // only (`uses`, looked up in stage 1).
  // Entries used only in ChatGPT or Codex, left out of the listing and every
  // count below while those are hidden, so the counts always match the list.
  const openAiScope = uses.shown ? undefined : hideOpenAiOnlyEntries();
  const conditions: SQL[] = [];
  if (openAiScope) conditions.push(openAiScope);
  // Claude's own connectors and skills are never listed or counted (lib/library/built-in-connectors.ts).
  conditions.push(entryNotBoardHidden(sql.raw('e.type'), sql.raw('e.name')));
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

  // Skill uses and connector uses as one set, tagged by kind, so a connector
  // counts its connector uses and a skill its skill uses, and a skill and a
  // connector that share a name never mix. Connector uses leave out the same
  // built-in servers as everywhere else on the Board.
  const allUses = sql`(
    SELECT 'skill' AS kind, skill_name AS name, user_id, occurred_at FROM ${uses.skills}
    UNION ALL
    SELECT 'connector' AS kind, mcp_server AS name, user_id, occurred_at FROM ${uses.connectors}
    WHERE ${notBoardHiddenConnector(sql.raw('mcp_server'))}
  ) AS board_uses`;
  const entryKind = sql`(CASE WHEN e.type = 'connector' THEN 'connector' ELSE 'skill' END)`;

  // Aliased `e`, so the raw hideOpenAiOnlyEntries() condition (written against
  // `e`) applies to these query-builder reads too.
  const e = alias(schema.skillLibraryEntries, 'e');
  const csi = schema.coworkSkillInvocations;
  const cmi = schema.coworkMcpInvocations;
  const notHidden = entryNotBoardHidden(sql`${e.type}`, sql`${e.name}`);

  // Same department-visibility gate as the main listing above, so the
  // headline stats/capability aggregates can never inflate past what the
  // caller can actually see (a department-restricted entry the caller
  // cannot view/claim must not count toward these totals either).
  const visibilityWhere = seesEverything
    ? undefined
    : callerDepts.length
      ? or(eq(e.is_published, 0), isNull(e.department), ...callerDepts.map(d => eq(e.department, d)))
      : or(eq(e.is_published, 0), isNull(e.department));

  // Stage 3: every read below depends only on the caller and filters worked
  // out above, not on each other, so they all run at the same time.
  const [
    rowsRaw,
    countRows,
    unclaimedRows,
    unclaimedInUseRows,
    statsRows,
    weekInvRows,
    newThisWeekRows,
    leaderboardRaw,
    userRankRaw,
    skillsToTryRaw,
    deptPicksRaw,
    recentEntriesRaw,
    deptBreakdownRaw,
    readWriteCounts,
  ] = await Promise.all([
    rawAll<LibraryEntry>(client, sql`
    SELECT
      e.*,
      u.display_name   AS author_name,
      COALESCE(inv.cnt, 0)  AS invocation_count,
      COALESCE(inv.ucnt, 0) AS user_count,
      COALESCE(v.vcnt, 0)   AS vote_count,
      COALESCE(mv.voted, 0) AS user_voted,
      COALESCE(wk.wcnt, 0)  AS week_count,
      COALESCE(wk.wucnt, 0) AS week_user_count,
      COALESCE(pw.pcnt, 0)  AS prev_week_count
    FROM skill_library_entries e
    LEFT JOIN users u ON u.id = e.author_user_id
    LEFT JOIN (
      SELECT kind, name, COUNT(*) AS cnt, COUNT(DISTINCT user_id) AS ucnt
      FROM ${allUses}
      GROUP BY kind, name
    ) inv ON inv.name = e.name AND inv.kind = ${entryKind}
    LEFT JOIN (
      SELECT entry_id, COUNT(*) AS vcnt FROM skill_library_votes GROUP BY entry_id
    ) v ON v.entry_id = e.id
    LEFT JOIN (
      SELECT DISTINCT entry_id, 1 AS voted FROM skill_library_votes
      WHERE ${voterIds.length ? sql`voter_user_id IN (${sql.join(voterIds.map(id => sql`${id}`), sql`, `)})` : sql`false`}
    ) mv ON mv.entry_id = e.id
    LEFT JOIN (
      SELECT kind, name, COUNT(*) AS wcnt, COUNT(DISTINCT user_id) AS wucnt
      FROM ${allUses}
      WHERE occurred_at >= ${weekAgo}
      GROUP BY kind, name
    ) wk ON wk.name = e.name AND wk.kind = ${entryKind}
    LEFT JOIN (
      SELECT kind, name, COUNT(*) AS pcnt
      FROM ${allUses}
      WHERE occurred_at >= ${twoWeeksAgo} AND occurred_at < ${weekAgo}
      GROUP BY kind, name
    ) pw ON pw.name = e.name AND pw.kind = ${entryKind}
    ${whereSql}
    ORDER BY ${sql.raw(orderBy)}
    LIMIT ${perPage} OFFSET ${(page - 1) * perPage}
  `),

    rawAll<{ total: number | string }>(client, sql`
    SELECT COUNT(*) AS total FROM skill_library_entries e ${whereSql}
  `),

    client
      .select({ cnt: sql<number | string>`COUNT(*)` })
      .from(e)
      .where(and(eq(e.is_published, 0), eq(e.source, 'org'), notHidden, openAiScope)),

    // The banner's count: unclaimed entries someone has actually used.
    rawAll<{ cnt: number | string }>(client, sql`
    SELECT COUNT(*) AS cnt FROM skill_library_entries e
    WHERE e.is_published = 0 AND e.source = 'org' AND ${entryNotBoardHidden(sql.raw('e.type'), sql.raw('e.name'))}
    ${openAiScope ? sql`AND ${openAiScope}` : sql``}
    AND EXISTS (SELECT 1 FROM ${allUses} WHERE board_uses.name = e.name AND board_uses.kind = ${entryKind})
  `),

    // The headline stats and the capability figures read the same entries
    // under the same filter, so one read returns both.
    client
      .select({
        skill_count: sql<number | string | null>`SUM(CASE WHEN ${e.type} = 'skill' THEN 1 ELSE 0 END)`,
        connector_count: sql<number | string | null>`SUM(CASE WHEN ${e.type} = 'connector' THEN 1 ELSE 0 END)`,
        claimed: sql<number | string | null>`SUM(CASE WHEN ${e.is_published} = 1 THEN 1 ELSE 0 END)`,
        total: sql<number | string>`COUNT(*)`,
      })
      .from(e)
      .where(and(eq(e.source, 'org'), notHidden, openAiScope, visibilityWhere)),

    client
      .select({ cnt: sql<number | string>`COUNT(*)` })
      .from(csi)
      .where(and(gte(csi.occurred_at, weekAgo), uses.claudeOnly)),

    client
      .select({ cnt: sql<number | string>`COUNT(*)` })
      .from(e)
      .where(and(gte(e.created_at, weekAgo), eq(e.source, 'org'), notHidden, openAiScope, visibilityWhere)),

    rawAll<{
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
    LEFT JOIN (SELECT user_id, COUNT(*) AS skill_count FROM ${uses.skills} GROUP BY user_id) s ON s.user_id = u.id
    LEFT JOIN (SELECT user_id, COUNT(*) AS connector_count FROM ${uses.connectors} WHERE ${notBoardHiddenConnector(sql.raw('mcp_server'))} GROUP BY user_id) c ON c.user_id = u.id
    WHERE COALESCE(s.skill_count, 0) + COALESCE(c.connector_count, 0) > 0
    ORDER BY total_count DESC
    LIMIT 5
  `),

    // Current user's rank (even if outside top 5) — window function, kept raw.
    personId ? rawAll<{
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
      LEFT JOIN (SELECT user_id, COUNT(*) AS skill_count FROM ${uses.skills} GROUP BY user_id) s ON s.user_id = u.id
      LEFT JOIN (SELECT user_id, COUNT(*) AS connector_count FROM ${uses.connectors} WHERE ${notBoardHiddenConnector(sql.raw('mcp_server'))} GROUP BY user_id) c ON c.user_id = u.id
      WHERE COALESCE(s.skill_count, 0) + COALESCE(c.connector_count, 0) > 0
    ) ranked
    WHERE ranked.user_id = ${personId}
  `) : Promise.resolve([]),

    // Skills the org uses that the current user hasn't tried. Department
    // visibility here uses the same callerDepts union (deptOr, built above)
    // as the main listing/detail routes — an entry restricted to either
    // session.department or the users-table department is visible.
    personId ? rawAll<{
    id: number; name: string; type: string; description: string | null; install_guide: string | null;
    invocation_count: number | string; user_count: number | string;
  }>(client, sql`
    SELECT e.id, e.name, e.type, e.description, e.install_guide, COALESCE(inv.cnt, 0) AS invocation_count, COALESCE(inv.ucnt, 0) AS user_count
    FROM skill_library_entries e
    JOIN (
      SELECT skill_name, COUNT(*) AS cnt, COUNT(DISTINCT user_id) AS ucnt
      FROM ${uses.skills}
      GROUP BY skill_name
    ) inv ON inv.skill_name = e.name
    WHERE e.is_published = 1 AND e.source = 'org'
    AND ${entryNotBoardHidden(sql.raw('e.type'), sql.raw('e.name'))}
    AND (e.department IS NULL OR ${deptOr})
    AND e.name NOT IN (
      SELECT DISTINCT skill_name FROM ${uses.skills} WHERE user_id = ${personId}
    )
    ORDER BY invocation_count DESC
    LIMIT 5
  `) : Promise.resolve([]),

    // userDept was already computed above (needed by the visibility filter).
    // Postgres requires every non-aggregated SELECT column in GROUP BY. `name` is UNIQUE, so grouping by the full set
    // of entry columns below changes nothing about the result.
    userDept ? rawAll<{
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
    AND ${entryNotBoardHidden(sql.raw('e.type'), sql.raw('e.name'))}
    GROUP BY e.id, e.name, e.type, e.description, e.install_guide
    ORDER BY invocation_count DESC
    LIMIT 6
  `) : Promise.resolve([]),

    // Recently claimed/published this week
    rawAll<{
    id: number; name: string; type: string; description: string | null; install_guide: string | null;
    author_name: string | null; updated_at: number | string;
  }>(client, sql`
    SELECT e.id, e.name, e.type, e.description, e.install_guide, u.display_name AS author_name, e.updated_at
    FROM skill_library_entries e
    LEFT JOIN users u ON u.id = e.author_user_id
    WHERE e.is_published = 1 AND e.source = 'org' AND e.updated_at >= ${weekAgo}
    AND ${entryNotBoardHidden(sql.raw('e.type'), sql.raw('e.name'))}
    ORDER BY e.updated_at DESC
    LIMIT 6
  `),

    // Department activity breakdown — pre-aggregate per user to avoid cross-join
    // inflation. Postgres does not allow a SELECT-list alias in HAVING (only
    // ORDER BY/GROUP BY), so the aggregate expression is repeated verbatim.
    // Every department with a use is listed, and its people are those with at
    // least one use, not its headcount.
    rawAll<{
    department: string; user_count: number | string; skill_uses: number | string;
    connector_uses: number | string; total_uses: number | string;
  }>(client, sql`
    SELECT
      u.department,
      COUNT(DISTINCT u.id) FILTER (WHERE COALESCE(s.skill_count, 0) + COALESCE(c.connector_count, 0) > 0) AS user_count,
      COALESCE(SUM(s.skill_count), 0)     AS skill_uses,
      COALESCE(SUM(c.connector_count), 0) AS connector_uses,
      COALESCE(SUM(s.skill_count), 0) + COALESCE(SUM(c.connector_count), 0) AS total_uses
    FROM users u
    LEFT JOIN (
      SELECT user_id, COUNT(*) AS skill_count
      FROM ${uses.skills}
      GROUP BY user_id
    ) s ON s.user_id = u.id
    LEFT JOIN (
      SELECT user_id, COUNT(*) AS connector_count
      FROM ${uses.connectors}
      WHERE ${notBoardHiddenConnector(sql.raw('mcp_server'))}
      GROUP BY user_id
    ) c ON c.user_id = u.id
    WHERE u.department IS NOT NULL AND u.department != ''
    GROUP BY u.department
    HAVING COALESCE(SUM(s.skill_count), 0) + COALESCE(SUM(c.connector_count), 0) > 0
    ORDER BY total_uses DESC
  `),

    getConnectorReadWriteCounts(),
  ]);

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
    week_user_count: Number(r.week_user_count),
    prev_week_count: Number(r.prev_week_count),
  }));

  const total = Number(countRows[0]?.total ?? 0);
  const unclaimedCount = Number(unclaimedRows[0]?.cnt ?? 0);
  const unclaimedInUseCount = Number(unclaimedInUseRows[0]?.cnt ?? 0);
  const skillCount = Number(statsRows[0]?.skill_count ?? 0);
  const connectorCount = Number(statsRows[0]?.connector_count ?? 0);
  const capabilityClaimed = Number(statsRows[0]?.claimed ?? 0);
  const capabilityTotal = Number(statsRows[0]?.total ?? 0);
  const weekInvCount = Number(weekInvRows[0]?.cnt ?? 0);
  const newThisWeekCount = Number(newThisWeekRows[0]?.cnt ?? 0);

  const leaderboard = leaderboardRaw.map(r => ({
    user_id: r.user_id,
    display_name: r.display_name,
    skill_count: Number(r.skill_count),
    connector_count: Number(r.connector_count),
    total_count: Number(r.total_count),
  }));

  // Stage 4: reads that need stage 3's answers. Each leaderboard person's top
  // skills and connectors (for the hover cards) need the leaderboard, and each
  // listed entry's product tags need the listing; the three run together.
  const leaderboardIds = leaderboard.map(x => x.user_id);
  const [topSkillRowsRaw, topConnectorRowsRaw, products] = await Promise.all([
    leaderboardIds.length
      ? client
          .select({ user_id: csi.user_id, skill_name: csi.skill_name, cnt: sql<number | string>`COUNT(*)` })
          .from(csi)
          .where(and(inArray(csi.user_id, leaderboardIds), uses.claudeOnly))
          .groupBy(csi.user_id, csi.skill_name)
          .orderBy(csi.user_id, desc(sql`COUNT(*)`))
      : Promise.resolve([]),
    leaderboardIds.length
      ? client
          .select({ user_id: cmi.user_id, mcp_server: cmi.mcp_server, cnt: sql<number | string>`COUNT(*)` })
          .from(cmi)
          .where(and(inArray(cmi.user_id, leaderboardIds), notBoardHiddenConnector(sql`${cmi.mcp_server}`), uses.claudeOnly))
          .groupBy(cmi.user_id, cmi.mcp_server)
          .orderBy(cmi.user_id, desc(sql`COUNT(*)`))
      : Promise.resolve([]),
    // Which products each entry is used in (Claude, ChatGPT, Codex), for its tags.
    entryProducts(rows, uses.shown),
  ]);
  const topSkillRows = topSkillRowsRaw.map(r => ({ ...r, cnt: Number(r.cnt) }));
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

  const userRankRow = userRankRaw[0]
    ? {
        rank: Number(userRankRaw[0].rank),
        total_count: Number(userRankRaw[0].total_count),
        skill_count: Number(userRankRaw[0].skill_count),
        connector_count: Number(userRankRaw[0].connector_count),
      }
    : null;

  const skillsToTry = skillsToTryRaw.map(r => ({ ...r, invocation_count: Number(r.invocation_count), user_count: Number(r.user_count) }));
  const deptPicks = deptPicksRaw.map(r => ({ ...r, invocation_count: Number(r.invocation_count), user_count: Number(r.user_count) }));
  const recentEntries = recentEntriesRaw.map(r => ({ ...r, updated_at: Number(r.updated_at) }));
  const deptBreakdown = deptBreakdownRaw.map(r => ({
    department: r.department,
    user_count: Number(r.user_count),
    skill_uses: Number(r.skill_uses),
    connector_uses: Number(r.connector_uses),
    total_uses: Number(r.total_uses),
  }));

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
      products: products.get(r.name) ?? [],
    };
  });

  return NextResponse.json({
    entries,
    total,
    unclaimed_count: unclaimedCount,
    unclaimed_in_use_count: unclaimedInUseCount,
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
