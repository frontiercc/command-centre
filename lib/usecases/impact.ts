// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Workflow Impact builder. Assembles the 13-completed-week
 * measured-impact view for one use case: the weekly friction/hours series
 * (use_case_activation_weeks columns), a participation breakdown
 * (skills/connectors/models/surfaces over the window's session ids), and a
 * delegation-depth breakdown (classifier tiers bucketed by week, aware of
 * rubric saves no longer create breaks here, the same as the delegation charts).
 *
 * No new capture, no migration. Read-only over the weekly rollup tables + existing
 * classifier/rubric tables. Absent week -> all-null ImpactWeek entry (never
 * a fabricated zero); estimateHours is an ESTIMATE, labelled by the caller.
 */
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getAllConfig } from '@/lib/config';
import { weekStart, weekStarts } from '@/lib/pulse/period';
import { chunk } from '@/lib/usecases/impact-rollup';
import { listUseCases } from '@/lib/usecases/queries';
import { getWindowDistinctUsers } from '@/lib/usecases/weeks';

const WEEK = 7 * 86400;
const WINDOW_WEEKS = 13;
const SESSION_ID_QUERY_LIMIT = 2000;
const NAME_QUERY_CHUNK = 500;
const PARTICIPATION_TOP_N = 12;

export interface ImpactWeek {
  weekStart: number;
  sessions: number | null;
  durationSecs: number | null;
  engagedSecs: number | null;
  toolErrors: number | null;
  coworkToolErrors: number | null;
  editRejects: number | null;
  editAccepts: number | null;
  flagged: number | null;
}
export interface WorkflowUsingSignal { id: string; title: string; lifecycle: string; distinctUsers: number; lastSeenAt: number | null }
export interface ImpactParticipationItem { name: string; sessions: number }
export interface ImpactDepthWeek { weekStart: number; tierCounts: Record<number, number>; total: number }
export interface UseCaseImpact {
  windowWeeks: number;                    // 13
  weeks: ImpactWeek[];                    // ascending, absent week -> all-null entry
  totals: {
    durationSecs: number | null; engagedSecs: number | null; sessions: number; estimateHours: number | null;
    // Additive: the live per-surface split behind
    // durationSecs — Σ active_secs on cowork_session_stats / code_session_stats
    // for the window's matched session ids (same id set as participation,
    // chunked the same way). May not sum exactly to durationSecs (this is a
    // live query over the window's session ids; durationSecs is the sum of
    // the WEEKLY measured_duration_secs columns, which attribute a session
    // straddling two weeks to its earliest week only) — that's fine, the panel
    // uses this live pair for the split and their own sum for the split's
    // headline, so the split always adds up on its own terms. Null when no
    // non-null active_secs rows exist on that surface for the window.
    coworkDurationSecs: number | null;
    codeDurationSecs: number | null;
  };
  participation: { skills: ImpactParticipationItem[]; connectors: ImpactParticipationItem[]; models: ImpactParticipationItem[]; surfaces: { cowork: number; code: number }; cappedAt: number | null };
  depth: { weeks: ImpactDepthWeek[]; rubricChangesAt: number[] };
}

// ─── Raw execution (rawAll: raw-SQL facade over execute()) ──
interface RawFacade {
  execute: (q: unknown) => Promise<{ rows: unknown[]; rowCount: number | null }>;
}
async function rawAll<T>(client: unknown, query: unknown): Promise<T[]> {
  const c = client as RawFacade;
  const res = await c.execute(query);
  return res.rows as T[];
}

function inList(ids: string[]) {
  return sql.join(ids.map(id => sql`${id}`), sql`, `);
}

