// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Dashboard figures by kind of work (Chat, Work, Code) and vendor (Claude,
// OpenAI), for the dashboard's vendor switch. lib/dashboard/vendor.ts says
// which prompts belong to which kind.
//
// analytics_snapshots (Anthropic's Analytics API) hold Claude figures only, so
// where a reader prefers them, they stand in for the Claude part alone and
// OpenAI figures are always read live from cowork_messages.
//
// People counts list each person once per group in a GROUP BY first and then
// count rows, rather than COUNT(DISTINCT user_id) over every prompt: same
// figures, without sorting every prompt in the window.
import { PC_MESSAGE } from '@/lib/pulse/classification-message';
import { AUTOMATED_WORK_TYPE } from '@/lib/pulse/code/automated-runs';
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
/** The window of the dashboard's "Who is using it each day?" and "Which departments are using it?" panels. */
export const DASHBOARD_PANEL_DAYS = 30;
const KINDS: WorkKind[] = ['chat', 'work', 'code'];
const nowS = () => Math.floor(Date.now() / 1000);

/**
 * A prompt's UTC day as 'YYYY-MM-DD', from a whole-day number (occurred_at / 86400).
 * Grouping on the day number and formatting once per group gives the same
 * labels as formatting every prompt, for less work.
 */
const DAY_LABEL = `to_char(to_timestamp(day * 86400) AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;

/** True once any ChatGPT or Codex prompt has been stored. */
export async function hasOpenAiData(): Promise<boolean> {
  const rows = await rawAll<{ x: number }>(sql`SELECT 1 AS x FROM cowork_messages WHERE ${sql.raw(vendorClause('openai'))} LIMIT 1`);
  return rows.length > 0;
}

export interface ActiveUsersByWeek {
  thisWeek: { claude: number; openai: number };
  lastWeek: { claude: number; openai: number };
}

/**
 * People with a prompt from each vendor in the 7 days ending at `endS` (this
 * week) and in the 7 days before that (last week), read in one pass over the
 * two weeks.
 */
export async function getActiveUsersThisAndLastWeek(endS = nowS()): Promise<ActiveUsersByWeek> {
  const weekStart = endS - 7 * DAY;
  const rows = await rawAll<{ vendor: string; this_week: number | string; last_week: number | string }>(sql`
    WITH person_vendor AS (
      SELECT ${sql.raw(vendorExpr())} AS vendor, user_id,
             bool_or(occurred_at >= ${weekStart}) AS this_week,
             bool_or(occurred_at < ${weekStart}) AS last_week
      FROM cowork_messages
      WHERE user_id IS NOT NULL AND occurred_at >= ${weekStart - 7 * DAY} AND occurred_at < ${endS}
      GROUP BY 1, 2
    )
    SELECT vendor,
           COUNT(*) FILTER (WHERE this_week) AS this_week,
           COUNT(*) FILTER (WHERE last_week) AS last_week
    FROM person_vendor
    GROUP BY vendor
  `);
  const out: ActiveUsersByWeek = { thisWeek: { claude: 0, openai: 0 }, lastWeek: { claude: 0, openai: 0 } };
  for (const r of rows) {
    const vendor = r.vendor as 'claude' | 'openai';
    out.thisWeek[vendor] = Number(r.this_week);
    out.lastWeek[vendor] = Number(r.last_week);
  }
  return out;
}

/** People with a prompt from each vendor in the 7 days ending at `endS`. */
export async function getActiveUsersByVendor(endS = nowS()): Promise<{ claude: number; openai: number }> {
  const rows = await rawAll<{ vendor: string; n: number | string }>(sql`
    WITH person_vendor AS (
      SELECT ${sql.raw(vendorExpr())} AS vendor, user_id
      FROM cowork_messages
      WHERE user_id IS NOT NULL AND occurred_at >= ${endS - 7 * DAY} AND occurred_at < ${endS}
      GROUP BY 1, 2
    )
    SELECT vendor, COUNT(*) AS n FROM person_vendor GROUP BY vendor
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
    return Math.round(count / weeks);
  };

  const [promptRows, codeRows] = await Promise.all([
    // Each session once with its first prompt and whether it was active in the
    // window, then counted per kind and vendor.
    rawAll<{ kind: string; vendor: string; sessions: number | string; first_at: number | string | null }>(sql`
      WITH session_rows AS (
        SELECT ${sql.raw(kindExpr())} AS kind, ${sql.raw(vendorExpr())} AS vendor, session_id,
               MIN(occurred_at) AS first_at,
               bool_or(occurred_at >= ${windowStart}) AS in_window
        FROM cowork_messages
        WHERE session_id <> '' AND surface IS DISTINCT FROM 'code'
        GROUP BY 1, 2, 3
      )
      SELECT kind, vendor,
             COUNT(*) FILTER (WHERE in_window) AS sessions,
             MIN(first_at) AS first_at
      FROM session_rows
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
  for (const k of KINDS) out[k].total = out[k].claude + out[k].openai;
  return out;
}

/**
 * The automated runs inside the Code box's figure: sessions a script started (labelled by the rule in
 * lib/pulse/code/automated-runs.ts), averaged a week the same way, so the box can say how many of its
 * sessions were not typed by a person.
 */
export async function getAutomatedCodeRunsPerWeek(now = nowS()): Promise<VendorSplit> {
  const windowStart = now - 28 * DAY;
  const WEEK = 7 * DAY;
  const rows = await rawAll<{ vendor: string; runs: number | string; first_at: number | string | null }>(sql`
    SELECT CASE WHEN ${sql.raw(codeSessionVendorClause('openai', 'css.'))} THEN 'openai' ELSE 'claude' END AS vendor,
           COUNT(CASE WHEN css.last_at >= ${windowStart} THEN 1 END) AS runs,
           MIN(css.first_at) AS first_at
    FROM code_session_stats css
    JOIN code_session_classifications c ON c.session_id = css.session_id AND c.work_type = ${AUTOMATED_WORK_TYPE}
    GROUP BY 1
  `);
  const out: VendorSplit = { total: 0, claude: 0, openai: 0 };
  for (const r of rows) {
    const firstAt = r.first_at == null ? null : Number(r.first_at);
    const weeks = firstAt == null ? 1 : Math.min(4, Math.max(1, Math.ceil((now - firstAt) / WEEK)));
    out[r.vendor === 'openai' ? 'openai' : 'claude'] = Math.round(Number(r.runs) / weeks);
  }
  out.total = out.claude + out.openai;
  return out;
}

/**
 * Prompts flagged for personal data in the last 4 weeks (the window of the cards they sit under),
 * by kind of work and vendor. Risky-intent flags are not personal data, so they are left out, and
 * so is a flag whose every personal-data type the confirmation check dismissed (isFullyDismissed
 * in lib/pii/flag-severity.ts).
 */
export async function getFlaggedByProduct(now = nowS()): Promise<Record<WorkKind, VendorSplit>> {
  const rows = await rawAll<{ kind: string; vendor: string; n: number | string }>(sql`
    SELECT ${sql.raw(kindExpr())} AS kind, ${sql.raw(vendorExpr())} AS vendor, COUNT(*) AS n
    FROM cowork_messages
    WHERE flagged = 1 AND occurred_at >= ${now - 28 * DAY} AND occurred_at < ${now}
      AND flag_reason LIKE '%PII detected:%'
      AND EXISTS (
        SELECT 1 FROM unnest(string_to_array(substring(flag_reason from 'PII detected:\\s*([^|]+)'), ',')) AS t(type)
        WHERE trim(t.type) <> '' AND trim(t.type) NOT LIKE '%(dismissed)')
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

/** The adoption trend's window: from `days` days ago (to the second) to today (UTC). */
function trendWindow(days: number): { cutoffS: number; cutoffStr: string; todayStr: string } {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return {
    cutoffS: Math.floor(cutoff.getTime() / 1000),
    cutoffStr: cutoff.toISOString().split('T')[0],
    todayStr: new Date().toISOString().split('T')[0],
  };
}

/** The "Who is using it each day?" window: the last `days` whole UTC days, today included. */
function panelWindow(days: number, endS: number): { startS: number; endS: number } {
  const todayStart = Math.floor(endS / DAY) * DAY;
  return { startS: todayStart - (days - 1) * DAY, endS };
}

interface DailyActivityRow {
  date: string;
  product: string;
  /** Prompts on or after the trend's cutoff, and the people who sent them. */
  trend_prompts: number | string;
  trend_people: number | string;
  /** People with a prompt inside the panel window. */
  panel_people: number | string;
}

/**
 * Both daily readers' live figures in one pass: for each UTC day and product,
 * the adoption trend's prompts and people (prompts on or after `trendFromS`)
 * and the daily panel's people (prompts in [panelFromS, panelToS)). Each
 * person is listed once per day and product first; their row carries what
 * each reader needs.
 */
async function readDailyActivity(trendFromS: number, panelFromS: number, panelToS: number): Promise<DailyActivityRow[]> {
  return rawAll<DailyActivityRow>(sql`
    WITH person_days AS (
      SELECT occurred_at / 86400 AS day, ${sql.raw(productExpr())} AS product, user_id,
             COUNT(*) FILTER (WHERE occurred_at >= ${trendFromS}) AS trend_prompts,
             bool_or(occurred_at >= ${panelFromS} AND occurred_at < ${panelToS}) AS in_panel
      FROM cowork_messages
      WHERE occurred_at >= ${Math.min(trendFromS, panelFromS)}
      GROUP BY 1, 2, 3
    )
    SELECT ${sql.raw(DAY_LABEL)} AS date, product,
           SUM(trend_prompts) AS trend_prompts,
           COUNT(user_id) FILTER (WHERE trend_prompts > 0) AS trend_people,
           COUNT(user_id) FILTER (WHERE in_panel) AS panel_people
    FROM person_days
    GROUP BY day, product
  `);
}

/** Claude's daily figures from analytics_snapshots, for the adoption trend. */
function readTrendSnapshots(cutoffStr: string, todayStr: string) {
  return rawAll<{ date: string; chat: number | string; code: number | string; cowork: number | string }>(sql`
    SELECT snapshot_date AS date, SUM(surface_chat) AS chat, SUM(surface_code) AS code, SUM(surface_cowork) AS cowork
    FROM analytics_snapshots
    WHERE snapshot_date >= ${cutoffStr} AND snapshot_date <= ${todayStr}
    GROUP BY snapshot_date
  `);
}

/** The adoption trend from the live rows and the snapshots. */
function buildAdoptionTrend(
  live: DailyActivityRow[],
  snaps: Awaited<ReturnType<typeof readTrendSnapshots>>,
  todayStr: string,
): TrendDay[] {
  const byDate = new Map<string, ProductCounts>();
  const day = (date: string) => {
    let c = byDate.get(date);
    if (!c) { c = zeroCounts(); byDate.set(date, c); }
    return c;
  };
  const isWork = (id: ProductId) => id === 'claude_cowork' || id === 'chatgpt_work';
  for (const r of live) {
    // A day and product with prompts only before the cutoff is not in the trend.
    if (Number(r.trend_prompts) === 0) continue;
    const id = r.product as ProductId;
    day(r.date)[id] = Number(isWork(id) ? r.trend_people : r.trend_prompts);
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

/** The daily panel from the live rows: every day of the window, a day with no activity at 0. */
function buildPeopleByDay(live: DailyActivityRow[], days: number, startS: number): Array<{ date: string; products: ProductCounts }> {
  const out = Array.from({ length: days }, (_, i) => ({
    date: new Date((startS + i * DAY) * 1000).toISOString().slice(0, 10),
    products: zeroCounts(),
  }));
  const byDate = new Map(out.map(d => [d.date, d.products]));
  for (const r of live) {
    const c = byDate.get(r.date);
    if (c && r.product in c) c[r.product as ProductId] = Number(r.panel_people);
  }
  return out;
}

/**
 * Daily activity for each product over the last `days` days. Chat and Code
 * products count prompts a day, Work products count people a day (the
 * measures the trend has always used). Claude's three products prefer
 * analytics_snapshots on the days they cover, as getAdoptionTrend does; the
 * OpenAI products are always read live.
 */
export async function getAdoptionTrendByProduct(days: number): Promise<TrendDay[]> {
  const { cutoffS, cutoffStr, todayStr } = trendWindow(days);
  const [live, snaps] = await Promise.all([
    readDailyActivity(cutoffS, cutoffS, cutoffS),
    readTrendSnapshots(cutoffStr, todayStr),
  ]);
  return buildAdoptionTrend(live, snaps, todayStr);
}

/**
 * People a day for each product over the last `days` UTC days, oldest first: the dashboard's
 * "Who is using it each day?" lines. Every figure counts people, never prompts, so the products
 * can be read against one another. A day with no activity reads 0 (nobody used it).
 */
export async function getPeopleByDayByProduct(days: number, endS = nowS()): Promise<Array<{ date: string; products: ProductCounts }>> {
  const panel = panelWindow(days, endS);
  const live = await readDailyActivity(panel.startS, panel.startS, panel.endS);
  return buildPeopleByDay(live, days, panel.startS);
}

/**
 * The adoption trend over the last `trendDays` days and the people-a-day panel
 * over the last `panelDays` UTC days, from one read of the prompts (plus the
 * snapshots), for the dashboard, which shows both. Same figures as
 * getAdoptionTrendByProduct and getPeopleByDayByProduct.
 */
export async function getDailyPanelsByProduct(trendDays: number, panelDays: number, endS = nowS()): Promise<{
  adoptionTrend: TrendDay[];
  peopleByDay: Array<{ date: string; products: ProductCounts }>;
}> {
  const trend = trendWindow(trendDays);
  const panel = panelWindow(panelDays, endS);
  const [live, snaps] = await Promise.all([
    readDailyActivity(trend.cutoffS, panel.startS, panel.endS),
    readTrendSnapshots(trend.cutoffStr, trend.todayStr),
  ]);
  return {
    adoptionTrend: buildAdoptionTrend(live, snaps, trend.todayStr),
    peopleByDay: buildPeopleByDay(live, panelDays, panel.startS),
  };
}

export interface DepartmentRow {
  department: string;
  user_count: number;
  active_users: number;
  /** People in the department who used each product in the last 30 days. */
  products: ProductCounts;
}

/**
 * People per department who used each product in the last 30 days
 * (DASHBOARD_PANEL_DAYS). In the Claude or OpenAI view, active people are
 * those who used that vendor's products in those 30 days, so Users and
 * Adoption follow the switch like the cells.
 */
export async function getDepartmentBreakdownByProduct(vendor: Vendor = 'all', endS = nowS()): Promise<DepartmentRow[]> {
  const since = endS - DASHBOARD_PANEL_DAYS * DAY;
  const [depts, used] = await Promise.all([
    rawAll<{ department: string; user_count: number | string; active_users: number | string }>(sql`
      SELECT u.department, COUNT(*) AS user_count,
             COUNT(CASE WHEN u.last_seen_at >= ${since} THEN 1 END) AS active_users
      FROM users u WHERE u.department IS NOT NULL
      GROUP BY u.department
    `),
    // Each person once per product (and whether it is the chosen vendor's), then
    // counted per department and product, and per department for the vendor.
    // The department-only rows (product NULL) carry the vendor's active people.
    rawAll<{ department: string; product: string | null; n: number | string; vendor_people: number | string }>(sql`
      WITH person_products AS (
        SELECT user_id, ${sql.raw(productExpr())} AS product,
               bool_or(${sql.raw(vendorClause(vendor))}) AS in_vendor
        FROM cowork_messages
        WHERE user_id IS NOT NULL AND occurred_at >= ${since}
        GROUP BY 1, 2
      )
      SELECT u.department, pp.product, COUNT(*) AS n,
             COUNT(DISTINCT pp.user_id) FILTER (WHERE pp.in_vendor) AS vendor_people
      FROM person_products pp JOIN users u ON u.id = pp.user_id
      WHERE u.department IS NOT NULL
      GROUP BY GROUPING SETS ((u.department, pp.product), (u.department))
    `),
  ]);
  const activeByDept = vendor === 'all'
    ? null
    : new Map(used.filter((r) => r.product === null).map((r) => [r.department, Number(r.vendor_people)]));
  const rows = new Map<string, DepartmentRow>(depts.map((d) => [d.department, {
    department: d.department,
    user_count: Number(d.user_count),
    active_users: activeByDept ? (activeByDept.get(d.department) ?? 0) : Number(d.active_users),
    products: zeroCounts(),
  }]));
  for (const r of used) {
    if (r.product === null) continue;
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
    // Prompts counted per person and product first, then joined to the people.
    rawAll<{ id: string; display_name: string | null; email: string; department: string | null; product: string; n: number | string }>(sql`
      WITH person_products AS (
        SELECT user_id, ${sql.raw(productExpr())} AS product, COUNT(*) AS n
        FROM cowork_messages
        WHERE user_id IS NOT NULL AND occurred_at >= ${weekAgo}
        GROUP BY 1, 2
      )
      SELECT u.id, u.display_name, u.email, u.department, pp.product, pp.n
      FROM person_products pp JOIN users u ON u.id = pp.user_id
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
    FROM pulse_classifications pc ${PC_MESSAGE}
    WHERE pc.classifier_status = 'classified' AND cm.occurred_at >= ${endS - 7 * DAY} AND cm.occurred_at < ${endS}
    GROUP BY 1
  `);
  const out = { claude: { tier1: 0, tier2: 0, tier3: 0 }, openai: { tier1: 0, tier2: 0, tier3: 0 } };
  for (const r of rows) out[r.vendor as 'claude' | 'openai'] = { tier1: Number(r.t1), tier2: Number(r.t2), tier3: Number(r.t3) };
  return out;
}

/**
 * A tier mix as whole-number shares of its classified prompts, worked out here so the
 * briefing never sees prompt counts it could set beside session counts. Null when no
 * prompt was classified: not measured, not 0%.
 */
export function tierMixShares(mix: { tier1: number; tier2: number; tier3: number }): { tier1: string; tier2: string; tier3: string } | null {
  const total = mix.tier1 + mix.tier2 + mix.tier3;
  if (total <= 0) return null;
  const pct = (n: number) => `${Math.round((n / total) * 100)}%`;
  return { tier1: pct(mix.tier1), tier2: pct(mix.tier2), tier3: pct(mix.tier3) };
}
