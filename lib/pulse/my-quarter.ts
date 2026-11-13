// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * My Pulse on the quarterly timeline. One period for the page: the last quarter (the last 13
 * completed Monday-UTC weeks) against the quarter before, with week-by-week trends. The depth
 * chart reads a year of weeks so its switch can show two quarters or a year. Spend is the one
 * figure kept on the calendar month, because Anthropic's limits and FinOps run by month.
 *
 * Every count here is measured or the classifier's stored judgement; nothing is written by a
 * model. A figure that is not captured comes back null, never 0.
 */
import { sql, type SQL } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { vendorClause, workPulseToolClause } from '@/lib/dashboard/product-sql';
import { isBuiltInTool } from '@/lib/finance/spend-review-builtins';
import { categorizeFilePath } from '@/lib/pulse/cowork/file-categories';
import type { Vendor } from '@/lib/dashboard/vendor';

const WEEK = 7 * 86400;
export const QUARTER_WEEKS = 13;
const YEAR_WEEKS = 52;

export interface QuarterTierWeek { weekStart: number; t1: number; t2: number; t3: number }

export interface MyQuarter {
  quarterStart: number;
  quarterEnd: number;
  /** A year of completed weeks with work, oldest first, for the depth chart. */
  weeks: QuarterTierWeek[];
  realWork: { now: number; all: number; before: number; weekly: number[]; deptAverage: number | null };
  share: { now: number | null; before: number | null; weekly: Array<number | null> };
  capabilities: { confirmed: number; before: number; pending: number; weekly: number[] };
  /** Null when switched off, when the viewer may not see it, or in the ChatGPT view with none recorded. */
  humanTime: { sessions: number; likelyMinutes: number; claudeMinutes: number; weekly: number[] } | null;
  produced: { files: number; sessions: number; byKind: Array<{ kind: string; files: number }> };
  colleagueTools: Array<{ type: 'skill' | 'connector'; name: string; people: number; libraryId: number | null }>;
  ownTools: string[];
}

interface Exec { execute: (q: SQL) => Promise<{ rows: unknown[] }> }
async function rows<T>(q: SQL): Promise<T[]> {
  const client = (await getTypedClient()) as unknown as Exec;
  return (await client.execute(q)).rows as T[];
}
const n = (v: unknown) => Number(v ?? 0);

function mondayOf(ts: number): number {
  const d = new Date(ts * 1000);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
  return midnight - ((d.getUTCDay() + 6) % 7) * 86400;
}

/** The person's department's members: the linked admin account's department first, as everywhere else. */
function deptMembers(dept: string): SQL {
  return sql`SELECT u.id FROM users u LEFT JOIN admin_users au ON au.linked_cowork_user_id = u.id
             WHERE COALESCE(NULLIF(au.department, ''), u.department) = ${dept}`;
}

const OUTPUT_KIND: Record<string, string> = {
  'Documents & reports': 'Reports',
  'Spreadsheets & tabular data': 'Spreadsheets',
  'Slides & decks': 'Presentations',
};

