// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. Follows the
// standard pattern: getTypedClient() + schema.<table> for
// straightforward selects/aggregates (bigint columns like created_at/
// updated_at get decoded to `number` automatically via the query builder's
// schema-aware codec), and a local rawAll() facade (mirrors lib/db/queries.ts
// + app/api/pulse/cio/route.ts) ONLY for the one date-bucket GROUP BY
// (day bucketing via to_char(to_timestamp(...) AT TIME ZONE 'UTC')).
// Every raw-SQL COUNT/AVG aggregate is
// Number()-coerced (bigint/numeric come back as STRINGS on
// Postgres).
//
// NOTE: the GET handler spreads `...entry` (all columns, including
// author_user_id) into the response alongside the server-computed
// `is_author` flag.
import { NextRequest, NextResponse } from 'next/server';
import { normaliseSourceUrl, SOURCE_URL_ERROR } from '@/lib/library/source-url';
import { isEntryAuthor } from '@/lib/library/author';
import { and, desc, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import { canAccessOrgOverview, canAccessPulseAdmin, getAdminSession } from '@/lib/auth/admin-auth';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getAllConfig } from '@/lib/config';
import { findWorkflowsUsingSignal } from '@/lib/usecases/impact';
import { deleteLibraryEntry } from '@/lib/library/delete-entry';
import { logAccess } from '@/lib/audit/log';

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

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getAdminSession(req);
  if (!session.authenticated) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id: idStr } = await params;
  const client = await getTypedClient();
  const id = parseInt(idStr, 10);
  const userId = session.userId ?? '';
  const now = Math.floor(Date.now() / 1000);
  const weekAgo = now - 7 * 86400;

  const e = schema.skillLibraryEntries;
  const u = schema.users;
  const csi = schema.coworkSkillInvocations;
  const cmi = schema.coworkMcpInvocations;

  const entryRows = await client
    .select({
      id: e.id,
      name: e.name,
      type: e.type,
      surface: e.surface,
      description: e.description,
      author_user_id: e.author_user_id,
      is_published: e.is_published,
      install_guide: e.install_guide,
      source_url: e.source_url,
      department: e.department,
      created_at: e.created_at,
      updated_at: e.updated_at,
      source: e.source,
      author_name: u.display_name,
    })
    .from(e)
    .leftJoin(u, eq(u.id, e.author_user_id))
    .where(eq(e.id, id));
  const entry = entryRows[0];

  if (!entry) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Department visibility: an unclaimed entry always stays visible; a
  // claimed entry is visible if org-wide (null), matches the caller's own
  // department, or the caller has an org-overview role. Anything else 404s
  // — indistinguishable from "doesn't exist", not a 403.
  const seesEverything = canAccessOrgOverview(session.role);
  // "The caller's department" is the union of
  // session.department (admin_users) and the users-table department for
  // this userId — matches the browse route's callerDepts (an entry
  // restricted to either one is visible to that caller).
  const usersDeptRows = userId
    ? await client.select({ department: u.department }).from(u).where(eq(u.id, userId))
    : [];
  const usersTableDept = usersDeptRows[0]?.department ?? null;
  // Dedupe: the common case is both sources
  // agreeing, which without this would produce a redundant
  // `callerDepts.includes(...)` check against duplicate identical values.
  const callerDepts = [...new Set([session.department, usersTableDept].filter((d): d is string => Boolean(d)))];
  if (entry.is_published === 1 && entry.department !== null && !callerDepts.includes(entry.department) && !seesEverything) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const name = entry.name;

  // Workflow Impact package: additive, null when Use Cases is off
  // so the "Powers these workflows" card can hide entirely rather than show
  // an always-empty list on instances that never turned the feature on.
  const config = await getAllConfig();
  const usedInWorkflows = config.useCasesEnabled === true
    ? await findWorkflowsUsingSignal(entry.type === 'connector' ? 'connector' : 'skill', name, now)
    : null;

  // Codified skill (Turn this into a skill): the use case whose draft owns this
  // Board row. Additive; null for every ordinary entry. The card uses it to
  // offer the zip download in place of the copy-the-guide Install action.
  const t = schema.useCaseSkillDrafts;
  const codRows = await client
    .select({ use_case_id: t.use_case_id, title: schema.useCases.title })
    .from(t)
    .innerJoin(schema.useCases, eq(schema.useCases.id, t.use_case_id))
    .where(eq(t.library_entry_id, id))
    .limit(1);
  const codified = codRows[0] ? { useCaseId: codRows[0].use_case_id, useCaseTitle: codRows[0].title } : null;

  const voteCountRows = await client
    .select({ cnt: sql<number | string>`COUNT(*)` })
    .from(schema.skillLibraryVotes)
    .where(eq(schema.skillLibraryVotes.entry_id, id));
  const voteCount = Number(voteCountRows[0]?.cnt ?? 0);

  const userVotedRows = await client
    .select({ id: schema.skillLibraryVotes.id })
    .from(schema.skillLibraryVotes)
    .where(and(eq(schema.skillLibraryVotes.entry_id, id), eq(schema.skillLibraryVotes.voter_user_id, userId)));
  const userVoted = userVotedRows.length > 0;

  // Per-day invocation counts for last 7 days (AT TIME ZONE 'UTC'
  // is required since to_char formats in the Postgres SESSION timezone).
  const dayExpr = sql`to_char(to_timestamp(occurred_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
  const dailyRowsRaw = await rawAll<{ day: string; cnt: number | string }>(client, sql`
    SELECT ${dayExpr} AS day, COUNT(*) AS cnt
    FROM cowork_skill_invocations
    WHERE skill_name = ${name} AND occurred_at >= ${weekAgo}
    GROUP BY ${dayExpr}
    ORDER BY day ASC
  `);
  const dailyRows = dailyRowsRaw.map(r => ({ day: r.day, cnt: Number(r.cnt) }));

  // Top users
  const topUsersRaw = await client
    .select({ user_id: csi.user_id, display_name: u.display_name, cnt: sql<number | string>`COUNT(*)` })
    .from(csi)
    .leftJoin(u, eq(u.id, csi.user_id))
    .where(eq(csi.skill_name, name))
    .groupBy(csi.user_id, u.display_name)
    .orderBy(desc(sql`COUNT(*)`))
    .limit(10);
  const topUsers = topUsersRaw.map(r => ({ ...r, cnt: Number(r.cnt) }));

  // Invocation type split
  const typeSplitRaw = await client
    .select({ invocation_type: csi.invocation_type, cnt: sql<number | string>`COUNT(*)` })
    .from(csi)
    .where(and(eq(csi.skill_name, name), isNotNull(csi.invocation_type)))
    .groupBy(csi.invocation_type);
  const typeSplit = typeSplitRaw.map(r => ({ ...r, cnt: Number(r.cnt) }));

  const totalInvocationsRows = await client
    .select({ cnt: sql<number | string>`COUNT(*)` })
    .from(csi)
    .where(eq(csi.skill_name, name));
  const totalInvocations = Number(totalInvocationsRows[0]?.cnt ?? 0);

  const distinctUsersRows = await client
    .select({ cnt: sql<number | string>`COUNT(DISTINCT ${csi.user_id})` })
    .from(csi)
    .where(eq(csi.skill_name, name));
  const distinctUsers = Number(distinctUsersRows[0]?.cnt ?? 0);

  const weekCountRows = await client
    .select({ cnt: sql<number | string>`COUNT(*)` })
    .from(csi)
    .where(and(eq(csi.skill_name, name), gte(csi.occurred_at, weekAgo)));
  const weekCount = Number(weekCountRows[0]?.cnt ?? 0);

  const prevWeekAgo = weekAgo - 7 * 86400;
  const prevWeekCountRows = await client
    .select({ cnt: sql<number | string>`COUNT(*)` })
    .from(csi)
    .where(and(eq(csi.skill_name, name), gte(csi.occurred_at, prevWeekAgo), lt(csi.occurred_at, weekAgo)));
  const prevWeekCount = Number(prevWeekCountRows[0]?.cnt ?? 0);

  const agentChained = typeSplit.find(r => r.invocation_type === 'agent_chained')?.cnt ?? 0;
  const agentPct = totalInvocations > 0 ? Math.round((agentChained / totalInvocations) * 100) : 0;

  // OTel connector reliability — only for connector-type entries (mcp_server match)
  const reliabilityRows = await client
    .select({
      success_rate: sql<number | string | null>`AVG(CASE WHEN ${cmi.success} = 1 THEN 1.0 ELSE 0.0 END)`,
      avg_duration_ms: sql<number | string | null>`AVG(${cmi.duration_ms})`,
      sample_size: sql<number | string>`COUNT(*)`,
    })
    .from(cmi)
    .where(and(eq(cmi.mcp_server, name), eq(cmi.source, 'otel')));
  const reliabilityRow = reliabilityRows[0];
  const sampleSize = Number(reliabilityRow?.sample_size ?? 0);

  const reliability = reliabilityRow && sampleSize > 0
    ? {
        success_rate: reliabilityRow.success_rate !== null
          ? Math.round(Number(reliabilityRow.success_rate) * 1000) / 10 // to 1 dp %
          : null,
        avg_duration_ms: reliabilityRow.avg_duration_ms !== null
          ? Math.round(Number(reliabilityRow.avg_duration_ms))
          : null,
        sample_size: sampleSize,
      }
    : undefined;

  return NextResponse.json({
    ...entry,
    is_author: await isEntryAuthor(session, entry.author_user_id),
    stats: {
      total_invocations: totalInvocations,
      week_count: weekCount,
      prev_week_count: prevWeekCount,
      trend_pct: prevWeekCount > 0
        ? Math.round(((weekCount - prevWeekCount) / prevWeekCount) * 100)
        : weekCount > 0 ? 100 : 0,
      distinct_users: distinctUsers,
      vote_count: voteCount,
      user_voted: userVoted,
      agent_chained_pct: agentPct,
    },
    daily_counts: dailyRows,
    top_users: topUsers,
    usedInWorkflows,
    codified,
    ...(reliability !== undefined ? { reliability } : {}),
  });
}

/**
 * Delete a Board entry: admins and managers only, any
 * entry. A codified skill is also un-codified (rule entry removed, draft reset
 * to not-yet-downloaded) by deleteLibraryEntry. Every outcome is audited.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getAdminSession(req);
  if (!session.authenticated) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id: idStr } = await params;
  const id = parseInt(idStr, 10);
  const audit = (outcome: 'success' | 'denied' | 'failure', detail: string) =>
    logAccess({ actorId: session.userId ?? '', actorEmail: session.email ?? '', resource: 'library', action: 'DELETE', outcome, detail });

  if (!canAccessPulseAdmin(session.role)) {
    await audit('denied', `${idStr}: role ${session.role ?? 'none'}`);
    return NextResponse.json({ error: 'Only an admin or manager can delete a Board entry' }, { status: 403 });
  }
  if (!Number.isInteger(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  try {
    const deleted = await deleteLibraryEntry(id);
    if (!deleted) { await audit('denied', `${id}: not found`); return NextResponse.json({ error: 'Not found' }, { status: 404 }); }
    await audit('success', `${id}: ${deleted.name}${deleted.codified ? ` (codified skill, use case ${deleted.codified.useCaseId} reset)` : ''}`);
    return NextResponse.json({ ok: true, ...deleted });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Library] delete failed for ${id}:`, message);
    await audit('failure', `${id}: ${message.slice(0, 500)}`);
    return NextResponse.json({ error: 'delete_failed' }, { status: 500 });
  }
}

