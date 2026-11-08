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
import { kindExpr, vendorClause, vendorExpr, codeSessionVendorClause, productExpr } from './product-sql';
import { zeroCounts, sumShown, type Product, type ProductCounts, type ProductId, type Vendor, type VendorSplit, type WorkKind } from './vendor';

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

export interface TrendDay { date: string; products: ProductCounts }

/**
 * Daily activity for each product over the last `days` days. Chat and Code
 * products count prompts a day, Work products count people a day (the
 * measures the trend has always used). Claude's three products prefer
 * analytics_snapshots on the days they cover, as getAdoptionTrend does; the
 * OpenAI products are always read live.
 */
export async function getAdoptionTrendByProduct(days: number): Promise<TrendDay[]> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().split('T')[0];
  const todayStr = new Date().toISOString().split('T')[0];
  const cutoffS = Math.floor(cutoff.getTime() / 1000);
  const dateExpr = `to_char(to_timestamp(occurred_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;

  const [live, snaps] = await Promise.all([
    rawAll<{ date: string; product: string; prompts: number | string; people: number | string }>(sql`
      SELECT ${sql.raw(dateExpr)} AS date, ${sql.raw(productExpr())} AS product,
             COUNT(*) AS prompts, COUNT(DISTINCT user_id) AS people
      FROM cowork_messages
      WHERE occurred_at >= ${cutoffS}
      GROUP BY 1, 2
    `),
    rawAll<{ date: string; chat: number | string; code: number | string; cowork: number | string }>(sql`
      SELECT snapshot_date AS date, SUM(surface_chat) AS chat, SUM(surface_code) AS code, SUM(surface_cowork) AS cowork
      FROM analytics_snapshots
      WHERE snapshot_date >= ${cutoffStr} AND snapshot_date <= ${todayStr}
      GROUP BY snapshot_date
    `),
  ]);

  const byDate = new Map<string, ProductCounts>();
  const day = (date: string) => {
    let c = byDate.get(date);
    if (!c) { c = zeroCounts(); byDate.set(date, c); }
    return c;
  };
  const isWork = (id: ProductId) => id === 'claude_cowork' || id === 'chatgpt_work';
  for (const r of live) {
    const id = r.product as ProductId;
    day(r.date)[id] = Number(isWork(id) ? r.people : r.prompts);
  }
  for (const s of snaps) {
    const c = day(s.date);
    c.claude_chat = Number(s.chat);
    c.claude_code = Number(s.code);
    c.claude_cowork = Number(s.cowork);
  }
  return Array.from(byDate.entries())
    .filter(([date]) => date <= todayStr)
    .map(([date, products]) => ({ date, products }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export interface DepartmentRow {
  department: string;
  user_count: number;
  active_users: number;
  /** People in the department who used each product in the last 7 days. */
  products: ProductCounts;
}

/**
 * People per department who used each product in the last 7 days. In the
 * Claude or OpenAI view, active people are those who used that vendor's
 * products this week, so Users and Adoption follow the switch like the cells.
 */
export async function getDepartmentBreakdownByProduct(vendor: Vendor = 'all'): Promise<DepartmentRow[]> {
  const weekAgo = nowS() - 7 * DAY;
  const [depts, used, vendorActive] = await Promise.all([
    rawAll<{ department: string; user_count: number | string; active_users: number | string }>(sql`
      SELECT u.department, COUNT(*) AS user_count,
             COUNT(CASE WHEN u.last_seen_at >= ${weekAgo} THEN 1 END) AS active_users
      FROM users u WHERE u.department IS NOT NULL
      GROUP BY u.department
    `),
    rawAll<{ department: string; product: string; n: number | string }>(sql`
      SELECT u.department, ${sql.raw(productExpr('cm.'))} AS product, COUNT(DISTINCT cm.user_id) AS n
      FROM cowork_messages cm JOIN users u ON u.id = cm.user_id
      WHERE u.department IS NOT NULL AND cm.occurred_at >= ${weekAgo}
      GROUP BY 1, 2
    `),
    vendor === 'all' ? Promise.resolve(null) : rawAll<{ department: string; n: number | string }>(sql`
      SELECT u.department, COUNT(DISTINCT cm.user_id) AS n
      FROM cowork_messages cm JOIN users u ON u.id = cm.user_id
      WHERE u.department IS NOT NULL AND cm.occurred_at >= ${weekAgo} AND ${sql.raw(vendorClause(vendor, 'cm.'))}
      GROUP BY 1
    `),
  ]);
  const activeByDept = vendorActive ? new Map(vendorActive.map((r) => [r.department, Number(r.n)])) : null;
  const rows = new Map<string, DepartmentRow>(depts.map((d) => [d.department, {
    department: d.department,
    user_count: Number(d.user_count),
    active_users: activeByDept ? (activeByDept.get(d.department) ?? 0) : Number(d.active_users),
    products: zeroCounts(),
  }]));
  for (const r of used) {
    const row = rows.get(r.department);
    if (row) row.products[r.product as ProductId] = Number(r.n);
  }
  return Array.from(rows.values());
}

export interface TopUserRow {
  id: string;
  display_name: string | null;
  email: string;
  department: string | null;
  /** Prompts this week across the products the view shows. */
  total_activity: number;
  products: ProductCounts;
}

interface Person { display_name: string | null; email: string; department: string | null; products: ProductCounts }

/**
 * Prompts per person and product in the last 7 days. Claude's three products
 * prefer analytics_snapshots when any exist for the week, as getTopUsers does;
 * the OpenAI products are always read live.
 */
async function userProductCounts(): Promise<Map<string, Person>> {
  const weekAgo = nowS() - 7 * DAY;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7);
  const cutoffStr = cutoff.toISOString().split('T')[0];
  const [live, snaps] = await Promise.all([
    rawAll<{ id: string; display_name: string | null; email: string; department: string | null; product: string; n: number | string }>(sql`
      SELECT u.id, u.display_name, u.email, u.department, ${sql.raw(productExpr('cm.'))} AS product, COUNT(*) AS n
      FROM cowork_messages cm JOIN users u ON u.id = cm.user_id
      WHERE cm.occurred_at >= ${weekAgo}
      GROUP BY u.id, u.display_name, u.email, u.department, 5
    `),
    rawAll<{ id: string; display_name: string | null; email: string; department: string | null; chat: number | string; code: number | string; cowork: number | string }>(sql`
      SELECT u.id, u.display_name, u.email, u.department,
             COALESCE(SUM(a.surface_chat), 0) AS chat, COALESCE(SUM(a.surface_code), 0) AS code, COALESCE(SUM(a.surface_cowork), 0) AS cowork
      FROM users u JOIN analytics_snapshots a ON u.id = a.user_id AND a.snapshot_date >= ${cutoffStr}
      GROUP BY u.id, u.display_name, u.email, u.department
    `),
  ]);
  const people = new Map<string, Person>();
  const person = (r: { id: string; display_name: string | null; email: string; department: string | null }) => {
    let p = people.get(r.id);
    if (!p) { p = { display_name: r.display_name, email: r.email, department: r.department, products: zeroCounts() }; people.set(r.id, p); }
    return p;
  };
  const useSnaps = snaps.length > 0;
  for (const r of live) {
    const id = r.product as ProductId;
    if (useSnaps && (id === 'claude_chat' || id === 'claude_code' || id === 'claude_cowork')) continue;
    person(r).products[id] = Number(r.n);
  }
  for (const s of snaps) {
    const p = person(s);
    p.products.claude_chat = Number(s.chat);
    p.products.claude_code = Number(s.code);
    p.products.claude_cowork = Number(s.cowork);
  }
  return people;
}

/** The week's most active people across the products shown, with each product's count. */
export async function getTopUsersByProduct(limit: number, shown: readonly Product[]): Promise<TopUserRow[]> {
  const people = await userProductCounts();
  return Array.from(people.entries())
    .map(([id, p]) => ({ id, display_name: p.display_name, email: p.email, department: p.department, products: p.products, total_activity: sumShown(p.products, shown) }))
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