/** The 13-week ImpactWeek series: measured rows mapped in, absent weeks all-null. */
async function buildWeeklySeries(useCaseId: string, windowStarts: number[]): Promise<ImpactWeek[]> {
  const client = await getTypedClient();
  const t = schema.useCaseActivationWeeks;
  const rows = await client
    .select({
      week_start: t.week_start, session_count: t.session_count,
      measured_duration_secs: t.measured_duration_secs, engaged_secs: t.engaged_secs,
      tool_error_count: t.tool_error_count, edit_reject_count: t.edit_reject_count,
      edit_accept_count: t.edit_accept_count, flagged_count: t.flagged_count,
      cowork_tool_error_count: t.cowork_tool_error_count,
    })
    .from(t)
    .where(and(eq(t.use_case_id, useCaseId), inArray(t.week_start, windowStarts)));

  const byWeek = new Map(rows.map(r => [r.week_start, r]));
  return windowStarts.map((ws): ImpactWeek => {
    const r = byWeek.get(ws);
    if (!r) {
      return {
        weekStart: ws, sessions: null, durationSecs: null, engagedSecs: null,
        toolErrors: null, coworkToolErrors: null, editRejects: null, editAccepts: null, flagged: null,
      };
    }
    return {
      weekStart: ws,
      sessions: Number(r.session_count),
      durationSecs: r.measured_duration_secs === null ? null : Number(r.measured_duration_secs),
      engagedSecs: r.engaged_secs === null ? null : Number(r.engaged_secs),
      toolErrors: r.tool_error_count === null ? null : Number(r.tool_error_count),
      coworkToolErrors: r.cowork_tool_error_count === null ? null : Number(r.cowork_tool_error_count),
      editRejects: r.edit_reject_count === null ? null : Number(r.edit_reject_count),
      editAccepts: r.edit_accept_count === null ? null : Number(r.edit_accept_count),
      flagged: r.flagged_count === null ? null : Number(r.flagged_count),
    };
  });
}

/**
 * Distinct non-empty session ids for the window, one row per session (a
 * session matched in several weeks must occupy exactly one of the 2,000
 * slots, not one per week it appears in), ordered by its most recent
 * matched week, capped at 2,000.
 */
async function windowSessionIds(useCaseId: string, windowStarts: number[]): Promise<{ sessionIds: string[]; cappedAt: number | null }> {
  const client = await getTypedClient();
  const jm = schema.useCaseWeekMatches;
  const maxWeekStart = sql<number>`MAX(${jm.week_start})`;
  const rows = await client
    .select({ session_id: jm.session_id, max_week_start: maxWeekStart })
    .from(jm)
    .where(and(eq(jm.use_case_id, useCaseId), inArray(jm.week_start, windowStarts), ne(jm.session_id, '')))
    .groupBy(jm.session_id)
    .orderBy(desc(maxWeekStart))
    .limit(SESSION_ID_QUERY_LIMIT);

  const sessionIds = rows.map(r => r.session_id);
  const cappedAt = rows.length === SESSION_ID_QUERY_LIMIT ? SESSION_ID_QUERY_LIMIT : null;
  return { sessionIds, cappedAt };
}

/**
 * COUNT(DISTINCT session_id) per `nameCol` value across chunked IN-lists, top
 * N by count. `table`/`nameCol` are real Drizzle table/column objects at
 * runtime; typed loosely (`any`) here purely because this helper is shared
 * across two structurally-different tables (cowork_skill_invocations,
 * cowork_mcp_invocations) and Drizzle's generic table types don't unify.
 */
async function topByName(
  table: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  nameCol: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  sessionIds: string[],
  limit: number,
): Promise<ImpactParticipationItem[]> {
  if (sessionIds.length === 0) return [];
  const client: any = await getTypedClient(); // eslint-disable-line @typescript-eslint/no-explicit-any
  const acc = new Map<string, number>();
  for (const ids of chunk(sessionIds, NAME_QUERY_CHUNK)) {
    const rows: Array<{ name: string; n: number }> = await client
      .select({ name: nameCol, n: sql<number>`COUNT(DISTINCT ${table.session_id})` })
      .from(table)
      .where(inArray(table.session_id, ids))
      .groupBy(nameCol);
    for (const r of rows) acc.set(r.name, (acc.get(r.name) ?? 0) + Number(r.n));
  }
  return [...acc.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, sessions]) => ({ name, sessions }));
}

/**
 * Σ active_secs for one session-stats table over the id set, chunked
 * (disjoint chunks -> sum is exact). Null-aware like impact-rollup.ts's
 * recomputeWeekImpact: a chunk with zero non-null active_secs rows
 * contributes nothing, and the whole result is null (not 0) when NO row in
 * the id set has a non-null active_secs.
 */
async function sumActiveSecs(table: any, sessionIds: string[]): Promise<number | null> { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (sessionIds.length === 0) return null;
  const client: any = await getTypedClient(); // eslint-disable-line @typescript-eslint/no-explicit-any
  let sum = 0;
  let anyNonNull = false;
  for (const ids of chunk(sessionIds, NAME_QUERY_CHUNK)) {
    const rows: Array<{ n: number; s: number }> = await client
      .select({
        n: sql<number>`COUNT(${table.active_secs})`,
        s: sql<number>`COALESCE(SUM(${table.active_secs}), 0)`,
      })
      .from(table)
      .where(inArray(table.session_id, ids));
    const n = Number(rows[0]?.n ?? 0);
    if (n > 0) {
      anyNonNull = true;
      sum += Number(rows[0]?.s ?? 0);
    }
  }
  return anyNonNull ? sum : null;
}

