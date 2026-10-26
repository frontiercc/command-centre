// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle conversion on Postgres.
// Applies the BLESSED CONVERSION PATTERN (see the reference conversion
// lib/db/error-queries.ts): call sites use
// getTypedClient() + schema.<table>, transactions via withTx, error-tolerant
// batches via savepointEach.
//
// This file is the biggest and most-depended-on module; every function is async.
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, notInArray, or, sql } from 'drizzle-orm';
import { getTypedClient } from './client';
import { schema } from './schema';
import { jsonToText, textToJsonValue } from './json';
import { withTx } from './with-tx';
import { savepointEach } from './savepoint';

// ─── Phase 3 helpers (shared by converted functions) ───────────────────────

/**
 * Minimal raw-execution facade. The Drizzle query BUILDER is thenable, but a
 * few queries here use table-valued / UNION / date-bucket SQL that is far
 * clearer as a raw statement. Raw execution goes through node-postgres's
 * `.execute().rows`, isolated here behind a narrow local cast rather than an
 * `as any` at each call site.
 */
interface RawFacade {
  execute: (q: unknown) => Promise<{ rows: unknown[]; rowCount: number | null }>;
}
async function rawAll<T>(client: unknown, query: unknown): Promise<T[]> {
  const c = client as RawFacade;
  const res = await c.execute(query);
  return res.rows as T[];
}

/**
 * Affected-row count for UPDATE/DELETE. node-postgres's driver resolves
 * `db.update()/delete()` to the raw pg `QueryResult` (`.rowCount`).
 */
function rowsAffected(result: unknown): number {
  const r = result as { rowCount?: number | null };
  return r.rowCount ?? 0;
}

// ─── Type definitions ─────────────────────────────────────────────────────

export interface User {
  id: string;
  email: string;
  display_name: string | null;
  department: string | null;
  first_seen_at: number | null;
  last_seen_at: number | null;
  created_at: number;
  deactivated_at: number | null;
  deactivation_reason: string | null;
}

export interface ComplianceEvent {
  id: string;
  user_id: string;
  department: string | null;
  event_type: string;
  surface: string;
  content_preview: string | null;
  metadata: string | null; // JSON string
  flagged: number;
  flag_reason: string | null;
  occurred_at: number;
  ingested_at: number;
}

export interface AnalyticsSnapshot {
  id: string;
  user_id: string;
  snapshot_date: string;
  conversations: number;
  messages_sent: number;
  projects_created: number;
  files_uploaded: number;
  artifacts_created: number;
  skills_used: number;
  connectors_used: number;
  code_commits: number;
  code_prs: number;
  code_lines: number;
  surface_chat: number;
  surface_code: number;
  surface_cowork: number;
}

export interface OtelEvent {
  id: string;
  user_id: string;
  session_id: string | null;
  tool_name: string | null;
  tool_input: string | null; // JSON string
  token_usage: string | null; // JSON string
  file_paths: string | null; // JSON string
  duration_ms: number | null;
  occurred_at: number;
  ingested_at: number;
  event_type: string | null;
  source: string | null;
  surface: string | null;
}

export interface Alert {
  id: string;
  user_id: string | null;
  alert_type: string;
  severity: string;
  title: string;
  explanation: string;
  raw_evidence: string | null; // JSON string
  status: string;
  generated_at: number;
  resolved_at: number | null;
  resolved_by: string | null;
  /** Resolved display name for user_id (admin_users linked wins over users), or null if unresolved. Additive — never overwrites user_id. */
  user_display_name?: string | null;
}

export interface Report {
  id: string;
  report_type: string;
  period_start: string;
  period_end: string;
  generated_by: string | null;
  content_md: string;
  content_summary: string | null;
  generated_at: number;
  /** 1 when the report holds a section only admins and managers may read (FinOps, Spend Review). */
  manager_only?: number;
}

/**
 * Whether a stored report holds a section only admins and managers may read.
 * The flag is set when the report is generated; the headings catch a report
 * stored before the flag existed (migration 0035 marks those too).
 */
export function reportIsManagerOnly(r: Pick<Report, 'content_md'> & { manager_only?: number | null }): boolean {
  if (Number(r.manager_only) === 1) return true;
  const md = r.content_md ?? '';
  return md.includes('## Cost & Chargeback') || md.includes('### Spend Review:');
}

// ─── Users ────────────────────────────────────────────────────────────────

export async function getUsers(limit: number = 500, includeDeactivated = false): Promise<User[]> {
  const db = await getTypedClient();
  const t = schema.users;
  const rows = includeDeactivated
    ? await db.select().from(t).orderBy(desc(t.last_seen_at)).limit(limit)
    : await db.select().from(t).where(isNull(t.deactivated_at)).orderBy(desc(t.last_seen_at)).limit(limit);
  return rows as User[];
}

export async function getDeactivatedUsers(): Promise<User[]> {
  const db = await getTypedClient();
  const t = schema.users;
  const rows = await db.select().from(t).where(isNotNull(t.deactivated_at)).orderBy(desc(t.deactivated_at));
  return rows as User[];
}

export async function deactivateUser(id: string, reason: string): Promise<void> {
  const db = await getTypedClient();
  const t = schema.users;
  // App clock (Date.now()).
  await db
    .update(t)
    .set({ deactivated_at: Math.floor(Date.now() / 1000), deactivation_reason: reason })
    .where(eq(t.id, id));
}

export async function reactivateUser(id: string): Promise<void> {
  const db = await getTypedClient();
  const t = schema.users;
  await db.update(t).set({ deactivated_at: null, deactivation_reason: null }).where(eq(t.id, id));
}

export async function getUserById(id: string): Promise<User | undefined> {
  const db = await getTypedClient();
  const t = schema.users;
  const rows = await db.select().from(t).where(eq(t.id, id)).limit(1);
  return rows[0] as User | undefined;
}

export async function getUserCount(): Promise<number> {
  const db = await getTypedClient();
  const rows = await db.select({ count: sql<number | string>`count(*)` }).from(schema.users);
  return Number(rows[0]?.count ?? 0);
}

export async function getActiveUsersThisWeek(): Promise<number> {
  const db = await getTypedClient();
  const weekAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
  // Count users active via last_seen_at OR with recent cowork_messages. The
  // derived table needs an alias — Postgres (ANSI-strict) rejects an unaliased
  // subquery in FROM, hence `AS active_users`.
  const query = sql`
    SELECT COUNT(DISTINCT id) as count FROM (
      SELECT id FROM users WHERE last_seen_at >= ${weekAgo}
      UNION
      SELECT DISTINCT user_id as id FROM cowork_messages WHERE user_id IS NOT NULL AND occurred_at >= ${weekAgo}
    ) AS active_users
  `;
  const rows = await rawAll<{ count: number | string }>(db, query);
  return Number(rows[0]?.count ?? 0);
}

export async function getActiveUsersLastWeek(): Promise<number> {
  const db = await getTypedClient();
  const now = Math.floor(Date.now() / 1000);
  const weekAgo = now - 7 * 24 * 60 * 60;
  const twoWeeksAgo = now - 14 * 24 * 60 * 60;
  // MUST mirror getActiveUsersThisWeek's definition over the prior 7-day band,
  // or the week-on-week delta is meaningless. The old version counted only
  // users whose LATEST last_seen_at fell in the band — anyone active in both
  // weeks was excluded from "last week" entirely (their last_seen_at had moved
  // forward), so the denominator was really "users who went quiet last week"
  // and the dashboard's WoW% read absurdly high (+900%).
  // cowork_messages carries the actual per-week
  // activity regardless of when the user was last seen overall.
  const query = sql`
    SELECT COUNT(DISTINCT id) as count FROM (
      SELECT id FROM users WHERE last_seen_at >= ${twoWeeksAgo} AND last_seen_at < ${weekAgo}
      UNION
      SELECT DISTINCT user_id as id FROM cowork_messages
       WHERE user_id IS NOT NULL AND occurred_at >= ${twoWeeksAgo} AND occurred_at < ${weekAgo}
    ) AS active_users
  `;
  const rows = await rawAll<{ count: number | string }>(db, query);
  return Number(rows[0]?.count ?? 0);
}

// ─── Compliance Events ────────────────────────────────────────────────────

export interface EventFilters {
  surface?: string;
  userId?: string;
  department?: string;
  flaggedOnly?: boolean;
  dateFrom?: number; // Unix timestamp
  dateTo?: number;
  /** Free text: an exact id when UUID-shaped, else content or user id (case-insensitive). */
  search?: string;
  limit?: number;
  offset?: number;
}

const EVENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getComplianceEvents(filters: EventFilters = {}): Promise<ComplianceEvent[]> {
  const db = await getTypedClient();
  const ce = schema.complianceEvents;
  const u = schema.users;
  const au = schema.adminUsers;

  const conditions = [];
  if (filters.surface) conditions.push(eq(ce.surface, filters.surface));
  if (filters.userId) conditions.push(eq(ce.user_id, filters.userId));
  if (filters.department) conditions.push(eq(u.department, filters.department));
  if (filters.flaggedOnly) conditions.push(eq(ce.flagged, 1));
  if (filters.dateFrom) conditions.push(gte(ce.occurred_at, filters.dateFrom));
  if (filters.dateTo) conditions.push(lte(ce.occurred_at, filters.dateTo));
  // Same rule as the Audit Log's other sources (app/api/events/route.ts).
  if (filters.search) {
    if (EVENT_ID_RE.test(filters.search)) {
      conditions.push(eq(ce.id, filters.search));
    } else {
      const like = `%${filters.search}%`;
      conditions.push(sql`(${ce.content_preview} ILIKE ${like} OR ${ce.user_id} ILIKE ${like})`);
    }
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const limit = filters.limit || 100;
  const offset = filters.offset || 0;

  // Resolve the raw compliance_events.user_id (a UUID) to a display name the
  // same way every other audit builder does (getCoworkEventsForAudit /
  // getSkillConnectorEventsForAudit in app/api/events/route.ts): admin_users
  // (linked_cowork_user_id) wins over the plain users row, so an admin's
  // chosen display name takes precedence over the auto-captured one.
  const rows = await db
    .select({
      event: ce,
      userDisplayName: sql<string | null>`COALESCE(${au.display_name}, ${u.display_name})`,
      userDepartment: sql<string | null>`COALESCE(${au.department}, ${u.department})`,
    })
    .from(ce)
    .leftJoin(u, eq(ce.user_id, u.id))
    .leftJoin(au, eq(au.linked_cowork_user_id, ce.user_id))
    .where(where)
    .orderBy(desc(ce.occurred_at))
    .limit(limit)
    .offset(offset);

  // Policy A: metadata normalised to a JSON string.
  // user_id is resolved to the display name when one is found (matching the
  // cowork/skill audit builders); falls back to the raw stored id otherwise.
  return rows.map((r) => ({
    ...r.event,
    user_id: r.userDisplayName || r.event.user_id,
    department: r.userDepartment ?? null,
    metadata: jsonToText(r.event.metadata),
  })) as ComplianceEvent[];
}

export async function getComplianceEventById(id: string): Promise<ComplianceEvent | undefined> {
  const db = await getTypedClient();
  const ce = schema.complianceEvents;
  const u = schema.users;
  const au = schema.adminUsers;
  // Same department resolution as getComplianceEvents (admin_users wins).
  const rows = await db
    .select({
      event: ce,
      userDepartment: sql<string | null>`COALESCE(${au.department}, ${u.department})`,
    })
    .from(ce)
    .leftJoin(u, eq(ce.user_id, u.id))
    .leftJoin(au, eq(au.linked_cowork_user_id, ce.user_id))
    .where(eq(ce.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  return {
    ...row.event,
    department: row.userDepartment ?? null,
    metadata: jsonToText(row.event.metadata),
  } as ComplianceEvent;
}

export async function getEventsLast24h(): Promise<number> {
  const db = await getTypedClient();
  const dayAgo = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
  const ce = schema.complianceEvents;
  const cm = schema.coworkMessages;
  const chat = schema.chatMessages;

  // cowork_messages/chat_messages are guaranteed by the schema/migrations
  // (matches the getActiveUsersThisWeek precedent) — the
  // legacy "table may not exist" try/catch guard is no longer needed.
  const [complianceRows, coworkRows, chatRows] = await Promise.all([
    db.select({ count: sql<number | string>`count(*)` }).from(ce).where(gte(ce.ingested_at, dayAgo)),
    db.select({ count: sql<number | string>`count(*)` }).from(cm).where(gte(cm.ingested_at, dayAgo)),
    db.select({ count: sql<number | string>`count(*)` }).from(chat).where(gte(chat.ingested_at, dayAgo)),
  ]);

  return Number(complianceRows[0]?.count ?? 0) + Number(coworkRows[0]?.count ?? 0) + Number(chatRows[0]?.count ?? 0);
}

export async function getRecentComplianceEvents(limit: number = 100): Promise<ComplianceEvent[]> {
  const db = await getTypedClient();
  const ce = schema.complianceEvents;
  const rows = await db.select().from(ce).orderBy(desc(ce.occurred_at)).limit(limit);
  return rows.map((r) => ({ ...r, metadata: jsonToText(r.metadata) })) as ComplianceEvent[];
}

// ─── Analytics Snapshots ──────────────────────────────────────────────────

export async function getSnapshotsForUser(userId: string, days: number = 30): Promise<AnalyticsSnapshot[]> {
  const db = await getTypedClient();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  const asnap = schema.analyticsSnapshots;
  const rows = await db
    .select()
    .from(asnap)
    .where(and(eq(asnap.user_id, userId), gte(asnap.snapshot_date, cutoffStr)))
    .orderBy(asc(asnap.snapshot_date));
  if (rows.length > 0) return rows as AnalyticsSnapshot[];

  // Fallback: synthesise daily snapshots from chat_messages + cowork_messages.
  // The UTC date-bucket fragment is reused across all three UNION
  // ALL branches + the outer GROUP BY; the derived table in FROM is aliased
  // (`AS daily`) — Postgres (ANSI-strict) rejects an unaliased FROM subquery.
  try {
    const cutoffTs = Math.floor(cutoff.getTime() / 1000);
    // AT TIME ZONE 'UTC' is required: to_char formats in the Postgres SESSION
    // timezone — without this, buckets shift by a day near midnight UTC on any
    // non-UTC-configured Postgres server.
    const dateExpr = sql`to_char(to_timestamp(occurred_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
    const query = sql`
      SELECT
        ${userId} as user_id,
        day as snapshot_date,
        SUM(chat + code + cowork) as messages_sent,
        0 as conversations,
        0 as code_commits,
        0 as code_prs,
        SUM(chat) as surface_chat,
        SUM(code) as surface_code,
        SUM(cowork) as surface_cowork
      FROM (
        SELECT ${dateExpr} as day, COUNT(*) as chat, 0 as code, 0 as cowork
        FROM chat_messages WHERE user_id = ${userId} AND occurred_at >= ${cutoffTs} GROUP BY day
        UNION ALL
        SELECT ${dateExpr} as day, 0 as chat, COUNT(*) as code, 0 as cowork
        FROM cowork_messages WHERE user_id = ${userId} AND surface = 'code' AND occurred_at >= ${cutoffTs} GROUP BY day
        UNION ALL
        SELECT ${dateExpr} as day, 0 as chat, 0 as code, COUNT(*) as cowork
        FROM cowork_messages WHERE user_id = ${userId} AND surface = 'cowork' AND occurred_at >= ${cutoffTs} GROUP BY day
      ) AS daily
      GROUP BY day
      ORDER BY snapshot_date ASC
    `;
    const rawRows = await rawAll<{
      user_id: string; snapshot_date: string; messages_sent: number | string;
      conversations: number | string; code_commits: number | string; code_prs: number | string;
      surface_chat: number | string; surface_code: number | string; surface_cowork: number | string;
    }>(db, query);
    // count/bigint->Number (Policy B): SUM() results come back as strings on pg.
    return rawRows.map((r) => ({
      ...r,
      messages_sent: Number(r.messages_sent),
      conversations: Number(r.conversations),
      code_commits: Number(r.code_commits),
      code_prs: Number(r.code_prs),
      surface_chat: Number(r.surface_chat),
      surface_code: Number(r.surface_code),
      surface_cowork: Number(r.surface_cowork),
    })) as AnalyticsSnapshot[];
  } catch { return []; }
}

export async function getSnapshotsForPeriod(days: number = 7): Promise<AnalyticsSnapshot[]> {
  const db = await getTypedClient();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  const asnap = schema.analyticsSnapshots;
  const rows = await db
    .select()
    .from(asnap)
    .where(gte(asnap.snapshot_date, cutoffStr))
    .orderBy(asc(asnap.snapshot_date));
  return rows as AnalyticsSnapshot[];
}

export async function getAdoptionTrend(days: number = 7): Promise<Array<{
  date: string;
  surface_chat: number;
  surface_code: number;
  surface_cowork: number;
}>> {
  const db = await getTypedClient();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().split('T')[0];
  // Upper bound: never plot the future. A future-dated row (bad seed data, a
  // client with a wrong clock) would otherwise pass the >= cutoff filter and
  // stretch the chart's window forward with zero-filled days.
  const todayStr = new Date().toISOString().split('T')[0];

  // Try analytics_snapshots first (Enterprise mode)
  const asnap = schema.analyticsSnapshots;
  const snapshotRows = await db
    .select({
      date: asnap.snapshot_date,
      surface_chat: sql<number | string>`sum(${asnap.surface_chat})`,
      surface_code: sql<number | string>`sum(${asnap.surface_code})`,
      surface_cowork: sql<number | string>`sum(${asnap.surface_cowork})`,
    })
    .from(asnap)
    .where(and(gte(asnap.snapshot_date, cutoffStr), lte(asnap.snapshot_date, todayStr)))
    .groupBy(asnap.snapshot_date)
    .orderBy(asc(asnap.snapshot_date));
  // count/bigint->Number (Policy B): SUM() results come back as strings on pg.
  const snapshots = snapshotRows.map((r) => ({
    date: r.date,
    surface_chat: Number(r.surface_chat),
    surface_code: Number(r.surface_code),
    surface_cowork: Number(r.surface_cowork),
  }));

  // Merge strategy (not short-circuit): build the live fallback across the WHOLE
  // window first, then overlay any analytics_snapshots per-date below. This stops
  // a sparse/stale snapshot batch (e.g. a single old day) from blanking the graph —
  // every window day without a snapshot still shows live-derived activity.
  // (Merge behaviour preserved exactly across this conversion.)

  // Fallback: derive from cowork_messages + otel_events + chat_messages (Max mode)
  const cutoffUnix = Math.floor(cutoff.getTime() / 1000);
  // The UTC date-bucket fragment is reused in both the SELECT and
  // GROUP BY of each raw query below.
  // AT TIME ZONE 'UTC' is required: to_char formats in the Postgres SESSION
  // timezone — without this, buckets shift by a day near midnight UTC on any
  // non-UTC-configured Postgres server.
  const dateExpr = sql`to_char(to_timestamp(occurred_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;

  // Get cowork activity by day (only actual cowork, not code)
  const coworkByDay = await rawAll<{ date: string; cnt: number | string }>(db, sql`
    SELECT ${dateExpr} as date, COUNT(DISTINCT user_id) as cnt
    FROM cowork_messages WHERE occurred_at >= ${cutoffUnix} AND (surface = 'cowork' OR surface IS NULL)
    GROUP BY ${dateExpr}
  `);

  // Get code activity by day (from cowork_messages with surface='code' + otel_events)
  const codeByDay = await rawAll<{ date: string; cnt: number | string }>(db, sql`
    SELECT ${dateExpr} as date, COUNT(*) as cnt
    FROM cowork_messages WHERE occurred_at >= ${cutoffUnix} AND surface = 'code'
    GROUP BY ${dateExpr}
  `);

  // Get chat activity by day (from chat_messages + otel_events with surface='chat')
  let chatByDay: Array<{ date: string; cnt: number | string }> = [];
  try {
    chatByDay = await rawAll<{ date: string; cnt: number | string }>(db, sql`
      SELECT ${dateExpr} as date, COUNT(*) as cnt
      FROM chat_messages WHERE occurred_at >= ${cutoffUnix}
      GROUP BY ${dateExpr}
    `);
  } catch { /* table may not exist */ }

  // Merge all surfaces by date
  const dateMap = new Map<string, { surface_chat: number; surface_code: number; surface_cowork: number }>();
  for (const r of coworkByDay) {
    const entry = dateMap.get(r.date) || { surface_chat: 0, surface_code: 0, surface_cowork: 0 };
    entry.surface_cowork = Number(r.cnt);
    dateMap.set(r.date, entry);
  }
  for (const r of codeByDay) {
    const entry = dateMap.get(r.date) || { surface_chat: 0, surface_code: 0, surface_cowork: 0 };
    entry.surface_code = Number(r.cnt);
    dateMap.set(r.date, entry);
  }
  for (const r of chatByDay) {
    const entry = dateMap.get(r.date) || { surface_chat: 0, surface_code: 0, surface_cowork: 0 };
    entry.surface_chat += Number(r.cnt);
    dateMap.set(r.date, entry);
  }

  // Overlay analytics_snapshots — authoritative for the dates they cover, but
  // only for those dates (live fallback fills every other day in the window).
  for (const s of snapshots) {
    dateMap.set(s.date, {
      surface_chat: s.surface_chat,
      surface_code: s.surface_code,
      surface_cowork: s.surface_cowork,
    });
  }

  return Array.from(dateMap.entries())
    .map(([date, counts]) => ({ date, ...counts }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ─── OTel Events ──────────────────────────────────────────────────────────

// Policy A: tool_input/token_usage/file_paths normalised to a JSON string.
function normaliseOtelEventRow<T extends { tool_input: unknown; token_usage: unknown; file_paths: unknown }>(
  r: T
): OtelEvent {
  return {
    ...r,
    tool_input: jsonToText(r.tool_input),
    token_usage: jsonToText(r.token_usage),
    file_paths: jsonToText(r.file_paths),
  } as unknown as OtelEvent;
}

export async function getOtelEvents(filters: EventFilters = {}): Promise<OtelEvent[]> {
  const db = await getTypedClient();
  const oe = schema.otelEvents;

  const conditions = [];
  if (filters.userId) conditions.push(eq(oe.user_id, filters.userId));
  if (filters.dateFrom) conditions.push(gte(oe.occurred_at, filters.dateFrom));
  if (filters.dateTo) conditions.push(lte(oe.occurred_at, filters.dateTo));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const limit = filters.limit || 100;
  const offset = filters.offset || 0;

  const rows = await db
    .select()
    .from(oe)
    .where(where)
    .orderBy(desc(oe.occurred_at))
    .limit(limit)
    .offset(offset);

  return rows.map(normaliseOtelEventRow);
}

export async function getRecentOtelEvents(limit: number = 100): Promise<OtelEvent[]> {
  const db = await getTypedClient();
  const oe = schema.otelEvents;
  const rows = await db.select().from(oe).orderBy(desc(oe.occurred_at)).limit(limit);
  return rows.map(normaliseOtelEventRow);
}

export async function getCoworkSessionCount(): Promise<number> {
  const db = await getTypedClient();
  const oe = schema.otelEvents;
  const rows = await db.select({ count: sql<number | string>`count(distinct ${oe.session_id})` }).from(oe);
  return Number(rows[0]?.count ?? 0);
}

export async function getCoworkSessionCountThisWeek(): Promise<number> {
  const db = await getTypedClient();
  const weekAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
  const cm = schema.coworkMessages;

  // Primary: count from cowork_messages (has actual session content). Table
  // existence is guaranteed by the schema/migrations —
  // the legacy "table may not exist" try/catch guard is no longer needed.
  const coworkRows = await db
    .select({ count: sql<number | string>`count(distinct ${cm.session_id})` })
    .from(cm)
    .where(and(gte(cm.occurred_at, weekAgo), sql`${cm.session_id} != ''`));
  const coworkCount = Number(coworkRows[0]?.count ?? 0);
  if (coworkCount > 0) return coworkCount;

  // Fallback: otel_events if no cowork data
  const oe = schema.otelEvents;
  const otelRows = await db
    .select({ count: sql<number | string>`count(distinct ${oe.session_id})` })
    .from(oe)
    .where(and(gte(oe.occurred_at, weekAgo), isNotNull(oe.session_id), sql`${oe.session_id} != ''`));
  return Number(otelRows[0]?.count ?? 0);
}

// ─── Alerts ───────────────────────────────────────────────────────────────

export interface AlertFilters {
  status?: string;
  department?: string;
  /** Restrict to these alert_type values (e.g. from typesForCategory()); empty/undefined = no filter. */
  types?: string[];
}

export async function getAlerts(statusOrFilters?: string | AlertFilters): Promise<Alert[]> {
  const filters: AlertFilters = typeof statusOrFilters === 'string'
    ? { status: statusOrFilters }
    : (statusOrFilters || {});

  const db = await getTypedClient();
  const a = schema.alerts;
  const u = schema.users;
  const au = schema.adminUsers;

  const conditions = [];
  if (filters.status) conditions.push(eq(a.status, filters.status));
  if (filters.department) conditions.push(eq(u.department, filters.department));
  if (filters.types && filters.types.length > 0) conditions.push(inArray(a.alert_type, filters.types));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  // Resolve alerts.user_id (a UUID) to a display name the same way the audit
  // builders do (getComplianceEvents / getCoworkEventsForAudit): admin_users
  // (linked_cowork_user_id) wins over the plain users row. Returned as an
  // ADDITIVE field — user_id itself is never overwritten, other consumers
  // still need the real id.
  const rows = await db
    .select({
      alert: a,
      // The email is the last resort so the page never has to show the raw id.
      userDisplayName: sql<string | null>`COALESCE(${au.display_name}, ${u.display_name}, ${u.email})`,
    })
    .from(a)
    .leftJoin(u, eq(a.user_id, u.id))
    .leftJoin(au, eq(au.linked_cowork_user_id, a.user_id))
    .where(where)
    .orderBy(desc(a.generated_at))
    .limit(500);

  // Some generators (code_cost_spike, code_model_policy) interpolate the raw
  // user_id directly into title/explanation at creation time. When a display
  // name resolves, substitute it in-place so text stays readable even for
  // OTel-derived ids that aren't human-readable (e.g. an internal hash) —
  // the stored row itself is untouched, this is presentation-only.
  const substituteName = (text: string, userId: string | null, displayName: string | null): string =>
    displayName && userId ? text.split(userId).join(displayName) : text;

  // The evidence carries the raw id too (code_cost_spike stores user_id, and
  // code_model_policy a "<id>:<model>" subject); the Alerts page prints it as
  // it is. Show the person's name there instead: "user_id": "<id>" becomes
  // "user": "<name>". Presentation-only, like the swap above; the stored
  // evidence keeps the id, which the generators' dedup reads.
  const nameEvidence = (evidence: string | null, userId: string | null, displayName: string | null): string | null => {
    if (!evidence || !userId || !displayName) return evidence;
    try {
      const parsed: unknown = JSON.parse(evidence);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return substituteName(evidence, userId, displayName);
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (k === 'user_id' && v === userId) out.user = displayName;
        else out[k] = typeof v === 'string' ? substituteName(v, userId, displayName) : v;
      }
      return JSON.stringify(out);
    } catch {
      return substituteName(evidence, userId, displayName);
    }
  };

  // Policy A: raw_evidence normalised to a JSON string.
  return rows.map((r) => ({
    ...r.alert,
    raw_evidence: nameEvidence(jsonToText(r.alert.raw_evidence), r.alert.user_id, r.userDisplayName),
    user_display_name: r.userDisplayName,
    title: substituteName(r.alert.title, r.alert.user_id, r.userDisplayName),
    explanation: substituteName(r.alert.explanation, r.alert.user_id, r.userDisplayName),
  })) as Alert[];
}

export async function getAlertById(id: string): Promise<Alert | undefined> {
  const db = await getTypedClient();
  const a = schema.alerts;
  const rows = await db.select().from(a).where(eq(a.id, id)).limit(1);
  const row = rows[0];
  if (!row) return undefined;
  return { ...row, raw_evidence: jsonToText(row.raw_evidence) } as Alert;
}

export async function getOpenAlertCount(): Promise<number> {
  const db = await getTypedClient();
  const a = schema.alerts;
  const rows = await db.select({ count: sql<number | string>`count(*)` }).from(a).where(eq(a.status, 'open'));
  return Number(rows[0]?.count ?? 0);
}

export async function getOpenAlertsBySeverity(): Promise<Record<string, number>> {
  const db = await getTypedClient();
  const a = schema.alerts;
  const rows = await db
    .select({ severity: a.severity, count: sql<number | string>`count(*)` })
    .from(a)
    .where(eq(a.status, 'open'))
    .groupBy(a.severity);

  const result: Record<string, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const row of rows) {
    result[row.severity] = Number(row.count);
  }
  return result;
}

export async function getRecentAlerts(limit: number = 5): Promise<Alert[]> {
  const db = await getTypedClient();
  const a = schema.alerts;
  const rows = await db.select().from(a).orderBy(desc(a.generated_at)).limit(limit);
  return rows.map((r) => ({ ...r, raw_evidence: jsonToText(r.raw_evidence) })) as Alert[];
}

/** Returns the epoch-seconds timestamp of the most recent alert, or 0 if none exist. */
export async function getLatestAlertTimestamp(): Promise<number> {
  const db = await getTypedClient();
  const a = schema.alerts;
  const rows = await db.select({ ts: sql<number | string | null>`max(${a.generated_at})` }).from(a);
  const ts = rows[0]?.ts;
  return ts == null ? 0 : Number(ts);
}

/** Returns true if a recent alert already exists for this user + alert_type (any status within 7 days). */
export async function hasRecentAlertForUserAndType(userId: string | null, alertType: string): Promise<boolean> {
  const db = await getTypedClient();
  const a = schema.alerts;
  const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
  // Postgres's `IS` operator only accepts NULL/TRUE/FALSE/DISTINCT FROM, not
  // an arbitrary bound text value, so NULL vs non-NULL branches on
  // isNull()/eq().
  const userCond = userId === null ? isNull(a.user_id) : eq(a.user_id, userId);
  const rows = await db
    .select({ count: sql<number | string>`count(*)` })
    .from(a)
    .where(and(eq(a.alert_type, alertType), userCond, gte(a.generated_at, sevenDaysAgo)));
  return Number(rows[0]?.count ?? 0) > 0;
}

export async function updateAlertStatus(
  id: string,
  status: string,
  resolvedBy?: string
): Promise<void> {
  const db = await getTypedClient();
  const a = schema.alerts;
  if (status === 'resolved' || status === 'dismissed') {
    // App-clock timestamp.
    const nowS = Math.floor(Date.now() / 1000);
    await db.update(a).set({ status, resolved_at: nowS, resolved_by: resolvedBy || null }).where(eq(a.id, id));
  } else {
    await db.update(a).set({ status }).where(eq(a.id, id));
  }
}

export async function bulkUpdateAlertStatus(
  fromStatus: string,
  toStatus: string,
  resolvedBy?: string,
  types?: string[]
): Promise<number> {
  const db = await getTypedClient();
  const a = schema.alerts;
  const whereCond = types && types.length
    ? and(eq(a.status, fromStatus), inArray(a.alert_type, types))
    : eq(a.status, fromStatus);
  if (toStatus === 'resolved' || toStatus === 'dismissed') {
    const nowS = Math.floor(Date.now() / 1000);
    const result = await db
      .update(a)
      .set({ status: toStatus, resolved_at: nowS, resolved_by: resolvedBy || null })
      .where(whereCond);
    return rowsAffected(result);
  } else {
    const result = await db.update(a).set({ status: toStatus }).where(whereCond);
    return rowsAffected(result);
  }
}

export async function deleteClosedAlerts(): Promise<number> {
  const db = await getTypedClient();
  const a = schema.alerts;
  const result = await db.delete(a).where(inArray(a.status, ['resolved', 'dismissed']));
  return rowsAffected(result);
}

export async function insertAlert(alert: Omit<Alert, 'generated_at' | 'resolved_at' | 'resolved_by' | 'status'>): Promise<void> {
  const db = await getTypedClient();
  const a = schema.alerts;
  await db.insert(a).values({
    id: alert.id,
    user_id: alert.user_id,
    alert_type: alert.alert_type,
    severity: alert.severity,
    title: alert.title,
    explanation: alert.explanation,
    // Policy A write inverse: parse the JSON string to a JS value for pg's
    // jsonb codec.
    raw_evidence: textToJsonValue(alert.raw_evidence) as never,
  });
}

// ─── Reports ──────────────────────────────────────────────────────────────

/**
 * Stored reports, newest first. `includeManagerOnly: false` (anyone who is not
 * an admin or manager) leaves out reports holding a cost section, which name
 * people's spend.
 */
export async function getReports(limit: number = 200, opts: { includeManagerOnly?: boolean } = {}): Promise<Report[]> {
  const db = await getTypedClient();
  const r = schema.reports;
  const includeManagerOnly = opts.includeManagerOnly ?? true;
  const rows = await db.select().from(r)
    .where(includeManagerOnly ? undefined : eq(r.manager_only, 0))
    .orderBy(desc(r.generated_at)).limit(limit);
  const list = rows as Report[];
  return includeManagerOnly ? list : list.filter(x => !reportIsManagerOnly(x));
}

export async function getReportById(id: string, opts: { includeManagerOnly?: boolean } = {}): Promise<Report | undefined> {
  const db = await getTypedClient();
  const r = schema.reports;
  const rows = await db.select().from(r).where(eq(r.id, id)).limit(1);
  const report = rows[0] as Report | undefined;
  if (report && (opts.includeManagerOnly ?? true) === false && reportIsManagerOnly(report)) return undefined;
  return report;
}

export async function insertReport(report: Omit<Report, 'generated_at'>): Promise<void> {
  const db = await getTypedClient();
  const r = schema.reports;
  await db.insert(r).values({
    id: report.id,
    report_type: report.report_type,
    period_start: report.period_start,
    period_end: report.period_end,
    generated_by: report.generated_by,
    content_md: report.content_md,
    content_summary: report.content_summary,
    manager_only: report.manager_only ?? 0,
  });
}

// ─── Dashboard aggregates ─────────────────────────────────────────────────

export async function getSurfaceBreakdown(): Promise<{ chat: number; code: number; agentCowork: number; otelCowork: number }> {
  const db = await getTypedClient();
  // App-clock cutoff string, 7 days back (matches the
  // getSnapshotsForUser/getSnapshotsForPeriod convention elsewhere in this file).
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  // Try analytics_snapshots first (Enterprise mode)
  const asnap = schema.analyticsSnapshots;
  const snapRows = await db
    .select({
      chat: sql<number | string>`coalesce(sum(${asnap.surface_chat}), 0)`,
      code: sql<number | string>`coalesce(sum(${asnap.surface_code}), 0)`,
      cowork: sql<number | string>`coalesce(sum(${asnap.surface_cowork}), 0)`,
    })
    .from(asnap)
    .where(gte(asnap.snapshot_date, cutoffStr));
  // count/bigint->Number (Policy B): SUM() results come back as strings on pg.
  const row = {
    chat: Number(snapRows[0]?.chat ?? 0),
    code: Number(snapRows[0]?.code ?? 0),
    cowork: Number(snapRows[0]?.cowork ?? 0),
  };

  if (row.chat + row.code + row.cowork > 0) {
    return { chat: row.chat, code: row.code, agentCowork: row.cowork, otelCowork: 0 };
  }

  // Fallback: derive from agent data (Max mode)
  const weekAgo = Math.floor(Date.now() / 1000) - 7 * 86400;

  // Count cowork vs code from cowork_messages, split by source
  let agentCowork = 0;
  let otelCowork = 0;
  let codeFromAgent = 0;
  try {
    const cm = schema.coworkMessages;
    const cwRows = await db
      .select({
        agentCowork: sql<number | string>`coalesce(sum(case when (${cm.surface} = 'cowork' or ${cm.surface} is null) and ${cm.source} = 'agent' then 1 else 0 end), 0)`,
        otelCowork: sql<number | string>`coalesce(sum(case when (${cm.surface} = 'cowork' or ${cm.surface} is null) and ${cm.source} = 'otel' then 1 else 0 end), 0)`,
        code: sql<number | string>`coalesce(sum(case when ${cm.surface} = 'code' then 1 else 0 end), 0)`,
      })
      .from(cm)
      .where(gte(cm.occurred_at, weekAgo));
    agentCowork = Number(cwRows[0]?.agentCowork ?? 0);
    otelCowork = Number(cwRows[0]?.otelCowork ?? 0);
    codeFromAgent = Number(cwRows[0]?.code ?? 0);
  } catch { /* table may not exist */ }

  // Also count from otel_events (legacy/metadata events)
  const oe = schema.otelEvents;
  const otelRows = await db
    .select({
      chat: sql<number | string>`coalesce(sum(case when ${oe.surface} = 'chat' then 1 else 0 end), 0)`,
      code: sql<number | string>`coalesce(sum(case when ${oe.surface} = 'code' then 1 else 0 end), 0)`,
    })
    .from(oe)
    .where(and(
      gte(oe.occurred_at, weekAgo),
      or(isNull(oe.event_type), notInArray(oe.event_type, ['process_snapshot', 'agent_heartbeat']))
    ));
  const otel = {
    chat: Number(otelRows[0]?.chat ?? 0),
    code: Number(otelRows[0]?.code ?? 0),
  };

  // Include chat_messages in the chat count (IndexedDB-sourced prompts)
  let chatFromAgent = 0;
  try {
    const cmsg = schema.chatMessages;
    const chatRows = await db
      .select({ count: sql<number | string>`count(*)` })
      .from(cmsg)
      .where(gte(cmsg.occurred_at, weekAgo));
    chatFromAgent = Number(chatRows[0]?.count ?? 0);
  } catch { /* table may not exist */ }

  return { chat: otel.chat + chatFromAgent, code: otel.code + codeFromAgent, agentCowork, otelCowork };
}

// ─── User detail enrichment ───────────────────────────────────────────────

export async function getUserAdoptionHealth(userId: string): Promise<'active' | 'shallow' | 'inactive'> {
  const snapshots = await getSnapshotsForUser(userId, 14);
  if (snapshots.length > 0) {
    const totalMessages = snapshots.reduce((sum, s) => sum + s.messages_sent, 0);
    const usesMultipleSurfaces = snapshots.some(s => s.surface_code > 0) || snapshots.some(s => s.surface_cowork > 0);
    if (totalMessages < 5) return 'inactive';
    if (!usesMultipleSurfaces) return 'shallow';
    return 'active';
  }

  // Fallback: check cowork_messages for agent-sourced data
  try {
    const db = await getTypedClient();
    const cm = schema.coworkMessages;
    const weekAgo = Math.floor(Date.now() / 1000) - 14 * 86400;
    const rows = await db
      .select({ count: sql<number | string>`count(*)` })
      .from(cm)
      .where(and(eq(cm.user_id, userId), gte(cm.occurred_at, weekAgo)));
    const count = Number(rows[0]?.count ?? 0);
    if (count >= 5) return 'active';
    if (count > 0) return 'shallow';
  } catch { /* table might not exist */ }
  return 'inactive';
}

export async function getUserPrimarySurface(userId: string): Promise<string> {
  const db = await getTypedClient();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  const asnap = schema.analyticsSnapshots;
  const rows = await db
    .select({
      chat: sql<number | string | null>`sum(${asnap.surface_chat})`,
      code: sql<number | string | null>`sum(${asnap.surface_code})`,
      cowork: sql<number | string | null>`sum(${asnap.surface_cowork})`,
    })
    .from(asnap)
    .where(and(eq(asnap.user_id, userId), gte(asnap.snapshot_date, cutoffStr)));
  const row = rows[0];

  if (row) {
    const chat = Number(row.chat ?? 0);
    const code = Number(row.code ?? 0);
    const cowork = Number(row.cowork ?? 0);
    const max = Math.max(chat, code, cowork);
    if (max > 0) {
      if (max === code) return 'Code';
      if (max === cowork) return 'Cowork';
      return 'Chat';
    }
  }

  // Fallback: count per surface from cowork_messages + chat_messages
  try {
    const weekAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
    const cm = schema.coworkMessages;
    const cmsg = schema.chatMessages;
    const [codeRows, coworkRows, chatRows] = await Promise.all([
      db.select({ count: sql<number | string>`count(*)` }).from(cm)
        .where(and(eq(cm.user_id, userId), eq(cm.surface, 'code'), gte(cm.occurred_at, weekAgo))),
      db.select({ count: sql<number | string>`count(*)` }).from(cm)
        .where(and(eq(cm.user_id, userId), eq(cm.surface, 'cowork'), gte(cm.occurred_at, weekAgo))),
      db.select({ count: sql<number | string>`count(*)` }).from(cmsg)
        .where(and(eq(cmsg.user_id, userId), gte(cmsg.occurred_at, weekAgo))),
    ]);
    const codeCount = Number(codeRows[0]?.count ?? 0);
    const coworkCount = Number(coworkRows[0]?.count ?? 0);
    const chatCount = Number(chatRows[0]?.count ?? 0);
    const max = Math.max(chatCount, codeCount, coworkCount);
    if (max > 0) {
      if (max === codeCount) return 'Code';
      if (max === coworkCount) return 'Cowork';
      return 'Chat';
    }
  } catch { /* table might not exist */ }
  return 'None';
}

export async function getUserMessageCount7d(userId: string): Promise<number> {
  const db = await getTypedClient();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  const asnap = schema.analyticsSnapshots;
  const rows = await db
    .select({ total: sql<number | string>`coalesce(sum(${asnap.messages_sent}), 0)` })
    .from(asnap)
    .where(and(eq(asnap.user_id, userId), gte(asnap.snapshot_date, cutoffStr)));
  const total = Number(rows[0]?.total ?? 0);
  if (total > 0) return total;

  // Fallback: count from cowork_messages
  try {
    const weekAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
    const cm = schema.coworkMessages;
    const coworkRows = await db
      .select({ count: sql<number | string>`count(*)` })
      .from(cm)
      .where(and(eq(cm.user_id, userId), gte(cm.occurred_at, weekAgo)));
    return Number(coworkRows[0]?.count ?? 0);
  } catch { return 0; }
}

export async function getUserAlerts(userId: string): Promise<Alert[]> {
  const db = await getTypedClient();
  const a = schema.alerts;
  const rows = await db.select().from(a).where(eq(a.user_id, userId)).orderBy(desc(a.generated_at));
  return rows.map((r) => ({ ...r, raw_evidence: jsonToText(r.raw_evidence) })) as Alert[];
}

// ─── Batch user helpers (avoid N+1 on users list) ─────────────────────────

export async function getAllUserMessageCounts7d(): Promise<Map<string, number>> {
  const db = await getTypedClient();
  const result = new Map<string, number>();
  // App-clock cutoff string, 7 days back.
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  // Enterprise path. GROUP BY user_id — the only non-aggregated SELECT
  // column IS the group key itself, so no strictness fix needed.
  const asnap = schema.analyticsSnapshots;
  const rows = await db
    .select({ user_id: asnap.user_id, total: sql<number | string>`coalesce(sum(${asnap.messages_sent}), 0)` })
    .from(asnap)
    .where(gte(asnap.snapshot_date, cutoffStr))
    .groupBy(asnap.user_id);
  for (const row of rows) {
    const total = Number(row.total);
    if (total > 0) result.set(row.user_id as string, total);
  }

  // Fallback: cowork_messages for users not in analytics
  try {
    const weekAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
    const cm = schema.coworkMessages;
    const coworkRows = await db
      .select({ user_id: cm.user_id, count: sql<number | string>`count(*)` })
      .from(cm)
      .where(gte(cm.occurred_at, weekAgo))
      .groupBy(cm.user_id);
    for (const row of coworkRows) {
      const uid = row.user_id as string;
      if (!result.has(uid)) result.set(uid, Number(row.count));
    }
  } catch { /* table might not exist */ }

  return result;
}

export async function getAllUserOpenAlertCounts(): Promise<Map<string, number>> {
  const db = await getTypedClient();
  const a = schema.alerts;
  const rows = await db
    .select({ user_id: a.user_id, count: sql<number | string>`count(*)` })
    .from(a)
    .where(and(eq(a.status, 'open'), isNotNull(a.user_id)))
    .groupBy(a.user_id);
  const result = new Map<string, number>();
  for (const row of rows) {
    if (row.user_id) result.set(row.user_id, Number(row.count));
  }
  return result;
}

export async function getAllUserPrimarySurfaces(): Promise<Map<string, string>> {
  const db = await getTypedClient();
  const result = new Map<string, string>();
  // App-clock cutoff string, 7 days back.
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  // GROUP BY user_id — the only non-aggregated SELECT column IS the group key.
  const asnap = schema.analyticsSnapshots;
  const rows = await db
    .select({
      user_id: asnap.user_id,
      chat: sql<number | string>`sum(${asnap.surface_chat})`,
      code: sql<number | string>`sum(${asnap.surface_code})`,
      cowork: sql<number | string>`sum(${asnap.surface_cowork})`,
    })
    .from(asnap)
    .where(gte(asnap.snapshot_date, cutoffStr))
    .groupBy(asnap.user_id);

  for (const row of rows) {
    const chat = Number(row.chat ?? 0);
    const code = Number(row.code ?? 0);
    const cowork = Number(row.cowork ?? 0);
    const max = Math.max(chat, code, cowork);
    if (max > 0) {
      result.set(row.user_id as string, max === code ? 'Code' : max === cowork ? 'Cowork' : 'Chat');
    }
  }

  // Fallback: for users not in analytics, count per surface from cowork_messages + chat_messages
  try {
    const weekAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
    const cm = schema.coworkMessages;

    // cowork_messages split by surface (code vs cowork). GROUP BY user_id,
    // surface — both are group keys, both selected bare, compliant.
    const coworkRows = await db
      .select({ user_id: cm.user_id, surface: cm.surface, count: sql<number | string>`count(*)` })
      .from(cm)
      .where(gte(cm.occurred_at, weekAgo))
      .groupBy(cm.user_id, cm.surface);

    const fallbackCounts = new Map<string, { code: number; cowork: number; chat: number }>();
    for (const row of coworkRows) {
      const uid = row.user_id as string;
      if (result.has(uid)) continue;
      const c = fallbackCounts.get(uid) ?? { code: 0, cowork: 0, chat: 0 };
      const count = Number(row.count);
      if (row.surface === 'code') c.code += count;
      else if (row.surface === 'cowork') c.cowork += count;
      fallbackCounts.set(uid, c);
    }

    // chat_messages
    const cmsg = schema.chatMessages;
    const chatRows = await db
      .select({ user_id: cmsg.user_id, count: sql<number | string>`count(*)` })
      .from(cmsg)
      .where(gte(cmsg.occurred_at, weekAgo))
      .groupBy(cmsg.user_id);
    for (const row of chatRows) {
      const uid = row.user_id as string;
      if (result.has(uid)) continue;
      const c = fallbackCounts.get(uid) ?? { code: 0, cowork: 0, chat: 0 };
      c.chat += Number(row.count);
      fallbackCounts.set(uid, c);
    }

    // Pick the winning surface per user
    for (const [uid, counts] of fallbackCounts) {
      const max = Math.max(counts.code, counts.cowork, counts.chat);
      if (max > 0) {
        result.set(uid, max === counts.code ? 'Code' : max === counts.cowork ? 'Cowork' : 'Chat');
      }
    }
  } catch { /* table might not exist */ }

  return result;
}

export async function getAllUserAdoptionHealth(): Promise<Map<string, 'active' | 'shallow' | 'inactive'>> {
  const db = await getTypedClient();
  const result = new Map<string, 'active' | 'shallow' | 'inactive'>();
  // App-clock cutoff string, 14 days back.
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 14);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  // GROUP BY user_id — the only non-aggregated SELECT column IS the group key.
  const asnap = schema.analyticsSnapshots;
  const rows = await db
    .select({
      user_id: asnap.user_id,
      total_messages: sql<number | string>`sum(${asnap.messages_sent})`,
      uses_code: sql<number | string>`max(case when ${asnap.surface_code} > 0 then 1 else 0 end)`,
      uses_cowork: sql<number | string>`max(case when ${asnap.surface_cowork} > 0 then 1 else 0 end)`,
    })
    .from(asnap)
    .where(gte(asnap.snapshot_date, cutoffStr))
    .groupBy(asnap.user_id);

  for (const row of rows) {
    const totalMessages = Number(row.total_messages ?? 0);
    const usesCode = Number(row.uses_code ?? 0);
    const usesCowork = Number(row.uses_cowork ?? 0);
    const uid = row.user_id as string;
    if (totalMessages < 5) result.set(uid, 'inactive');
    else if (!usesCode && !usesCowork) result.set(uid, 'shallow');
    else result.set(uid, 'active');
  }

  // Fallback: cowork_messages for users not in analytics
  try {
    const twoWeeksAgo = Math.floor(Date.now() / 1000) - 14 * 86400;
    const cm = schema.coworkMessages;
    const coworkRows = await db
      .select({ user_id: cm.user_id, count: sql<number | string>`count(*)` })
      .from(cm)
      .where(gte(cm.occurred_at, twoWeeksAgo))
      .groupBy(cm.user_id);
    for (const row of coworkRows) {
      const uid = row.user_id as string;
      if (!result.has(uid)) {
        const count = Number(row.count);
        result.set(uid, count >= 5 ? 'active' : count > 0 ? 'shallow' : 'inactive');
      }
    }
  } catch { /* table might not exist */ }

  return result;
}

// ─── Department breakdown (for heatmap) ───────────────────────────────────

export interface DepartmentStats {
  department: string;
  user_count: number;
  active_users: number;
  surface_chat: number;
  surface_code: number;
  surface_cowork: number;
}

export async function getDepartmentBreakdown(): Promise<DepartmentStats[]> {
  const db = await getTypedClient();
  const weekAgo = Math.floor(Date.now() / 1000) - 7 * 86400;

  // Count distinct users per department who have used each surface in the
  // last 7 days. Kept as raw SQL (three aliased LEFT JOIN derived tables —
  // already aliased `chat`/`code`/`cowork` in the original, so no unaliased-
  // subquery fix needed here). GROUP BY audit: `COALESCE(u.department,
  // 'Unassigned') as department` is a pure function of the GROUP BY column
  // itself (u.department) — allowed under Postgres strict mode without extra
  // GROUP BY entries; every other SELECT item is a COUNT(DISTINCT ...)
  // aggregate. ORDER BY references the same aggregate expressions directly
  // (not an alias).
  const query = sql`
    SELECT
      COALESCE(u.department, 'Unassigned') as department,
      COUNT(DISTINCT u.id) as user_count,
      COUNT(DISTINCT CASE WHEN u.last_seen_at >= ${weekAgo} THEN u.id END) as active_users,
      COUNT(DISTINCT chat.user_id) as surface_chat,
      COUNT(DISTINCT code.user_id) as surface_code,
      COUNT(DISTINCT cowork.user_id) as surface_cowork
    FROM users u
    LEFT JOIN (
      SELECT DISTINCT user_id FROM chat_messages WHERE occurred_at >= ${weekAgo}
    ) chat ON u.id = chat.user_id
    LEFT JOIN (
      SELECT DISTINCT user_id FROM cowork_messages WHERE surface = 'code' AND occurred_at >= ${weekAgo}
    ) code ON u.id = code.user_id
    LEFT JOIN (
      SELECT DISTINCT user_id FROM cowork_messages WHERE surface = 'cowork' AND occurred_at >= ${weekAgo}
    ) cowork ON u.id = cowork.user_id
    WHERE u.department IS NOT NULL
    GROUP BY u.department
    ORDER BY (COUNT(DISTINCT chat.user_id) + COUNT(DISTINCT code.user_id) + COUNT(DISTINCT cowork.user_id)) DESC
  `;
  const rows = await rawAll<{
    department: string; user_count: number | string; active_users: number | string;
    surface_chat: number | string; surface_code: number | string; surface_cowork: number | string;
  }>(db, query);
  // count/bigint->Number (Policy B): COUNT(DISTINCT ...) comes back as a
  // string on pg.
  return rows.map((r) => ({
    department: r.department,
    user_count: Number(r.user_count),
    active_users: Number(r.active_users),
    surface_chat: Number(r.surface_chat),
    surface_code: Number(r.surface_code),
    surface_cowork: Number(r.surface_cowork),
  }));
}

// ─── Top users leaderboard ────────────────────────────────────────────────

export interface TopUser {
  id: string;
  display_name: string | null;
  email: string;
  department: string | null;
  total_activity: number;
  surface_chat: number;
  surface_code: number;
  surface_cowork: number;
}

export async function getTopUsers(limit: number = 5): Promise<TopUser[]> {
  const db = await getTypedClient();
  // App-clock cutoff string, 7 days back.
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  // Try analytics_snapshots first (Enterprise mode). GROUP BY audit: the
  // original grouped by u.id alone and selected u.display_name/u.email/
  // u.department bare — valid under Postgres's primary-key functional-
  // dependency extension (u.id is the users PK) but that's a Postgres-only
  // extension, so the three columns are added to GROUP BY explicitly here
  // to hold under strict-GROUP-BY semantics generally, with no behaviour
  // change (they're already 1:1 with u.id).
  const analyticsQuery = sql`
    SELECT
      u.id, u.display_name, u.email, u.department,
      COALESCE(SUM(a.surface_chat), 0) + COALESCE(SUM(a.surface_code), 0) + COALESCE(SUM(a.surface_cowork), 0) as total_activity,
      COALESCE(SUM(a.surface_chat), 0) as surface_chat,
      COALESCE(SUM(a.surface_code), 0) as surface_code,
      COALESCE(SUM(a.surface_cowork), 0) as surface_cowork
    FROM users u
    JOIN analytics_snapshots a ON u.id = a.user_id AND a.snapshot_date >= ${cutoffStr}
    GROUP BY u.id, u.display_name, u.email, u.department
    ORDER BY total_activity DESC
    LIMIT ${limit}
  `;
  const analyticsRows = await rawAll<{
    id: string; display_name: string | null; email: string; department: string | null;
    total_activity: number | string; surface_chat: number | string; surface_code: number | string; surface_cowork: number | string;
  }>(db, analyticsQuery);

  // count/bigint->Number (Policy B): SUM() results come back as strings on pg.
  if (analyticsRows.length > 0) {
    return analyticsRows.map((r) => ({
      id: r.id, display_name: r.display_name, email: r.email, department: r.department,
      total_activity: Number(r.total_activity),
      surface_chat: Number(r.surface_chat),
      surface_code: Number(r.surface_code),
      surface_cowork: Number(r.surface_cowork),
    }));
  }

  // Fallback: derive from messages (Max mode). App-clock weekAgo param.
  try {
    const weekAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
    const fallbackQuery = sql`
      SELECT
        u.id, u.display_name, u.email, u.department,
        COALESCE(chat.cnt, 0) + COALESCE(code.cnt, 0) + COALESCE(cowork.cnt, 0) as total_activity,
        COALESCE(chat.cnt, 0) as surface_chat,
        COALESCE(code.cnt, 0) as surface_code,
        COALESCE(cowork.cnt, 0) as surface_cowork
      FROM users u
      LEFT JOIN (
        SELECT user_id, COUNT(*) as cnt FROM chat_messages WHERE occurred_at >= ${weekAgo} GROUP BY user_id
      ) chat ON u.id = chat.user_id
      LEFT JOIN (
        SELECT user_id, COUNT(*) as cnt FROM cowork_messages WHERE surface = 'code' AND occurred_at >= ${weekAgo} GROUP BY user_id
      ) code ON u.id = code.user_id
      LEFT JOIN (
        SELECT user_id, COUNT(*) as cnt FROM cowork_messages WHERE surface = 'cowork' AND occurred_at >= ${weekAgo} GROUP BY user_id
      ) cowork ON u.id = cowork.user_id
      WHERE COALESCE(chat.cnt, 0) + COALESCE(code.cnt, 0) + COALESCE(cowork.cnt, 0) > 0
      ORDER BY total_activity DESC
      LIMIT ${limit}
    `;
    const rows = await rawAll<{
      id: string; display_name: string | null; email: string; department: string | null;
      total_activity: number | string; surface_chat: number | string; surface_code: number | string; surface_cowork: number | string;
    }>(db, fallbackQuery);
    return rows.map((r) => ({
      id: r.id, display_name: r.display_name, email: r.email, department: r.department,
      total_activity: Number(r.total_activity),
      surface_chat: Number(r.surface_chat),
      surface_code: Number(r.surface_code),
      surface_cowork: Number(r.surface_cowork),
    }));
  } catch { return []; }
}

// ─── Security posture metrics ─────────────────────────────────────────────

export interface SecurityMetrics {
  openAlerts: number;
  resolvedThisWeek: number;
  newThisWeek: number;
  severityCritical: number;
  severityHigh: number;
  severityMedium: number;
  severityLow: number;
  topCategory: string | null;
  topCategoryCount: number;
  topCategoryType: string | null;
}

export async function getEventsLast24hCombined(): Promise<number> {
  const db = await getTypedClient();
  const dayAgo = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
  const ce = schema.complianceEvents;
  const oe = schema.otelEvents;

  const [complianceRows, otelRows] = await Promise.all([
    db.select({ count: sql<number | string>`count(*)` }).from(ce).where(gte(ce.ingested_at, dayAgo)),
    db
      .select({ count: sql<number | string>`count(*)` })
      .from(oe)
      .where(
        and(
          gte(oe.occurred_at, dayAgo),
          or(isNull(oe.event_type), notInArray(oe.event_type, ['process_snapshot', 'agent_heartbeat']))
        )
      ),
  ]);

  return Number(complianceRows[0]?.count ?? 0) + Number(otelRows[0]?.count ?? 0);
}

export async function getSecurityMetrics(): Promise<SecurityMetrics> {
  const db = await getTypedClient();
  const a = schema.alerts;
  const weekAgo = Math.floor(Date.now() / 1000) - 7 * 86400;

  const openAlertsRows = await db.select({ c: sql<number | string>`count(*)` }).from(a).where(eq(a.status, 'open'));
  const openAlerts = Number(openAlertsRows[0]?.c ?? 0);

  const resolvedRows = await db
    .select({ c: sql<number | string>`count(*)` })
    .from(a)
    .where(and(inArray(a.status, ['resolved', 'dismissed']), gte(a.resolved_at, weekAgo)));
  const resolvedThisWeek = Number(resolvedRows[0]?.c ?? 0);

  const newRows = await db.select({ c: sql<number | string>`count(*)` }).from(a).where(gte(a.generated_at, weekAgo));
  const newThisWeek = Number(newRows[0]?.c ?? 0);

  // Severity split for open alerts
  const severityRows = await db
    .select({ severity: a.severity, c: sql<number | string>`count(*)` })
    .from(a)
    .where(eq(a.status, 'open'))
    .groupBy(a.severity);
  const severityMap: Record<string, number> = {};
  for (const row of severityRows) severityMap[row.severity] = Number(row.c);
  const severityCritical = severityMap['critical'] || 0;
  const severityHigh = severityMap['high'] || 0;
  const severityMedium = severityMap['medium'] || 0;
  const severityLow = severityMap['low'] || 0;

  // Most common alert category from open alerts — PII type or intent category.
  // Extraction via the jsonb `->>` operator (raw table/column names, matching
  // the rawAll convention used elsewhere in this file). GROUP BY the full
  // extracted expression rather than a bare alias/column — Postgres strict
  // mode rejects selecting `alert_type` without it being aggregated or in
  // GROUP BY, so it's wrapped in MAX() (this is a display-only "any
  // representative alert_type for the winning category" value).
  const piiExpr = sql`raw_evidence->>'pii_type'`;
  const intentExpr = sql`raw_evidence->>'intent_category'`;
  const categoryExpr = sql`COALESCE(${piiExpr}, ${intentExpr})`;

  const topAlertQuery = sql`
    SELECT ${categoryExpr} AS category, MAX(alert_type) AS alert_type, count(*) AS c
    FROM alerts
    WHERE status = 'open' AND (${piiExpr} IS NOT NULL OR ${intentExpr} IS NOT NULL)
    GROUP BY ${categoryExpr}
    ORDER BY c DESC
    LIMIT 1
  `;
  const topAlertRows = await rawAll<{ category: string | null; alert_type: string | null; c: number | string }>(
    db,
    topAlertQuery,
  );
  const topAlert = topAlertRows[0];

  const topCategory = topAlert?.category || null;
  const topCategoryCount = Number(topAlert?.c ?? 0);
  const topCategoryType = topAlert?.alert_type || null;

  return {
    openAlerts,
    resolvedThisWeek,
    newThisWeek,
    severityCritical,
    severityHigh,
    severityMedium,
    severityLow,
    topCategory,
    topCategoryCount,
    topCategoryType,
  };
}

// ─── Cowork Messages ─────────────────────────────────────────────────────

export interface CoworkMessage {
  id: string;
  session_id: string;
  user_id: string | null;
  agent_id: string | null;
  message_type: string;
  role: string | null;
  content_preview: string | null;
  content_full: string | null;
  tool_name: string | null;
  tool_input_preview: string | null;
  tool_output_preview: string | null;
  token_usage: string | null;
  model: string | null;
  flagged: number;
  flag_reason: string | null;
  occurred_at: number;
  ingested_at: number;
  surface: string;
}

export interface CoworkSession {
  id: string;
  conversation_id: string;
  org_id: string | null;
  user_id: string | null;
  agent_id: string | null;
  session_name: string | null;
  model: string | null;
  initial_message: string | null;
  user_selected_folders: string | null;
  tools_available: string | null;
  mcp_servers: string | null;
  git_diff_summary: string | null;
  git_diff_full: string | null;
  files_changed: number;
  started_at: number | null;
  ended_at: number | null;
  created_at: number;
  files_touched?: string[] | string | null;
  project_name?: string | null;
}

// insertCoworkMessage and upsertCoworkSession have no app caller since the
// retired agent's ingest routes were removed; the tests use them as fixture
// writers. The OTel receivers write these tables directly.
export async function insertCoworkMessage(msg: Omit<CoworkMessage, 'ingested_at'>): Promise<void> {
  const db = await getTypedClient();
  const t = schema.coworkMessages;
  await db
    .insert(t)
    .values({
      id: msg.id,
      session_id: msg.session_id,
      user_id: msg.user_id,
      agent_id: msg.agent_id,
      message_type: msg.message_type,
      role: msg.role,
      content_preview: msg.content_preview,
      content_full: msg.content_full,
      tool_name: msg.tool_name,
      tool_input_preview: msg.tool_input_preview,
      tool_output_preview: msg.tool_output_preview,
      // Policy A write inverse: parse the JSON string for pg's jsonb codec.
      token_usage: textToJsonValue(msg.token_usage) as never,
      model: msg.model,
      flagged: msg.flagged,
      flag_reason: msg.flag_reason,
      occurred_at: msg.occurred_at,
      surface: msg.surface || 'cowork',
    })
    // INSERT OR IGNORE equivalent — Drizzle's onConflictDoNothing() emits
    // Postgres `ON CONFLICT DO NOTHING`.
    .onConflictDoNothing();
}

export async function upsertCoworkSession(session: Partial<CoworkSession> & { id: string; conversation_id: string }): Promise<void> {
  const db = await getTypedClient();
  const t = schema.coworkSessions;

  // jsonb columns: hand Drizzle the raw value (its jsonb codec serialises it).
  const jsonbCol = (v: unknown): unknown =>
    v === null || v === undefined ? null : v;
  // files_touched is a TEXT column — always store the JSON text.
  const filesText = session.files_touched != null ? JSON.stringify(session.files_touched) : null;

  // Deduplicating JSON-array merge on conflict: cast the TEXT to jsonb and use
  // jsonb_array_elements_text/jsonb_agg (table-valued functions).
  const filesMerge = sql`CASE
        WHEN excluded.files_touched IS NULL THEN ${t.files_touched}
        WHEN ${t.files_touched} IS NULL THEN excluded.files_touched
        ELSE (
          SELECT jsonb_agg(DISTINCT v)::text FROM (
            SELECT jsonb_array_elements_text(${t.files_touched}::jsonb) AS v
            UNION
            SELECT jsonb_array_elements_text(excluded.files_touched::jsonb) AS v
          ) s
        )
      END`;

  await db
    .insert(t)
    .values({
      id: session.id,
      conversation_id: session.conversation_id,
      org_id: session.org_id ?? null,
      user_id: session.user_id ?? null,
      agent_id: session.agent_id ?? null,
      session_name: session.session_name ?? null,
      model: session.model ?? null,
      initial_message: session.initial_message ?? null,
      user_selected_folders: jsonbCol(session.user_selected_folders) as never,
      tools_available: jsonbCol(session.tools_available) as never,
      mcp_servers: jsonbCol(session.mcp_servers) as never,
      git_diff_summary: session.git_diff_summary ?? null,
      git_diff_full: session.git_diff_full ?? null,
      files_changed: session.files_changed ?? 0,
      started_at: session.started_at ?? null,
      ended_at: session.ended_at ?? null,
      files_touched: filesText,
      project_name: session.project_name ?? null,
    })
    .onConflictDoUpdate({
      target: t.id,
      set: {
        user_id: sql`COALESCE(excluded.user_id, ${t.user_id})`,
        started_at: sql`COALESCE(excluded.started_at, ${t.started_at})`,
        ended_at: sql`COALESCE(excluded.ended_at, ${t.ended_at})`,
        git_diff_summary: sql`COALESCE(excluded.git_diff_summary, ${t.git_diff_summary})`,
        git_diff_full: sql`COALESCE(excluded.git_diff_full, ${t.git_diff_full})`,
        files_changed: sql`COALESCE(excluded.files_changed, ${t.files_changed})`,
        files_touched: filesMerge,
        project_name: sql`COALESCE(excluded.project_name, ${t.project_name})`,
      },
    });
}

const COWORK_MESSAGES_EXCLUDED_TYPES = [
  'cowork_api_request', 'cowork_api_error', 'cowork_tool_summary',
  'cowork_message', 'cowork_session_init', 'cowork_tool_metadata',
];

export async function getCoworkMessages(sessionId: string, limit: number = 100): Promise<CoworkMessage[]> {
  const db = await getTypedClient();
  const t = schema.coworkMessages;
  const rows = await db
    .select()
    .from(t)
    .where(and(eq(t.session_id, sessionId), notInArray(t.message_type, COWORK_MESSAGES_EXCLUDED_TYPES)))
    .orderBy(asc(t.occurred_at))
    .limit(limit);
  // Policy A: token_usage normalised to a JSON string.
  return rows.map((r) => ({ ...r, token_usage: jsonToText(r.token_usage) })) as CoworkMessage[];
}

export async function getRecentCoworkSessions(limit: number = 20): Promise<CoworkSession[]> {
  const db = await getTypedClient();
  const t = schema.coworkSessions;
  const rows = await db.select().from(t).orderBy(desc(t.created_at)).limit(limit);
  // Policy A: first read site for these three jsonb columns (write-side
  // handling already lives in upsertCoworkSession) — normalise to
  // a JSON string, same as every other jsonb column in
  // this migration.
  return rows.map((r) => ({
    ...r,
    user_selected_folders: jsonToText(r.user_selected_folders),
    tools_available: jsonToText(r.tools_available),
    mcp_servers: jsonToText(r.mcp_servers),
  })) as CoworkSession[];
}

export async function getCoworkMessageCount(): Promise<number> {
  const db = await getTypedClient();
  const t = schema.coworkMessages;
  const rows = await db.select({ count: sql<number | string>`count(*)` }).from(t);
  return Number(rows[0]?.count ?? 0);
}

export async function hasCoworkContent(): Promise<boolean> {
  const db = await getTypedClient();
  const t = schema.coworkMessages;
  const rows = await db.select({ one: sql<number>`1` }).from(t).limit(1);
  return rows.length > 0;
}

// ─── GDPR & Data Governance ──────────────────────────────────────────────

/**
 * Export all data for a user (GDPR right of access).
 */
export async function exportUserData(userId: string): Promise<{
  export_date: string;
  user: User;
  cowork_messages: CoworkMessage[];
  chat_messages: (typeof schema.chatMessages.$inferSelect)[];
  chat_reply_metadata: (typeof schema.chatAssistantMeta.$inferSelect)[];
  otel_events: OtelEvent[];
  compliance_events: ComplianceEvent[];
  analytics_snapshots: AnalyticsSnapshot[];
  alerts: Alert[];
} | null> {
  const db = await getTypedClient();
  const u = schema.users;

  const userRows = await db.select().from(u).where(eq(u.id, userId)).limit(1);
  const user = userRows[0] as User | undefined;
  if (!user) return null;

  const cm = schema.coworkMessages;
  const oe = schema.otelEvents;
  const ce = schema.complianceEvents;
  const asnap = schema.analyticsSnapshots;
  const al = schema.alerts;
  const chm = schema.chatMessages;
  const cam = schema.chatAssistantMeta;

  // Claude Chat prompts and the metadata kept for Claude's replies (never the reply text).
  const [chatMessages, chatReplyMeta] = await Promise.all([
    db.select().from(chm).where(eq(chm.user_id, userId)).orderBy(desc(chm.occurred_at)),
    db.select().from(cam).where(eq(cam.user_id, userId)).orderBy(desc(cam.occurred_at)),
  ]);
  const [coworkMessages, otelEvents, complianceEvents, analyticsSnapshots, alerts] = await Promise.all([
    db.select().from(cm).where(eq(cm.user_id, userId)).orderBy(desc(cm.occurred_at)),
    db.select().from(oe).where(eq(oe.user_id, userId)).orderBy(desc(oe.occurred_at)),
    db.select().from(ce).where(eq(ce.user_id, userId)).orderBy(desc(ce.occurred_at)),
    db.select().from(asnap).where(eq(asnap.user_id, userId)).orderBy(desc(asnap.snapshot_date)),
    db.select().from(al).where(eq(al.user_id, userId)).orderBy(desc(al.generated_at)),
  ]);

  return {
    export_date: new Date().toISOString(),
    user,
    // Policy A: every jsonb column normalised to a JSON string, matching the app's pre-existing `string | null` contract for
    // these fields (getCoworkMessages/getRecentComplianceEvents/getAlerts).
    cowork_messages: coworkMessages.map((r) => ({ ...r, token_usage: jsonToText(r.token_usage) })) as CoworkMessage[],
    chat_messages: chatMessages,
    chat_reply_metadata: chatReplyMeta,
    otel_events: otelEvents.map((r) => ({
      ...r,
      tool_input: jsonToText(r.tool_input),
      token_usage: jsonToText(r.token_usage),
      file_paths: jsonToText(r.file_paths),
    })) as OtelEvent[],
    compliance_events: complianceEvents.map((r) => ({ ...r, metadata: jsonToText(r.metadata) })) as ComplianceEvent[],
    analytics_snapshots: analyticsSnapshots as AnalyticsSnapshot[],
    alerts: alerts.map((r) => ({ ...r, raw_evidence: jsonToText(r.raw_evidence) })) as Alert[],
  };
}

/**
 * Delete all data for a user (GDPR right to erasure).
 * Wrapped in a transaction — all-or-nothing.
 * Returns counts of deleted rows per table.
 */
export async function deleteUserData(userId: string): Promise<{
  cowork_messages: number;
  cowork_sessions: number;
  otel_events: number;
  compliance_events: number;
  analytics_snapshots: number;
  alerts: number;
} | null> {
  const client = await getTypedClient();
  const u = schema.users;

  // Check user exists — also resolve a human-readable label now, before
  // deletion wipes it, so the GDPR alert below doesn't read as a bare UUID.
  const userRows = await client.select({ id: u.id, display_name: u.display_name, email: u.email }).from(u).where(eq(u.id, userId)).limit(1);
  if (userRows.length === 0) return null;
  const personLabel = userRows[0].display_name || userRows[0].email || userId;

  const counts = { chat_messages: 0, cowork_messages: 0, cowork_sessions: 0, otel_events: 0, compliance_events: 0, analytics_snapshots: 0, alerts: 0 };

  // SAVEPOINT ISOLATION on Postgres (compliance-critical). The ~9 DELETEs/UPDATEs below tolerate a
  // per-statement failure without aborting the whole erasure. On Postgres the
  // FIRST error would otherwise poison the whole transaction and every LATER delete would
  // be skipped — a GDPR right-to-erasure hazard: rows the user believes were
  // deleted would survive. `savepointEach` gives each tolerated statement its
  // own SAVEPOINT on Postgres (a throw rolls back only that savepoint, prior
  // rows + the outer transaction stay intact) (see lib/db/savepoint.ts +
  // test/tx-savepoint-semantics.test.ts — proven there,
  // exercised here).
  //
  // GDPR: tolerance is now BOUNDED. Previously both
  // savepointEach() results were discarded — an op that failed (e.g. a typo'd
  // WHERE clause, a future migration dropping a column) would silently commit
  // the transaction anyway, so deleteUserData's caller (and its docstring's
  // all-or-nothing contract) had no way to know the erasure was partial. Every
  // table these ops touch exists in the real migrations and every test
  // fixture that calls this function (verified — see test/queries-cowork-
  // chat-gdpr-pg.test.ts's fixture DDL list), so the tolerance was never load-
  // bearing for a missing/optional table; it existed only for the Postgres-
  // abort-poisons-the-whole-tx hazard described above. We keep savepointEach
  // (still required so one op's failure doesn't hide a LATER op's success on
  // Postgres) but now inspect both results and throw if either reports any
  // error, aborting the whole outer transaction — no partial erasure can
  // commit silently.
  await withTx(client, async (tx) => {
    // Create audit alert BEFORE deletion (user_id = null so it survives).
    const alertId = crypto.randomUUID();
    const nowS = Math.floor(Date.now() / 1000);
    await tx.insert(schema.alerts).values({
      id: alertId,
      user_id: null,
      alert_type: 'policy',
      severity: 'medium',
      title: 'User data erased (GDPR)',
      explanation: `All data for ${personLabel} (${userId}) permanently deleted by admin on ${new Date().toISOString()}. Reason: GDPR erasure request.`,
      status: 'open',
      generated_at: nowS,
    });

    // Deletion order matters: child tables must be cleared before their
    // parents. cowork_messages is a parent of pulse_classifications,
    // pulse_events, pulse_skill_runs — those MUST go first or the
    // cowork_messages delete fails (Postgres enforces FKs strictly).

    // 1+2. Deepest children of cowork_messages, then other Pulse tables that
    // reference users directly — all tolerated (savepointEach), preserving
    // the original try/catch's error tolerance per statement.
    type Op = (h: typeof tx) => Promise<void>;
    const preOps: Op[] = [
      async (h) => { await h.delete(schema.pulseSkillRuns).where(eq(schema.pulseSkillRuns.user_id, userId)); },
      async (h) => { await h.delete(schema.pulseClassifications).where(eq(schema.pulseClassifications.user_id, userId)); },
      async (h) => { await h.delete(schema.pulseEvents).where(eq(schema.pulseEvents.user_id, userId)); },
      async (h) => { await h.update(schema.pulseSkills).set({ author_user_id: null }).where(eq(schema.pulseSkills.author_user_id, userId)); },
      async (h) => { await h.delete(schema.pulseTeamAssessments).where(eq(schema.pulseTeamAssessments.assessed_by, userId)); },
      async (h) => { await h.delete(schema.pulseBaselines).where(eq(schema.pulseBaselines.set_by, userId)); },
      async (h) => { await h.delete(schema.pulseMetrics).where(and(eq(schema.pulseMetrics.scope_type, 'user'), eq(schema.pulseMetrics.scope_id, userId))); },
      async (h) => { counts.chat_messages = rowsAffected(await h.delete(schema.chatMessages).where(eq(schema.chatMessages.user_id, userId))); },
      // Blocker-class NO ACTION FKs: these must go
      // before the users row or the whole erasure fails on the constraint.
      // NOTE: these load-bearing deletes are tolerated (savepointEach) by
      // function convention; if one fails, the core cowork_sessions/users
      // deletes throw on the same constraint and the whole tx aborts — no
      // partial erasure is possible.
      async (h) => { await h.delete(schema.coworkSessionStats).where(eq(schema.coworkSessionStats.user_id, userId)); },
      async (h) => { await h.delete(schema.coworkSessionDescriptions).where(eq(schema.coworkSessionDescriptions.user_id, userId)); },
      async (h) => { await h.delete(schema.useCaseSessionJudgements).where(eq(schema.useCaseSessionJudgements.user_id, userId)); },
      async (h) => { await h.delete(schema.chatAssistantMeta).where(eq(schema.chatAssistantMeta.user_id, userId)); },
      // github_unmatched_authors is identity-keyed, not user-keyed, and
      // self-rewrites every sync — deliberately not touched here.
      async (h) => { await h.delete(schema.githubUserRepoStats).where(eq(schema.githubUserRepoStats.user_id, userId)); },
      async (h) => { await h.delete(schema.githubIdentityMap).where(eq(schema.githubIdentityMap.user_id, userId)); },
      // Code-surface personal data. Classifications
      // before session stats (same-session children), then the raw tables.
      async (h) => { await h.delete(schema.codeSessionClassifications).where(eq(schema.codeSessionClassifications.user_id, userId)); },
      async (h) => { await h.delete(schema.codeSessionStats).where(eq(schema.codeSessionStats.user_id, userId)); },
      async (h) => { await h.delete(schema.codeAssistantMeta).where(eq(schema.codeAssistantMeta.user_id, userId)); },
      async (h) => { await h.delete(schema.codeOtelMetrics).where(eq(schema.codeOtelMetrics.user_id, userId)); },
      // user-scope metric rows only — org/dept aggregates are not personal data
      async (h) => { await h.delete(schema.codeMetrics).where(and(eq(schema.codeMetrics.scope_type, 'user'), eq(schema.codeMetrics.scope_id, userId))); },
      // GDPR: user-scope weekly briefing prose (contains the
      // person's display name, generated by lib/pulse/briefings/weekly.ts) —
      // org/dept-scope briefings are not personal data and survive.
      async (h) => { await h.delete(schema.pulseBriefings).where(and(eq(schema.pulseBriefings.scope_type, 'user'), eq(schema.pulseBriefings.scope_id, userId))); },
      // use-case ownership: null the attribution (mirrors pulse_skills), and
      // delete junction rows (user_id is in the PK — cannot be nulled; the
      // pre-aggregated weekly counts in use_case_activation_weeks survive).
      async (h) => { await h.update(schema.useCases).set({ owner_user_id: null }).where(eq(schema.useCases.owner_user_id, userId)); },
      async (h) => { await h.delete(schema.useCaseWeekMatches).where(eq(schema.useCaseWeekMatches.user_id, userId)); },
      // Coaching acknowledgements — FK ON DELETE CASCADE would
      // also cover this, but it's deleted explicitly here (same convention
      // as the rest of this list) rather than relied on implicitly.
      async (h) => { await h.delete(schema.coachingAcks).where(eq(schema.coachingAcks.user_id, userId)); },
      // OTel identity conflicts (migration 083 / PG 0024): conflicts naming the
      // person on either side, merge aliases pointing at them, and the alias
      // keyed by their own email (an email is personal data too).
      async (h) => { await h.delete(schema.otelIdentityConflicts).where(or(eq(schema.otelIdentityConflicts.existing_user_id, userId), eq(schema.otelIdentityConflicts.new_user_id, userId))); },
      async (h) => { await h.delete(schema.otelIdentityAliases).where(eq(schema.otelIdentityAliases.user_id, userId)); },
      async (h) => { if (userRows[0].email) await h.delete(schema.otelIdentityAliases).where(eq(schema.otelIdentityAliases.email, String(userRows[0].email).toLowerCase())); },
    ];
    const preResult = await savepointEach(tx, preOps, async (h, op) => { await op(h); });

    // 3. Core message / event tables (now safe — no more Pulse children
    // pointing at them). NOT tolerated — these must succeed for the erasure
    // to be considered complete, matching the original code (no try/catch).
    counts.cowork_messages = rowsAffected(await tx.delete(schema.coworkMessages).where(eq(schema.coworkMessages.user_id, userId)));
    counts.cowork_sessions = rowsAffected(await tx.delete(schema.coworkSessions).where(eq(schema.coworkSessions.user_id, userId)));
    // users.manager_id is a NO ACTION self-FK — erasing a manager must not
    // fail, and reports must not point at a deleted user.
    await tx.update(schema.users).set({ manager_id: null }).where(eq(schema.users.manager_id, userId));
    counts.otel_events = rowsAffected(await tx.delete(schema.otelEvents).where(eq(schema.otelEvents.user_id, userId)));
    counts.compliance_events = rowsAffected(await tx.delete(schema.complianceEvents).where(eq(schema.complianceEvents.user_id, userId)));
    counts.analytics_snapshots = rowsAffected(await tx.delete(schema.analyticsSnapshots).where(eq(schema.analyticsSnapshots.user_id, userId)));
    counts.alerts = rowsAffected(await tx.delete(schema.alerts).where(eq(schema.alerts.user_id, userId)));

    // 4. Agent records (agents.user_id → users.id, no CASCADE) — tolerated.
    const postOps: Op[] = [
      async (h) => { await h.delete(schema.agents).where(eq(schema.agents.user_id, userId)); },
    ];
    const postResult = await savepointEach(tx, postOps, async (h, op) => { await op(h); });

    // Any tolerated op that actually failed means erasure is INCOMPLETE —
    // abort the whole transaction rather than let it commit silently (see the
    // header comment above preOps for why bounded-not-unbounded tolerance is
    // now required).
    const allErrors = [...preResult.errors, ...postResult.errors];
    if (allErrors.length > 0) {
      const messages = allErrors.map((e) => (e.error instanceof Error ? e.error.message : String(e.error)));
      throw new Error(`erasure incomplete: ${allErrors.length} operation(s) failed during GDPR erasure for user ${userId}: ${messages.join('; ')}`);
    }

    // 5. Delete user row — CASCADE handles pulse_user_prefs,
    //    cowork_mcp_invocations, cowork_skill_invocations automatically.
    await tx.delete(schema.users).where(eq(schema.users.id, userId));
  });

  return counts;
}

/**
 * Get database health metrics for the settings panel.
 */
export async function getDbStats(): Promise<{
  fileSizeBytes: number;
  coworkCount: number;
  codeCount: number;
  coworkOnlyCount: number;
  otelCount: number;
  complianceCount: number;
  chatCount: number;
  userCount: number;
  latestOtelEventAt: number | null;
}> {
  const db = await getTypedClient();

  // Database size, queried from the server (there is no local file to stat).
  const sizeRows = await rawAll<{ size: number | string }>(db, sql`select pg_database_size(current_database()) as size`);
  const fileSizeBytes = Number(sizeRows[0]?.size ?? 0);

  const cm = schema.coworkMessages;
  const oe = schema.otelEvents;
  const ce = schema.complianceEvents;
  const u = schema.users;
  const chat = schema.chatMessages;

  const [coworkRows, otelRows, complianceRows, userRows, chatRows, codeRows, coworkOnlyRows, latestOtelRows, latestCoworkOtelRows] = await Promise.all([
    db.select({ count: sql<number | string>`count(*)` }).from(cm),
    db.select({ count: sql<number | string>`count(*)` }).from(oe),
    db.select({ count: sql<number | string>`count(*)` }).from(ce),
    db.select({ count: sql<number | string>`count(*)` }).from(u),
    db.select({ count: sql<number | string>`count(*)` }).from(chat),
    db.select({ count: sql<number | string>`count(*)` }).from(cm).where(eq(cm.surface, 'code')),
    db.select({ count: sql<number | string>`count(*)` }).from(cm).where(eq(cm.surface, 'cowork')),
    db.select({ ts: sql<number | string | null>`max(${oe.occurred_at})` }).from(oe),
    db.select({ ts: sql<number | string | null>`max(${cm.occurred_at})` }).from(cm).where(eq(cm.source, 'otel')),
  ]);

  const tsA = latestOtelRows[0]?.ts != null ? Number(latestOtelRows[0].ts) : null;
  const tsB = latestCoworkOtelRows[0]?.ts != null ? Number(latestCoworkOtelRows[0].ts) : null;
  const latestOtelEventAt = tsA === null && tsB === null ? null : Math.max(tsA ?? 0, tsB ?? 0);

  // Policy B: count() comes back as a string on pg — coerce.
  return {
    fileSizeBytes,
    coworkCount: Number(coworkRows[0]?.count ?? 0),
    codeCount: Number(codeRows[0]?.count ?? 0),
    coworkOnlyCount: Number(coworkOnlyRows[0]?.count ?? 0),
    otelCount: Number(otelRows[0]?.count ?? 0),
    complianceCount: Number(complianceRows[0]?.count ?? 0),
    chatCount: Number(chatRows[0]?.count ?? 0),
    userCount: Number(userRows[0]?.count ?? 0),
    latestOtelEventAt,
  };
}

// ─── Chat Messages ──────────────────────────────────────────────────────

export interface ChatMessage {
  id: string;
  conversation_id: string | null;
  user_id: string | null;
  prompt_text: string;
  prompt_length: number;
  attachments_count: number;
  files_count: number;
  flagged: number;
  flag_reason: string | null;
  occurred_at: number;
  ingested_at: number;
  agent_id: string | null;
}

export async function getChatMessages(filters: {
  userId?: string;
  conversationId?: string;
  flaggedOnly?: boolean;
  dateFrom?: number;
  dateTo?: number;
  limit?: number;
  offset?: number;
} = {}): Promise<ChatMessage[]> {
  const db = await getTypedClient();
  const cm = schema.chatMessages;
  const u = schema.users;

  const conditions = [];
  if (filters.userId) conditions.push(eq(cm.user_id, filters.userId));
  if (filters.conversationId) conditions.push(eq(cm.conversation_id, filters.conversationId));
  if (filters.flaggedOnly) conditions.push(eq(cm.flagged, 1));
  if (filters.dateFrom) conditions.push(gte(cm.occurred_at, filters.dateFrom));
  if (filters.dateTo) conditions.push(lte(cm.occurred_at, filters.dateTo));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const limit = filters.limit || 100;
  const offset = filters.offset || 0;

  const rows = await db
    .select({ message: cm, user_display_name: u.display_name })
    .from(cm)
    .leftJoin(u, eq(cm.user_id, u.id))
    .where(where)
    .orderBy(desc(cm.occurred_at))
    .limit(limit)
    .offset(offset);

  return rows.map((r) => ({ ...r.message, user_display_name: r.user_display_name })) as ChatMessage[];
}

export async function getChatMessageCount(): Promise<number> {
  const db = await getTypedClient();
  const cm = schema.chatMessages;
  const rows = await db.select({ count: sql<number | string>`count(*)` }).from(cm);
  return Number(rows[0]?.count ?? 0);
}

/** Flagged chat prompts — all time, or since `sinceUnix` (occurred_at >=) when given. */
export async function getChatFlaggedCount(sinceUnix?: number): Promise<number> {
  const db = await getTypedClient();
  const cm = schema.chatMessages;
  const where = sinceUnix === undefined ? eq(cm.flagged, 1) : and(eq(cm.flagged, 1), gte(cm.occurred_at, sinceUnix));
  const rows = await db.select({ count: sql<number | string>`count(*)` }).from(cm).where(where);
  return Number(rows[0]?.count ?? 0);
}

export async function getCoworkFlaggedCount(): Promise<number> {
  const db = await getTypedClient();
  const cm = schema.coworkMessages;
  const rows = await db
    .select({ count: sql<number | string>`count(*)` })
    .from(cm)
    .where(and(eq(cm.flagged, 1), eq(cm.surface, 'cowork')));
  return Number(rows[0]?.count ?? 0);
}

export async function getCodeFlaggedCount(): Promise<number> {
  const db = await getTypedClient();
  const cm = schema.coworkMessages;
  const rows = await db
    .select({ count: sql<number | string>`count(*)` })
    .from(cm)
    .where(and(eq(cm.flagged, 1), eq(cm.surface, 'code')));
  return Number(rows[0]?.count ?? 0);
}

/**
 * Average sessions per week per surface over the last 4 weeks, "active-weeks aware":
 * total sessions in the window ÷ weeks since that surface's first activity (capped at 4),
 * so a newly-active surface isn't diluted by empty pre-adoption weeks. One-decimal values.
 *   cowork → distinct cowork_messages.session_id (cowork surface)
 *   code   → code_session_stats rows (one row per session)
 *   chat   → distinct chat_messages.conversation_id
 */
export async function getAvgSessionsPerWeek(): Promise<{ cowork: number; code: number; chat: number }> {
  const db = await getTypedClient();
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - 28 * 24 * 3600;
  const WEEK = 7 * 24 * 3600;

  const avg = (count: number, firstSeen: number | null): number => {
    if (!count || firstSeen == null) return 0;
    const weeksActive = Math.min(4, Math.max(1, Math.ceil((now - firstSeen) / WEEK)));
    return Math.round((count / weeksActive) * 10) / 10;
  };

  const cm = schema.coworkMessages;
  const css = schema.codeSessionStats;
  const chat = schema.chatMessages;

  // No date-bucket/table-valued SQL here: plain
  // count()/min() aggregates via the query builder.
  const coworkFilter = and(or(eq(cm.surface, 'cowork'), isNull(cm.surface)), sql`${cm.session_id} != ''`);
  const chatFilter = and(isNotNull(chat.conversation_id), sql`${chat.conversation_id} != ''`);

  const [
    coworkCountRows, coworkFirstRows,
    codeCountRows, codeFirstRows,
    chatCountRows, chatFirstRows,
  ] = await Promise.all([
    db.select({ c: sql<number | string>`count(distinct ${cm.session_id})` }).from(cm).where(and(coworkFilter, gte(cm.occurred_at, windowStart))),
    db.select({ f: sql<number | string | null>`min(${cm.occurred_at})` }).from(cm).where(coworkFilter),
    db.select({ c: sql<number | string>`count(*)` }).from(css).where(gte(css.last_at, windowStart)),
    db.select({ f: sql<number | string | null>`min(${css.first_at})` }).from(css),
    db.select({ c: sql<number | string>`count(distinct ${chat.conversation_id})` }).from(chat).where(and(chatFilter, gte(chat.occurred_at, windowStart))),
    db.select({ f: sql<number | string | null>`min(${chat.occurred_at})` }).from(chat).where(chatFilter),
  ]);

  // Policy B: count()/min() come back as strings on pg — coerce.
  const toNum = (v: number | string | null | undefined): number | null => (v == null ? null : Number(v));
  const cowork = avg(Number(coworkCountRows[0]?.c ?? 0), toNum(coworkFirstRows[0]?.f));
  const code = avg(Number(codeCountRows[0]?.c ?? 0), toNum(codeFirstRows[0]?.f));
  const chatAvg = avg(Number(chatCountRows[0]?.c ?? 0), toNum(chatFirstRows[0]?.f));

  return { cowork, code, chat: chatAvg };
}

export async function getRecentCoworkMessages(limit: number = 100): Promise<Array<{
  user_id: string | null;
  surface: string;
  message_type: string;
  flagged: number;
  flag_reason: string | null;
  occurred_at: number;
}>> {
  const db = await getTypedClient();
  const cm = schema.coworkMessages;
  const rows = await db
    .select({
      user_id: cm.user_id,
      surface: sql<string>`coalesce(${cm.surface}, 'cowork')`,
      message_type: cm.message_type,
      flagged: cm.flagged,
      flag_reason: cm.flag_reason,
      occurred_at: cm.occurred_at,
    })
    .from(cm)
    .orderBy(desc(cm.occurred_at))
    .limit(limit);
  return rows as Array<{ user_id: string | null; surface: string; message_type: string; flagged: number; flag_reason: string | null; occurred_at: number }>;
}

export async function getRecentChatMessages(limit: number = 50): Promise<Array<{
  user_id: string | null;
  prompt_length: number;
  flagged: number;
  flag_reason: string | null;
  occurred_at: number;
}>> {
  const db = await getTypedClient();
  const chat = schema.chatMessages;
  const rows = await db
    .select({
      user_id: chat.user_id,
      prompt_length: chat.prompt_length,
      flagged: chat.flagged,
      flag_reason: chat.flag_reason,
      occurred_at: chat.occurred_at,
    })
    .from(chat)
    .orderBy(desc(chat.occurred_at))
    .limit(limit);
  return rows as Array<{ user_id: string | null; prompt_length: number; flagged: number; flag_reason: string | null; occurred_at: number }>;
}

export async function getCodeEventCount(): Promise<number> {
  const db = await getTypedClient();
  const cm = schema.coworkMessages;
  const weekAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
  const rows = await db
    .select({ count: sql<number | string>`count(*)` })
    .from(cm)
    .where(and(eq(cm.surface, 'code'), gte(cm.occurred_at, weekAgo)));
  return Number(rows[0]?.count ?? 0);
}

// ─── Cowork Project & File Analytics ─────────────────────────────────────

export async function getCoworkProjectStats(since: number): Promise<Array<{ project_name: string; session_count: number; user_count: number }>> {
  const db = await getTypedClient();
  const t = schema.coworkSessions;
  const rows = await db
    .select({
      project_name: t.project_name,
      session_count: sql<number>`count(*)`,
      user_count: sql<number>`count(distinct ${t.user_id})`,
    })
    .from(t)
    .where(and(isNotNull(t.project_name), gte(t.started_at, since)))
    .groupBy(t.project_name)
    .orderBy(sql`count(*) desc`)
    .limit(20);
  return rows.map((r) => ({
    project_name: r.project_name as string,
    session_count: Number(r.session_count),
    user_count: Number(r.user_count),
  }));
}

export async function getCoworkActiveProjectCount(since: number): Promise<number> {
  const db = await getTypedClient();
  const t = schema.coworkSessions;
  const rows = await db
    .select({ count: sql<number>`count(distinct ${t.project_name})` })
    .from(t)
    .where(and(isNotNull(t.project_name), gte(t.started_at, since)));
  return Number(rows[0]?.count ?? 0);
}

export async function getCoworkTopFiles(since: number, limit = 20): Promise<Array<{ file_path: string; session_count: number }>> {
  const db = await getTypedClient();
  // Table-valued JSON expansion over the TEXT files_touched column:
  // jsonb_array_elements_text(...::jsonb).
  const query = sql`SELECT je.value AS file_path, COUNT(DISTINCT cs.id) AS session_count
            FROM cowork_sessions cs
            CROSS JOIN LATERAL jsonb_array_elements_text(cs.files_touched::jsonb) AS je(value)
            WHERE cs.files_touched IS NOT NULL AND cs.started_at >= ${since}
            GROUP BY je.value
            ORDER BY session_count DESC
            LIMIT ${limit}`;
  const rows = await rawAll<{ file_path: string; session_count: number | string }>(db, query);
  return rows.map((r) => ({ file_path: String(r.file_path), session_count: Number(r.session_count) }));
}

export async function getCoworkUserProjects(userId: string, since: number): Promise<Array<{
  project_name: string; session_count: number; files: string[];
}>> {
  const db = await getTypedClient();
  const query = sql`SELECT cs.project_name, COUNT(DISTINCT cs.id) AS session_count,
                   jsonb_agg(DISTINCT je.value)::text AS file_list
            FROM cowork_sessions cs
            LEFT JOIN LATERAL jsonb_array_elements_text(cs.files_touched::jsonb) AS je(value) ON true
            WHERE cs.user_id = ${userId} AND cs.project_name IS NOT NULL AND cs.started_at >= ${since}
            GROUP BY cs.project_name
            ORDER BY session_count DESC`;
  const rows = await rawAll<{ project_name: string; session_count: number | string; file_list: string | null }>(db, query);
  return rows.map((r) => ({
    project_name: r.project_name,
    session_count: Number(r.session_count),
    files: r.file_list ? (JSON.parse(r.file_list) as unknown[]).filter((f) => f !== null) as string[] : [],
  }));
}

export async function getCoworkUserSessions(userId: string, since: number, limit = 20): Promise<Array<{
  id: string; project_name: string | null; files_touched_count: number;
  started_at: number; ended_at: number | null;
}>> {
  const db = await getTypedClient();
  const lenExpr = sql`CASE WHEN files_touched IS NOT NULL THEN jsonb_array_length(files_touched::jsonb) ELSE 0 END`;
  const query = sql`SELECT id, project_name, ${lenExpr} AS files_touched_count, started_at, ended_at
                    FROM cowork_sessions
                    WHERE user_id = ${userId} AND started_at >= ${since}
                    ORDER BY started_at DESC
                    LIMIT ${limit}`;
  const rows = await rawAll<{
    id: string; project_name: string | null; files_touched_count: number | string;
    started_at: number | string; ended_at: number | string | null;
  }>(db, query);
  // Raw reads: Postgres returns bigint columns (started_at/ended_at) as strings,
  // so coerce to number to preserve the numeric contract.
  return rows.map((r) => ({
    id: r.id,
    project_name: r.project_name,
    files_touched_count: Number(r.files_touched_count),
    started_at: Number(r.started_at),
    ended_at: r.ended_at === null || r.ended_at === undefined ? null : Number(r.ended_at),
  }));
}
