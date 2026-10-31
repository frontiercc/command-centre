// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Dashboard figures by kind of work (Chat, Work, Code) and vendor (Claude,
// OpenAI), for the dashboard's vendor switch. lib/dashboard/vendor.ts says
// which prompts belong to which kind.
//
// analytics_snapshots (Anthropic's Analytics API) hold Claude figures only, so
// where a reader prefers them, they stand in for the Claude part alone and
// OpenAI figures are always read live from cowork_messages.
import { sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { kindClause, kindExpr, vendorClause, vendorExpr, codeSessionVendorClause } from './product-sql';
import type { Vendor, VendorSplit, WorkKind } from './vendor';

interface RawFacade {
  execute: (q: unknown) => Promise<{ rows: unknown[] }>;
}
async function rawAll<T>(query: unknown): Promise<T[]> {
  const client = (await getTypedClient()) as unknown as RawFacade;
  const res = await client.execute(query);
  return res.rows as T[];
}

const DAY = 86400;
const KINDS: WorkKind[] = ['chat', 'work', 'code'];
const nowS = () => Math.floor(Date.now() / 1000);

/** True once any ChatGPT or Codex prompt has been stored. */
export async function hasOpenAiData(): Promise<boolean> {
  const rows = await rawAll<{ x: number }>(sql`SELECT 1 AS x FROM cowork_messages WHERE ${sql.raw(vendorClause('openai'))} LIMIT 1`);
  return rows.length > 0;
}

/** People with a prompt from each vendor in the 7 days ending at `endS`. */
export async function getActiveUsersByVendor(endS = nowS()): Promise<{ claude: number; openai: number }> {
  const rows = await rawAll<{ vendor: string; n: number | string }>(sql`
    SELECT ${sql.raw(vendorExpr())} AS vendor, COUNT(DISTINCT user_id) AS n
    FROM cowork_messages
    WHERE user_id IS NOT NULL AND occurred_at >= ${endS - 7 * DAY} AND occurred_at < ${endS}
    GROUP BY 1
  `);
  const out = { claude: 0, openai: 0 };
  for (const r of rows) out[r.vendor as 'claude' | 'openai'] = Number(r.n);
  return out;
}

/** People with a prompt from the given vendor in the 7 days ending at `endS`. */
export async function getActiveUsersForVendor(vendor: Vendor, endS = nowS()): Promise<number> {
  const rows = await rawAll<{ n: number | string }>(sql`
    SELECT COUNT(DISTINCT user_id) AS n FROM cowork_messages
    WHERE user_id IS NOT NULL AND occurred_at >= ${endS - 7 * DAY} AND occurred_at < ${endS}
      AND ${sql.raw(vendorClause(vendor))}
  `);
  return Number(rows[0]?.n ?? 0);
}

/**
 * Average sessions a week over the last 4 weeks for each kind of work and
 * vendor, "active-weeks aware" as getAvgSessionsPerWeek is: sessions in the
 * window divided by the weeks since that kind's first activity from that
 * vendor (at most 4). The total is the two vendors' figures added, so the
 * split under each box adds up to it.
 *   Chat, Work → distinct conversations and sessions in cowork_messages
 *   Code       → code_session_stats rows (one per session; Codex ids start 'codex:')
 */
export async function getSessionsPerWeekByProduct(now = nowS()): Promise<Record<WorkKind, VendorSplit>> {
  const windowStart = now - 28 * DAY;
  const WEEK = 7 * DAY;
  const avg = (count: number, firstSeen: number | null): number => {
    if (!count || firstSeen == null) return 0;
    const weeks = Math.min(4, Math.max(1, Math.ceil((now - firstSeen) / WEEK)));
    return Math.round((count / weeks) * 10) / 10;
  };

  const [promptRows, codeRows] = await Promise.all([
    rawAll<{ kind: string; vendor: string; sessions: number | string; first_at: number | string | null }>(sql`
      SELECT ${sql.raw(kindExpr())} AS kind, ${sql.raw(vendorExpr())} AS vendor,
             COUNT(DISTINCT CASE WHEN occurred_at >= ${windowStart} THEN session_id END) AS sessions,
             MIN(occurred_at) AS first_at
      FROM cowork_messages
      WHERE session_id <> '' AND surface IS DISTINCT FROM 'code'
      GROUP BY 1, 2
    `),
    rawAll<{ vendor: string; sessions: number | string; first_at: number | string | null }>(sql`
      SELECT CASE WHEN ${sql.raw(codeSessionVendorClause('openai'))} THEN 'openai' ELSE 'claude' END AS vendor,
             COUNT(CASE WHEN last_at >= ${windowStart} THEN 1 END) AS sessions,
             MIN(first_at) AS first_at
      FROM code_session_stats
      GROUP BY 1
    `),
  ]);

  const out = Object.fromEntries(KINDS.map((k) => [k, { total: 0, claude: 0, openai: 0 }])) as Record<WorkKind, VendorSplit>;
  const put = (kind: WorkKind, vendor: string, sessions: number | string, firstAt: number | string | null) => {
    out[kind][vendor as 'claude' | 'openai'] = avg(Number(sessions), firstAt == null ? null : Number(firstAt));
  };
  for (const r of promptRows) put(r.kind as WorkKind, r.vendor, r.sessions, r.first_at);
  for (const r of codeRows) put('code', r.vendor, r.sessions, r.first_at);
  for (const k of KINDS) out[k].total = Math.round((out[k].claude + out[k].openai) * 10) / 10;
  return out;
}

/** Prompts flagged for personal data, all time, by kind of work and vendor. */
export async function getFlaggedByProduct(): Promise<Record<WorkKind, VendorSplit>> {
  const rows = await rawAll<{ kind: string; vendor: string; n: number | string }>(sql`
    SELECT ${sql.raw(kindExpr())} AS kind, ${sql.raw(vendorExpr())} AS vendor, COUNT(*) AS n
    FROM cowork_messages WHERE flagged = 1
    GROUP BY 1, 2
  `);
  const out = Object.fromEntries(KINDS.map((k) => [k, { total: 0, claude: 0, openai: 0 }])) as Record<WorkKind, VendorSplit>;
  for (const r of rows) {
    const s = out[r.kind as WorkKind];
    s[r.vendor as 'claude' | 'openai'] = Number(r.n);
    s.total += Number(r.n);
  }
  return out;
}

export interface TrendDay { date: string; surface_chat: number; surface_code: number; surface_cowork: number }

/** Live daily activity from cowork_messages for one vendor (never 'all'). */
async function liveTrend(cutoffS: number, vendor: Vendor): Promise<Map<string, Omit<TrendDay, 'date'>>> {
  const dateExpr = `to_char(to_timestamp(occurred_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
  // Same measures as getAdoptionTrend: Work is people a day, Chat and Code are prompts a day.
  const rows = await rawAll<{ date: string; chat: number | string; work: number | string; code: number | string }>(sql`
    SELECT ${sql.raw(dateExpr)} AS date,
           COUNT(CASE WHEN ${sql.raw(kindClause('chat'))} THEN 1 END) AS chat,
           COUNT(DISTINCT CASE WHEN ${sql.raw(kindClause('work'))} THEN user_id END) AS work,
           COUNT(CASE WHEN ${sql.raw(kindClause('code'))} THEN 1 END) AS code
    FROM cowork_messages
    WHERE occurred_at >= ${cutoffS} AND ${sql.raw(vendorClause(vendor))}
    GROUP BY 1
  `);
  return new Map(rows.map((r) => [r.date, { surface_chat: Number(r.chat), surface_cowork: Number(r.work), surface_code: Number(r.code) }]));
}

/**
 * The 14-day adoption chart for a vendor. Claude's part prefers
 * analytics_snapshots on the days they cover, as getAdoptionTrend does; the
 * OpenAI part is always live. 'all' adds the two.
 */
export async function getAdoptionTrendByVendor(days: number, vendor: Vendor): Promise<TrendDay[]> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().split('T')[0];
  const todayStr = new Date().toISOString().split('T')[0];
  const cutoffS = Math.floor(cutoff.getTime() / 1000);
  const zero = () => ({ surface_chat: 0, surface_code: 0, surface_cowork: 0 });

  const parts: Array<Map<string, Omit<TrendDay, 'date'>>> = [];
  if (vendor !== 'openai') {
    const claude = await liveTrend(cutoffS, 'claude');
    const snaps = await rawAll<{ date: string; chat: number | string; code: number | string; cowork: number | string }>(sql`
      SELECT snapshot_date AS date, SUM(surface_chat) AS chat, SUM(surface_code) AS code, SUM(surface_cowork) AS cowork
      FROM analytics_snapshots
      WHERE snapshot_date >= ${cutoffStr} AND snapshot_date <= ${todayStr}
      GROUP BY snapshot_date
    `);
    for (const s of snaps) claude.set(s.date, { surface_chat: Number(s.chat), surface_code: Number(s.code), surface_cowork: Number(s.cowork) });
    parts.push(claude);
  }
  if (vendor !== 'claude') parts.push(await liveTrend(cutoffS, 'openai'));

  const merged = new Map<string, Omit<TrendDay, 'date'>>();
  for (const part of parts) {
    for (const [date, v] of part) {
      const e = merged.get(date) ?? zero();
      e.surface_chat += v.surface_chat;
      e.surface_code += v.surface_code;
      e.surface_cowork += v.surface_cowork;
      merged.set(date, e);
    }
  }
  return Array.from(merged.entries())
    .filter(([date]) => date <= todayStr)
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export interface DepartmentRow {
  department: string;
  user_count: number;
  active_users: number;
  surface_chat: number;
  surface_code: number;
  surface_cowork: number;
}

/** People per department who used each kind of work from the vendor in the last 7 days. */
export async function getDepartmentBreakdownByVendor(vendor: Vendor): Promise<DepartmentRow[]> {
  const weekAgo = nowS() - 7 * DAY;
  const v = sql.raw(vendorClause(vendor));
  const rows = await rawAll<{
    department: string; user_count: number | string; active_users: number | string;
    chat: number | string; code: number | string; work: number | string;
  }>(sql`
    SELECT
      COALESCE(u.department, 'Unassigned') AS department,
      COUNT(DISTINCT u.id) AS user_count,
      COUNT(DISTINCT CASE WHEN u.last_seen_at >= ${weekAgo} THEN u.id END) AS active_users,
      COUNT(DISTINCT chat.user_id) AS chat,
      COUNT(DISTINCT code.user_id) AS code,
      COUNT(DISTINCT work.user_id) AS work
    FROM users u
    LEFT JOIN (SELECT DISTINCT user_id FROM cowork_messages WHERE ${sql.raw(kindClause('chat'))} AND ${v} AND occurred_at >= ${weekAgo}) chat ON u.id = chat.user_id
    LEFT JOIN (SELECT DISTINCT user_id FROM cowork_messages WHERE ${sql.raw(kindClause('code'))} AND ${v} AND occurred_at >= ${weekAgo}) code ON u.id = code.user_id
    LEFT JOIN (SELECT DISTINCT user_id FROM cowork_messages WHERE ${sql.raw(kindClause('work'))} AND ${v} AND occurred_at >= ${weekAgo}) work ON u.id = work.user_id
    WHERE u.department IS NOT NULL
    GROUP BY u.department
    ORDER BY (COUNT(DISTINCT chat.user_id) + COUNT(DISTINCT code.user_id) + COUNT(DISTINCT work.user_id)) DESC
  `);
  return rows.map((r) => ({
    department: r.department,
    user_count: Number(r.user_count),
    active_users: Number(r.active_users),
    surface_chat: Number(r.chat),
    surface_code: Number(r.code),
    surface_cowork: Number(r.work),
  }));
}

export interface TopUserRow {
  id: string;
  display_name: string | null;
  email: string;
  department: string | null;
  total_activity: number;
  surface_chat: number;
  surface_code: number;
  surface_cowork: number;
}

type Counts = Pick<TopUserRow, 'surface_chat' | 'surface_code' | 'surface_cowork'>;
interface Person { display_name: string | null; email: string; department: string | null }

/** Prompts per person and kind of work from one vendor (never 'all') in the last 7 days. */
async function liveUserCounts(vendor: Vendor): Promise<Map<string, Counts & Person>> {
  const weekAgo = nowS() - 7 * DAY;
  const rows = await rawAll<{
    id: string; display_name: string | null; email: string; department: string | null;
    chat: number | string; code: number | string; work: number | string;
  }>(sql`
    SELECT u.id, u.display_name, u.email, u.department,
           COUNT(CASE WHEN ${sql.raw(kindClause('chat', 'cm.'))} THEN 1 END) AS chat,
           COUNT(CASE WHEN ${sql.raw(kindClause('code', 'cm.'))} THEN 1 END) AS code,
           COUNT(CASE WHEN ${sql.raw(kindClause('work', 'cm.'))} THEN 1 END) AS work
    FROM cowork_messages cm JOIN users u ON u.id = cm.user_id
    WHERE cm.occurred_at >= ${weekAgo} AND ${sql.raw(vendorClause(vendor, 'cm.'))}
    GROUP BY u.id, u.display_name, u.email, u.department
  `);
  return new Map(rows.map((r) => [r.id, {
    display_name: r.display_name, email: r.email, department: r.department,
    surface_chat: Number(r.chat), surface_code: Number(r.code), surface_cowork: Number(r.work),
  }]));
}

/**
 * The week's most active people for a vendor. Claude's part prefers
 * analytics_snapshots when any exist for the week, as getTopUsers does; the
 * OpenAI part is always live. 'all' adds the two for each person.
 */
export async function getTopUsersByVendor(limit: number, vendor: Vendor): Promise<TopUserRow[]> {
  const parts: Array<Map<string, Counts & Person>> = [];
  if (vendor !== 'openai') {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    const cutoffStr = cutoff.toISOString().split('T')[0];
    const snaps = await rawAll<{
      id: string; display_name: string | null; email: string; department: string | null;
      chat: number | string; code: number | string; cowork: number | string;
    }>(sql`
      SELECT u.id, u.display_name, u.email, u.department,
             COALESCE(SUM(a.surface_chat), 0) AS chat, COALESCE(SUM(a.surface_code), 0) AS code, COALESCE(SUM(a.surface_cowork), 0) AS cowork
      FROM users u JOIN analytics_snapshots a ON u.id = a.user_id AND a.snapshot_date >= ${cutoffStr}
      GROUP BY u.id, u.display_name, u.email, u.department
    `);
    parts.push(snaps.length > 0
      ? new Map(snaps.map((r) => [r.id, {
          display_name: r.display_name, email: r.email, department: r.department,
          surface_chat: Number(r.chat), surface_code: Number(r.code), surface_cowork: Number(r.cowork),
        }]))
      : await liveUserCounts('claude'));
  }
  if (vendor !== 'claude') parts.push(await liveUserCounts('openai'));

  const merged = new Map<string, Counts & Person>();
  for (const part of parts) {
    for (const [id, p] of part) {
      const e = merged.get(id);
      if (!e) { merged.set(id, { ...p }); continue; }
      e.surface_chat += p.surface_chat;
      e.surface_code += p.surface_code;
      e.surface_cowork += p.surface_cowork;
    }
  }
  return Array.from(merged.entries())
    .map(([id, p]) => ({ id, ...p, total_activity: p.surface_chat + p.surface_code + p.surface_cowork }))
    .filter((r) => r.total_activity > 0)
    .sort((a, b) => b.total_activity - a.total_activity)
    .slice(0, limit);
}

export interface ProductSessions {
  chat: { claudeChat: number; chatgptChat: number };
  work: { claudeCowork: number; chatgptWork: number };
  code: { claudeCode: number; codex: number };
}

/**
 * Sessions in the 7 days ending at `endS`, for each product: conversations and
 * sessions in cowork_messages for Chat and Work, code_session_stats rows
 * active in the window for Code (as code_metrics counts them).
 */
export async function getSessionsThisWeekByProduct(endS = nowS()): Promise<ProductSessions> {
  const startS = endS - 7 * DAY;
  const [promptRows, codeRows] = await Promise.all([
    rawAll<{ kind: string; vendor: string; n: number | string }>(sql`
      SELECT ${sql.raw(kindExpr())} AS kind, ${sql.raw(vendorExpr())} AS vendor, COUNT(DISTINCT session_id) AS n
      FROM cowork_messages
      WHERE session_id <> '' AND surface IS DISTINCT FROM 'code' AND occurred_at >= ${startS} AND occurred_at < ${endS}
      GROUP BY 1, 2
    `),
    rawAll<{ vendor: string; n: number | string }>(sql`
      SELECT CASE WHEN ${sql.raw(codeSessionVendorClause('openai'))} THEN 'openai' ELSE 'claude' END AS vendor, COUNT(*) AS n
      FROM code_session_stats WHERE last_at >= ${startS} AND first_at < ${endS}
      GROUP BY 1
    `),
  ]);
  const out: ProductSessions = {
    chat: { claudeChat: 0, chatgptChat: 0 },
    work: { claudeCowork: 0, chatgptWork: 0 },
    code: { claudeCode: 0, codex: 0 },
  };
  for (const r of promptRows) {
    const openai = r.vendor === 'openai';
    if (r.kind === 'chat') out.chat[openai ? 'chatgptChat' : 'claudeChat'] = Number(r.n);
    else out.work[openai ? 'chatgptWork' : 'claudeCowork'] = Number(r.n);
  }
  for (const r of codeRows) out.code[r.vendor === 'openai' ? 'codex' : 'claudeCode'] = Number(r.n);
  return out;
}

/** Classified prompts a tier in the 7 days ending at `endS`, for each vendor. */
export async function getTierMixThisWeekByVendor(endS = nowS()): Promise<Record<'claude' | 'openai', { tier1: number; tier2: number; tier3: number }>> {
  const rows = await rawAll<{ vendor: string; t1: number | string; t2: number | string; t3: number | string }>(sql`
    SELECT ${sql.raw(vendorExpr('cm.'))} AS vendor,
           SUM(CASE WHEN pc.tier = 1 THEN 1 ELSE 0 END) AS t1,
           SUM(CASE WHEN pc.tier = 2 THEN 1 ELSE 0 END) AS t2,
           SUM(CASE WHEN pc.tier = 3 THEN 1 ELSE 0 END) AS t3
    FROM pulse_classifications pc JOIN cowork_messages cm ON cm.id = pc.cowork_message_id
    WHERE pc.classifier_status = 'classified' AND cm.occurred_at >= ${endS - 7 * DAY} AND cm.occurred_at < ${endS}
    GROUP BY 1
  `);
  const out = { claude: { tier1: 0, tier2: 0, tier3: 0 }, openai: { tier1: 0, tier2: 0, tier3: 0 } };
  for (const r of rows) out[r.vendor as 'claude' | 'openai'] = { tier1: Number(r.t1), tier2: Number(r.t2), tier3: Number(r.t3) };
  return out;
}