/** COUNT(DISTINCT session_id) for one stats table over the id set, chunked (disjoint chunks -> sum is exact). */
async function countSessionsIn(table: any, sessionIds: string[]): Promise<number> { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (sessionIds.length === 0) return 0;
  const client: any = await getTypedClient(); // eslint-disable-line @typescript-eslint/no-explicit-any
  let total = 0;
  for (const ids of chunk(sessionIds, NAME_QUERY_CHUNK)) {
    const rows: Array<{ n: number }> = await client
      .select({ n: sql<number>`COUNT(DISTINCT ${table.session_id})` })
      .from(table)
      .where(inArray(table.session_id, ids));
    total += Number(rows[0]?.n ?? 0);
  }
  return total;
}

/** Sessions-per-model count, JSON.parse per row (skip malformed), keyed by parsed model name. */
async function modelParticipation(sessionIds: string[]): Promise<ImpactParticipationItem[]> {
  if (sessionIds.length === 0) return [];
  const client = await getTypedClient();
  const acc = new Map<string, number>();

  for (const ids of chunk(sessionIds, NAME_QUERY_CHUNK)) {
    const cwRows = await client
      .select({ models_used: schema.coworkSessionStats.models_used })
      .from(schema.coworkSessionStats)
      .where(inArray(schema.coworkSessionStats.session_id, ids));
    for (const row of cwRows) {
      if (!row.models_used) continue;
      try {
        const models = JSON.parse(row.models_used) as string[];
        for (const m of models) if (m) acc.set(m, (acc.get(m) ?? 0) + 1);
      } catch { /* malformed models_used — skip this session's model contribution */ }
    }

    const cdRows = await client
      .select({ models_json: schema.codeSessionStats.models_json })
      .from(schema.codeSessionStats)
      .where(inArray(schema.codeSessionStats.session_id, ids));
    for (const row of cdRows) {
      if (!row.models_json) continue;
      try {
        // code_session_stats.models_json is an object keyed by model name
        // (see lib/pulse/code/aggregator.ts / classifier.ts), not an array —
        // guard the shape so an array (Object.keys would yield "0"/"1"/...
        // numeric-index "model names") or any other non-object JSON value is
        // skipped rather than corrupting the participation breakdown.
        const parsed: unknown = JSON.parse(row.models_json);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          const models = Object.keys(parsed as Record<string, unknown>);
          for (const m of models) if (m) acc.set(m, (acc.get(m) ?? 0) + 1);
        }
      } catch { /* malformed models_json — skip this session's model contribution */ }
    }
  }

  return [...acc.entries()].sort((a, b) => b[1] - a[1]).map(([name, sessions]) => ({ name, sessions }));
}

/** Classifier-tier counts bucketed by week (cowork by cowork_messages.occurred_at, code by code_session_stats.last_at). */
async function depthByWeek(sessionIds: string[], windowStartsSet: Set<number>): Promise<ImpactDepthWeek[]> {
  const client = await getTypedClient();
  const byWeek = new Map<number, Record<number, number>>();
  const bump = (ws: number, tier: number) => {
    if (!windowStartsSet.has(ws)) return;
    const rec = byWeek.get(ws) ?? {};
    rec[tier] = (rec[tier] ?? 0) + 1;
    byWeek.set(ws, rec);
  };

  if (sessionIds.length > 0) {
    for (const ids of chunk(sessionIds, NAME_QUERY_CHUNK)) {
      const cwRows = await rawAll<{ tier: number | string; occurred_at: number | string }>(
        client,
        sql`SELECT pc.tier AS tier, cm.occurred_at AS occurred_at
            FROM pulse_classifications pc
            JOIN cowork_messages cm ON cm.id = pc.cowork_message_id
            WHERE cm.session_id IN (${inList(ids)})`,
      );
      for (const r of cwRows) bump(weekStart(Number(r.occurred_at)), Number(r.tier));

      const cdRows = await rawAll<{ tier: number | string; last_at: number | string }>(
        client,
        sql`SELECT csc.tier AS tier, css.last_at AS last_at
            FROM code_session_classifications csc
            JOIN code_session_stats css ON css.session_id = csc.session_id
            WHERE csc.session_id IN (${inList(ids)}) AND csc.status = 'classified'`,
      );
      for (const r of cdRows) bump(weekStart(Number(r.last_at)), Number(r.tier));
    }
  }

  return [...byWeek.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ws, tierCounts]) => ({
      weekStart: ws,
      tierCounts,
      total: Object.values(tierCounts).reduce((a, b) => a + b, 0),
    }));
}


