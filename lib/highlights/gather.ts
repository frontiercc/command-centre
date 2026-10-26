// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Weekly Highlights — measured input gathering. Pure DB reads, no LLM, no
 * formatting. Mirrors lib/digest/build.ts's role: everything numeric the post
 * needs is computed HERE; the model (compose.ts) only ever writes
 * prose from what this module hands it.
 *
 * Window = the last COMPLETED Monday-UTC week, same convention as the digest
 * (weekStart(now) - 7d .. weekStart(now), end exclusive).
 *
 * Work items are the tier-3 classified messages with usable stored content —
 * stripped-by-retention rows and scheduled-task rows are excluded from the
 * work-item list (but still counted in tier3Count, since they really were
 * tier-3 that week — the count is a volume signal, the list is what the model
 * is allowed to read). Every text passes stripIdentity() (URLs/paths out)
 * then redactPii() (structured PII out) BEFORE it leaves this module, so
 * nothing downstream ever sees raw identity.
 *
 * Postgres returns count(*)/count(distinct ...) as a STRING — every
 * aggregate read here is Number()-coerced at the read site (Policy B, same
 * as lib/digest/build.ts and lib/reports/*-sections.ts).
 */
import { getCodeWorkTypeLabeller } from '@/lib/pulse/code/tier-config';
import { and, desc, eq, gte, isNotNull, isNull, lt, ne, notLike, or, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { weekStart } from '@/lib/pulse/period';
import { stripIdentity } from '@/lib/usecases/prompt-text';
import { ORG_SCOPE_ID } from '@/lib/pulse/code/aggregator';
import { readOrgHumanTime } from '@/lib/pulse/human-time-summary';

const WEEK = 7 * 86400;
const MAX_WORK_ITEMS = 18;
const MAX_TOP_SYSTEMS = 8;
// Mirrors the marker written by lib/retention/cleanup.ts's strip mode.
const STRIPPED_MARKER = '[Content removed — retention policy]';
const SCHEDULED_PREFIX = '<scheduled-task%';

export interface HighlightsWorkItem { index: number; taskType: string | null; text: string }
export interface HighlightsShoutout { person: string; count: number; distinct: number }
export interface HighlightsInput {
  weekStart: number;            // epoch s, Monday UTC (last completed week)
  weekEnd: number;              // exclusive
  headcount: number;            // distinct user_id in cowork_messages, window
  workItems: HighlightsWorkItem[];   // tier-3, content-bearing, stripped+redacted, longest-first, max 18
  engineeringMix: { workType: string; sessions: number }[];
  systems: { totalCalls: number; distinctSystems: number; top: { server: string; calls: number; people: number }[] };
  codeOutput: { linesChanged: number; handsOnHours: number; changesKept: number; changesProposed: number; basis: 'week' | 'rolling' } | null;
  tier3Count: number;
  /** Org totals for the week; injected by render, never model-written. Null when off or empty. */
  humanTime?: { humanMinutes: number; claudeMinutes: number; sessions: number } | null;
  shoutouts: { skills: HighlightsShoutout | null; systems: HighlightsShoutout | null } | null;  // null unless includeNames
}

const toNum = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

/** URLs and file paths (Windows + Unix) out of request text, replaced with a
 *  neutral placeholder, THEN structured PII (emails/phones/keys/etc, via
 *  redactPii) masked. Client names and other free-text identity are handled
 *  by the compose prompt + human review before send — this
 *  function only guarantees structured locators never reach the model. */
export { stripIdentity };

export async function gatherHighlights(opts?: { nowS?: number; includeNames?: boolean }): Promise<HighlightsInput> {
  const nowS = opts?.nowS ?? Math.floor(Date.now() / 1000);
  const wkEnd = weekStart(nowS);
  const wkStart = wkEnd - WEEK;
  const client = await getTypedClient();

  const cm = schema.coworkMessages;
  const pc = schema.pulseClassifications;
  const inWindow = and(gte(cm.occurred_at, wkStart), lt(cm.occurred_at, wkEnd));

  // Headcount — distinct users active on the cowork surface this week.
  const headcountRows = await client
    .select({ n: sql<number | string>`count(distinct ${cm.user_id})` })
    .from(cm)
    .where(and(inWindow, isNotNull(cm.user_id)));

  // Work items: tier-3, in-window, real stored content, not a retention-strip
  // placeholder and not a scheduled-task row. Longest content first (a proxy
  // for "most substantial"), capped so the compose prompt stays a
  // bounded size.
  const itemRows = await client
    .select({ taskType: pc.task_type, contentFull: cm.content_full })
    .from(pc)
    .innerJoin(cm, eq(cm.id, pc.cowork_message_id))
    .where(and(
      eq(pc.tier, 3),
      inWindow,
      isNotNull(cm.content_full),
      // NULL-safe: a bare ne()/notLike() evaluates to NULL (not true) when
      // content_preview is NULL, silently dropping a row that has real
      // content_full — mirrors lib/retention/cleanup.ts's or(isNull(...),...)
      // idiom so a NULL preview is treated as "not the marker"/"not the
      // scheduled prefix" rather than excluded.
      or(isNull(cm.content_preview), ne(cm.content_preview, STRIPPED_MARKER)),
      or(isNull(cm.content_preview), notLike(cm.content_preview, SCHEDULED_PREFIX)),
    ))
    .orderBy(desc(sql`length(${cm.content_full})`))
    .limit(MAX_WORK_ITEMS);

  const workItems: HighlightsWorkItem[] = itemRows
    .filter(r => (r.contentFull ?? '').trim() !== '')
    .map((r, i) => ({ index: i, taskType: r.taskType ?? null, text: stripIdentity(r.contentFull as string) }));

  // tier3Count — ALL tier-3 classifications in window, content-bearing or
  // not. This is a volume signal (how much deep work happened), distinct
  // from workItems (what the model is allowed to quote from).
  const tier3Rows = await client
    .select({ n: sql<number | string>`count(*)` })
    .from(pc)
    .innerJoin(cm, eq(cm.id, pc.cowork_message_id))
    .where(and(eq(pc.tier, 3), inWindow));

  // Engineering mix — Developer Pulse session classifications for sessions that
  // STARTED this week (css.first_at, not a session's end time).
  const csc = schema.codeSessionClassifications;
  const css = schema.codeSessionStats;
  const codeLabel = await getCodeWorkTypeLabeller();
  const engRows = await client
    .select({ workType: csc.work_type, sessions: sql<number | string>`count(*)` })
    .from(csc)
    .innerJoin(css, eq(css.session_id, csc.session_id))
    .where(and(gte(css.first_at, wkStart), lt(css.first_at, wkEnd)))
    .groupBy(csc.work_type)
    .orderBy(desc(sql`count(*)`));

  // Systems reached — MCP connector calls this week. DELIBERATELY no
  // `surface` filter: this table also carries Chat-surface connector rows
  // written by the Compliance sync (lib/compliance/chat-sync.ts), and the
  // post is org-wide, so those count too — not just cowork/code surfaces
  // (human decision).
  const mcp = schema.coworkMcpInvocations;
  const mcpWindow = and(gte(mcp.occurred_at, wkStart), lt(mcp.occurred_at, wkEnd));
  const sysTotalRows = await client
    .select({
      calls: sql<number | string>`count(*)`,
      distinct: sql<number | string>`count(distinct ${mcp.mcp_server})`,
    })
    .from(mcp)
    .where(mcpWindow);
  const sysTopRows = await client
    .select({
      server: mcp.mcp_server,
      calls: sql<number | string>`count(*)`,
      people: sql<number | string>`count(distinct ${mcp.user_id})`,
    })
    .from(mcp)
    .where(mcpWindow)
    .groupBy(mcp.mcp_server)
    .orderBy(desc(sql`count(*)`))
    .limit(MAX_TOP_SYSTEMS);

  // Code output — prefer the COMPLETED WEEK's own weekly row (same
  // (scope_type, scope_id, period_start) keying + granularity='week' idiom
  // as lib/pulse/trends.ts's getWeeklySeries and the upsert in
  // lib/pulse/code/aggregator.ts's writeCodeMetric — a weekly row is upserted
  // continuously while its week is current and left untouched once the week
  // rolls over, so period_start=wkStart is that week's final snapshot).
  // Falls back to the latest rolling org-scope snapshot (a running total, not
  // week-scoped) only when no weekly row exists yet for this week — e.g. the
  // hourly aggregator hasn't written one, or the deployment predates weekly
  // rows. `basis` tells the renderer which caveat to use ("this
  // week" vs "over the last 30 days"). null only when neither row exists —
  // never a fabricated zero.
  const cmet = schema.codeMetrics;
  const weeklyCodeRows = await client
    .select()
    .from(cmet)
    .where(and(
      eq(cmet.scope_type, 'organisation'),
      eq(cmet.scope_id, ORG_SCOPE_ID),
      eq(cmet.granularity, 'week'),
      eq(cmet.period_start, wkStart),
    ))
    .limit(1);
  let codeRow = weeklyCodeRows[0];
  let codeBasis: 'week' | 'rolling' = 'week';
  if (!codeRow) {
    const rollingCodeRows = await client
      .select()
      .from(cmet)
      .where(and(eq(cmet.scope_type, 'organisation'), eq(cmet.scope_id, ORG_SCOPE_ID), eq(cmet.granularity, 'rolling')))
      .orderBy(desc(cmet.computed_at))
      .limit(1);
    codeRow = rollingCodeRows[0];
    codeBasis = 'rolling';
  }

  let shoutouts: HighlightsInput['shoutouts'] = null;
  if (opts?.includeNames) {
    shoutouts = {
      skills: await topSkillsContributor(client, wkStart, wkEnd),
      systems: await topSystemsContributor(client, wkStart, wkEnd),
    };
  }

  return {
    weekStart: wkStart,
    weekEnd: wkEnd,
    headcount: toNum(headcountRows[0]?.n),
    workItems,
    engineeringMix: engRows.map(r => ({ workType: codeLabel(r.workType ?? 'other'), sessions: toNum(r.sessions) })),
    systems: {
      totalCalls: toNum(sysTotalRows[0]?.calls),
      distinctSystems: toNum(sysTotalRows[0]?.distinct),
      top: sysTopRows.map(r => ({ server: r.server ?? 'unknown', calls: toNum(r.calls), people: toNum(r.people) })),
    },
    codeOutput: codeRow ? {
      linesChanged: toNum(codeRow.lines_added) + toNum(codeRow.lines_removed),
      handsOnHours: Math.round((toNum(codeRow.active_time_user_s) + toNum(codeRow.active_time_cli_s)) / 3600),
      changesKept: toNum(codeRow.edit_accept_count),
      changesProposed: toNum(codeRow.edit_accept_count) + toNum(codeRow.edit_reject_count),
      basis: codeBasis,
    } : null,
    tier3Count: toNum(tier3Rows[0]?.n),
    humanTime: (await readOrgHumanTime(wkStart, wkEnd))?.total ?? null,
    shoutouts,
  };
}

type TypedClient = Awaited<ReturnType<typeof getTypedClient>>;

/** The single person with the most skill invocations this week, plus how
 *  many distinct skills they used. Used only when includeNames is set —
 *  display names are real identity, opt-in only (default null). */
async function topSkillsContributor(client: TypedClient, wkStart: number, wkEnd: number): Promise<HighlightsShoutout | null> {
  const csi = schema.coworkSkillInvocations;
  const u = schema.users;
  const au = schema.adminUsers;
  const rows = await client
    .select({
      person: sql<string>`COALESCE(${au.display_name}, ${u.display_name}, ${u.email})`,
      count: sql<number | string>`count(*)`,
      distinct: sql<number | string>`count(distinct ${csi.skill_name})`,
    })
    .from(csi)
    .leftJoin(u, eq(u.id, csi.user_id))
    .leftJoin(au, eq(au.linked_cowork_user_id, csi.user_id))
    .where(and(gte(csi.occurred_at, wkStart), lt(csi.occurred_at, wkEnd)))
    .groupBy(sql`COALESCE(${au.display_name}, ${u.display_name}, ${u.email})`)
    .orderBy(desc(sql`count(*)`))
    .limit(1);
  const r = rows[0];
  if (!r || !r.person) return null;
  return { person: r.person, count: toNum(r.count), distinct: toNum(r.distinct) };
}

/** The single person with the most connector (MCP) calls this week, plus how
 *  many distinct systems they reached. Used only when includeNames is set.
 *  DELIBERATELY no `surface` filter here either — same reasoning as the
 *  totals query above: Chat-surface connector rows land in this same table
 *  via the Compliance sync, and this is an org-wide shoutout, not a
 *  per-surface one (human decision). */
async function topSystemsContributor(client: TypedClient, wkStart: number, wkEnd: number): Promise<HighlightsShoutout | null> {
  const mcp = schema.coworkMcpInvocations;
  const u = schema.users;
  const au = schema.adminUsers;
  const rows = await client
    .select({
      person: sql<string>`COALESCE(${au.display_name}, ${u.display_name}, ${u.email})`,
      count: sql<number | string>`count(*)`,
      distinct: sql<number | string>`count(distinct ${mcp.mcp_server})`,
    })
    .from(mcp)
    .leftJoin(u, eq(u.id, mcp.user_id))
    .leftJoin(au, eq(au.linked_cowork_user_id, mcp.user_id))
    .where(and(gte(mcp.occurred_at, wkStart), lt(mcp.occurred_at, wkEnd)))
    .groupBy(sql`COALESCE(${au.display_name}, ${u.display_name}, ${u.email})`)
    .orderBy(desc(sql`count(*)`))
    .limit(1);
  const r = rows[0];
  if (!r || !r.person) return null;
  return { person: r.person, count: toNum(r.count), distinct: toNum(r.distinct) };
}