export async function buildMyQuarter(opts: {
  userId: string;
  department: string | null;
  vendor: Vendor;
  nowS: number;
  /** Whether this viewer may see the person's by-hand estimate (admin, manager or self). */
  showHumanTime: boolean;
  humanTimeOn: boolean;
}): Promise<MyQuarter> {
  const { userId, department, vendor } = opts;
  const current = mondayOf(opts.nowS);
  const qEnd = current;
  const qStart = current - QUARTER_WEEKS * WEEK;
  const pStart = qStart - QUARTER_WEEKS * WEEK;
  const yStart = current - YEAR_WEEKS * WEEK;
  const weekIdx = (ts: number) => Math.floor((ts - qStart) / WEEK);
  const msgVendor = sql.raw(vendorClause(vendor, 'cm.'));

  // ── Depth: every classified task for a year, by week ──
  const tierRows = await rows<{ wk: number | string; tier: number | string; c: number | string }>(sql`
    SELECT FLOOR((cm.occurred_at - ${yStart}) / ${WEEK}) AS wk, pc.tier AS tier, COUNT(*) AS c
    FROM pulse_classifications pc JOIN cowork_messages cm ON cm.id = pc.cowork_message_id
    WHERE pc.user_id = ${userId} AND pc.classifier_status = 'classified'
      AND cm.occurred_at >= ${Math.min(yStart, pStart)} AND cm.occurred_at < ${current} AND ${msgVendor}
    GROUP BY 1, 2`);
  const byWeek = new Map<number, QuarterTierWeek>();
  for (const r of tierRows) {
    const start = yStart + n(r.wk) * WEEK;
    const w = byWeek.get(start) ?? { weekStart: start, t1: 0, t2: 0, t3: 0 };
    const t = n(r.tier);
    if (t === 1) w.t1 += n(r.c); else if (t === 2) w.t2 += n(r.c); else if (t >= 3) w.t3 += n(r.c);
    byWeek.set(start, w);
  }
  const weeks = [...byWeek.values()].sort((a, b) => a.weekStart - b.weekStart);
  const inRange = (a: number, b: number) => weeks.filter(w => w.weekStart >= a && w.weekStart < b);
  const sumReal = (ws: QuarterTierWeek[]) => ws.reduce((s, w) => s + w.t2 + w.t3, 0);
  const sumAll = (ws: QuarterTierWeek[]) => ws.reduce((s, w) => s + w.t1 + w.t2 + w.t3, 0);
  const qWeeks = inRange(qStart, qEnd), pWeeks = inRange(pStart, qStart);
  const weekly = Array.from({ length: QUARTER_WEEKS }, (_, i) => byWeek.get(qStart + i * WEEK));

  // Department average: real-work tasks per person who did any classified work this quarter.
  let deptAverage: number | null = null;
  if (department) {
    const d = await rows<{ people: number | string; real: number | string }>(sql`
      SELECT COUNT(DISTINCT pc.user_id) AS people, SUM(CASE WHEN pc.tier >= 2 THEN 1 ELSE 0 END) AS real
      FROM pulse_classifications pc JOIN cowork_messages cm ON cm.id = pc.cowork_message_id
      WHERE pc.classifier_status = 'classified' AND pc.user_id IN (${deptMembers(department)})
        AND cm.occurred_at >= ${qStart} AND cm.occurred_at < ${qEnd} AND ${msgVendor}`);
    const people = n(d[0]?.people);
    deptAverage = people >= 3 ? n(d[0]?.real) / people : null;
  }

  // ── New ways of working: confirmed capabilities by the week they were confirmed ──
  const capRows = await rows<{ confirmed_at: number | string | null; status: string }>(sql`
    SELECT confirmed_at, status FROM pulse_events
    WHERE user_id = ${userId} AND event_type = 'capability_creation'
      AND (status = 'candidate' OR (status = 'confirmed' AND confirmed_at >= ${pStart} AND confirmed_at < ${qEnd}))`);
  const capWeekly = Array(QUARTER_WEEKS).fill(0) as number[];
  let capNow = 0, capBefore = 0, pending = 0;
  for (const r of capRows) {
    if (r.status === 'candidate') { pending++; continue; }
    const at = n(r.confirmed_at);
    if (at >= qStart) { capNow++; capWeekly[weekIdx(at)]++; } else capBefore++;
  }

  // ── Time by hand (Claude's estimate) against measured time with Claude ──
  let humanTime: MyQuarter['humanTime'] = null;
  if (opts.showHumanTime && opts.humanTimeOn) {
    const parts: SQL[] = [];
    if (vendor !== 'openai') parts.push(sql`SELECT first_event_at AS at, human_minutes_likely AS likely, active_secs AS secs FROM cowork_session_stats
      WHERE user_id = ${userId} AND first_event_at >= ${qStart} AND first_event_at < ${qEnd} AND human_minutes_likely IS NOT NULL AND active_secs > 0`);
    if (vendor !== 'claude') parts.push(sql`SELECT first_at AS at, human_minutes_likely AS likely, active_secs AS secs FROM chatgpt_session_time
      WHERE user_id = ${userId} AND first_at >= ${qStart} AND first_at < ${qEnd} AND human_minutes_likely IS NOT NULL AND active_secs > 0`);
    const ht = await rows<{ at: number | string; likely: number | string; secs: number | string }>(sql.join(parts, sql` UNION ALL `));
    if (ht.length > 0) {
      const w = Array(QUARTER_WEEKS).fill(0) as number[];
      let likely = 0, secs = 0;
      for (const r of ht) { likely += n(r.likely); secs += n(r.secs); w[weekIdx(n(r.at))] += n(r.likely); }
      humanTime = { sessions: ht.length, likelyMinutes: likely, claudeMinutes: secs / 60, weekly: w };
    }
  }

  // ── What was produced: files Claude saved, sent or published, and the sessions behind them ──
  const outRows = await rows<{ session_id: string; output_name: string }>(sql`
    SELECT DISTINCT cm.session_id, cm.output_name FROM cowork_messages cm
    WHERE cm.user_id = ${userId} AND cm.output_name IS NOT NULL AND cm.occurred_at >= ${qStart} AND cm.occurred_at < ${qEnd} AND ${msgVendor}`);
  const kinds = new Map<string, number>();
  for (const r of outRows) {
    const k = OUTPUT_KIND[categorizeFilePath(r.output_name)] ?? 'Other';
    kinds.set(k, (kinds.get(k) ?? 0) + 1);
  }
  const sessRow = await rows<{ c: number | string }>(sql`
    SELECT COUNT(DISTINCT cm.session_id) AS c FROM cowork_messages cm
    WHERE cm.user_id = ${userId} AND cm.message_type = 'cowork_user_message' AND cm.occurred_at >= ${qStart} AND cm.occurred_at < ${qEnd} AND ${msgVendor}`);

  // ── Skills and connectors: the person's own, and what colleagues use that they don't ──
  const skillV = sql.raw(workPulseToolClause(vendor));
  const toolRows = await rows<{ type: 'skill' | 'connector'; name: string; user_id: string; c: number | string }>(sql`
    SELECT 'skill' AS type, skill_name AS name, user_id, COUNT(*) AS c FROM cowork_skill_invocations
      WHERE occurred_at >= ${qStart} AND occurred_at < ${qEnd} AND ${skillV}
        AND (user_id = ${userId} ${department ? sql`OR user_id IN (${deptMembers(department)})` : sql`OR TRUE`})
      GROUP BY skill_name, user_id
    UNION ALL
    SELECT 'connector' AS type, mcp_server AS name, user_id, COUNT(*) AS c FROM cowork_mcp_invocations
      WHERE occurred_at >= ${qStart} AND occurred_at < ${qEnd} AND ${skillV}
        AND mcp_server NOT IN ('workspace', 'cowork', 'Claude_in_Chrome')
        AND (user_id = ${userId} ${department ? sql`OR user_id IN (${deptMembers(department)})` : sql`OR TRUE`})
      GROUP BY mcp_server, user_id`);
  const own = new Map<string, number>();
  const others = new Map<string, { type: 'skill' | 'connector'; name: string; people: Set<string> }>();
  for (const r of toolRows) {
    if (!r.name || isBuiltInTool(r.type, r.name)) continue;
    const key = `${r.type}:${r.name}`;
    if (r.user_id === userId) { own.set(key, (own.get(key) ?? 0) + n(r.c)); continue; }
    const e = others.get(key) ?? { type: r.type, name: r.name, people: new Set<string>() };
    e.people.add(r.user_id);
    others.set(key, e);
  }
  const untried = [...others.entries()].filter(([k, e]) => !own.has(k) && e.people.size >= 2)
    .sort((a, b) => b[1].people.size - a[1].people.size).slice(0, 3).map(([, e]) => e);
  const library = untried.length === 0 ? [] : await rows<{ id: number | string; name: string; department: string | null }>(sql`
    SELECT id, name, department FROM skill_library_entries
    WHERE name IN (${sql.join(untried.map(t => sql`${t.name}`), sql`, `)})`);
  const libId = (name: string) => {
    const e = library.find(l => l.name === name && (!l.department || l.department === department));
    return e ? n(e.id) : null;
  };

  return {
    quarterStart: qStart,
    quarterEnd: qEnd,
    weeks,
    realWork: {
      now: sumReal(qWeeks), all: sumAll(qWeeks), before: sumReal(pWeeks),
      weekly: weekly.map(w => (w ? w.t2 + w.t3 : 0)), deptAverage,
    },
    share: {
      now: sumAll(qWeeks) > 0 ? sumReal(qWeeks) / sumAll(qWeeks) : null,
      before: sumAll(pWeeks) > 0 ? sumReal(pWeeks) / sumAll(pWeeks) : null,
      weekly: weekly.map(w => (w && w.t1 + w.t2 + w.t3 > 0 ? (w.t2 + w.t3) / (w.t1 + w.t2 + w.t3) : null)),
    },
    capabilities: { confirmed: capNow, before: capBefore, pending, weekly: capWeekly },
    humanTime,
    produced: {
      files: outRows.length,
      sessions: n(sessRow[0]?.c),
      byKind: [...kinds.entries()].map(([kind, files]) => ({ kind, files })).sort((a, b) => b.files - a.files),
    },
    colleagueTools: untried.map(t => ({ type: t.type, name: t.name, people: t.people.size, libraryId: libId(t.name) })),
    ownTools: [...own.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k]) => k.slice(k.indexOf(':') + 1)),
  };
}