interface EntryUpdate {
  description?: string | null;
  install_guide?: string | null;
  source_url?: string | null;
  department?: string | null;
  updated_at: number;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getAdminSession(req);
  if (!session.authenticated) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id: idStr } = await params;
  const client = await getTypedClient();
  const id = parseInt(idStr, 10);
  const e = schema.skillLibraryEntries;

  const entryRows = await client
    .select({ id: e.id, author_user_id: e.author_user_id })
    .from(e)
    .where(eq(e.id, id));
  const entry = entryRows[0];

  if (!entry) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const isAdminOrManager = canAccessPulseAdmin(session.role);
  const isAuthor = await isEntryAuthor(session, entry.author_user_id);
  if (!isAuthor && !isAdminOrManager) {
    return NextResponse.json({ error: 'Only the author or an admin/manager can edit this entry' }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const allowed = ['description', 'install_guide', 'source_url'] as const;
  const updates: EntryUpdate = { updated_at: Math.floor(Date.now() / 1000) };
  let hasField = false;

  for (const key of allowed) {
    if (key in body) { updates[key] = body[key]; hasField = true; }
  }
  if ('source_url' in body) {
    const sourceUrl = normaliseSourceUrl(body.source_url);
    if (sourceUrl === undefined) return NextResponse.json({ error: SOURCE_URL_ERROR }, { status: 400 });
    updates.source_url = sourceUrl;
  }

  // department is a separate, stricter gate: admin/manager only, regardless
  // of authorship — an author who isn't admin/manager cannot restrict their
  // own entry to a department.
  if ('department' in body) {
    if (!isAdminOrManager) {
      return NextResponse.json({ error: 'Only an admin or manager can set department' }, { status: 403 });
    }
    updates.department = body.department;
    hasField = true;
  }

  if (!hasField) return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });

  const updatedRows = await client.update(e).set(updates).where(eq(e.id, id)).returning();

  return NextResponse.json(updatedRows[0]);
}