export async function buildUseCaseImpact(useCaseId: string, nowS: number): Promise<UseCaseImpact> {
  const windowStarts = weekStarts(nowS - WEEK, WINDOW_WEEKS); // 13 completed weeks, ascending
  const windowStartsSet = new Set(windowStarts);

  const weeks = await buildWeeklySeries(useCaseId, windowStarts);

  const measuredDurations = weeks.map(w => w.durationSecs).filter((v): v is number => v !== null);
  const measuredEngaged = weeks.map(w => w.engagedSecs).filter((v): v is number => v !== null);
  const totalSessions = weeks.reduce((acc, w) => acc + (w.sessions ?? 0), 0);

  const config = await getAllConfig();
  const minutes = parseInt(config.useCasesMinutesSavedPerSession || '30', 10) || 30;

  const { sessionIds, cappedAt } = await windowSessionIds(useCaseId, windowStarts);

  const [skills, connectors, models, cowork, code, depthWeeks, coworkDurationSecs, codeDurationSecs] = await Promise.all([
    topByName(schema.coworkSkillInvocations, schema.coworkSkillInvocations.skill_name, sessionIds, PARTICIPATION_TOP_N),
    topByName(schema.coworkMcpInvocations, schema.coworkMcpInvocations.mcp_server, sessionIds, PARTICIPATION_TOP_N),
    modelParticipation(sessionIds),
    countSessionsIn(schema.coworkSessionStats, sessionIds),
    countSessionsIn(schema.codeSessionStats, sessionIds),
    depthByWeek(sessionIds, windowStartsSet),
    sumActiveSecs(schema.coworkSessionStats, sessionIds),
    sumActiveSecs(schema.codeSessionStats, sessionIds),
  ]);

  const totals = {
    durationSecs: measuredDurations.length > 0 ? measuredDurations.reduce((a, b) => a + b, 0) : null,
    engagedSecs: measuredEngaged.length > 0 ? measuredEngaged.reduce((a, b) => a + b, 0) : null,
    sessions: totalSessions,
    estimateHours: totalSessions === 0 ? null : (totalSessions * minutes) / 60,
    coworkDurationSecs,
    codeDurationSecs,
  };

  return {
    windowWeeks: WINDOW_WEEKS,
    weeks,
    totals,
    participation: {
      skills, connectors, models,
      surfaces: { cowork, code },
      cappedAt,
    },
    // Rubric saves no longer mark the depth panel, the same
    // rule as the delegation charts; the field stays for the API shape.
    depth: { weeks: depthWeeks, rubricChangesAt: [] },
  };
}

/** Max `last_seen_at` across a use case's use_case_activation_weeks rows in the window; null when no rows/all null. */
async function maxLastSeenAt(useCaseId: string, windowStarts: number[]): Promise<number | null> {
  const client = await getTypedClient();
  const t = schema.useCaseActivationWeeks;
  const rows = await client
    .select({ last_seen_at: t.last_seen_at })
    .from(t)
    .where(and(eq(t.use_case_id, useCaseId), inArray(t.week_start, windowStarts)));

  const seen = rows.map(r => r.last_seen_at).filter((v): v is number => v !== null).map(Number);
  return seen.length > 0 ? Math.max(...seen) : null;
}

/**
 * Inverse join for the Library "Powers these workflows" card: given
 * a Library entry's kind + name, finds every non-archived use case whose
 * parsed skills/connectors matching rule contains that exact name.
 * `listUseCases()` + JS filtering — the register is small, no SQL LIKE over
 * the JSON columns. distinctUsers/lastSeenAt are measured over the same
 * 13-completed-week window the rest of the Workflow Impact package uses.
 */
export async function findWorkflowsUsingSignal(
  kind: 'skill' | 'connector',
  name: string,
  nowS: number,
): Promise<WorkflowUsingSignal[]> {
  const useCases = await listUseCases();
  const matches = useCases.filter(uc => {
    if (uc.status === 'archived') return false;
    const list = kind === 'connector' ? uc.connectors : uc.skills;
    return list.includes(name);
  });
  if (matches.length === 0) return [];

  const windowStarts = weekStarts(nowS - WEEK, WINDOW_WEEKS);

  return Promise.all(matches.map(async (uc): Promise<WorkflowUsingSignal> => ({
    id: uc.id,
    title: uc.title,
    lifecycle: uc.lifecycle,
    distinctUsers: await getWindowDistinctUsers(uc.id, windowStarts),
    lastSeenAt: await maxLastSeenAt(uc.id, windowStarts),
  })));
}
