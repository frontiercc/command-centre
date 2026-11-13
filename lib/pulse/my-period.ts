// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Work Pulse figures for one period: this week, this month or this quarter, each against the
 * same length before it. One person (My Pulse, Users) or a set of people (Departments). Every window ENDS NOW, so work done today counts and someone in their first
 * week sees their own figures the day they start.
 *
 * Trend bars follow the window: one bar a day for the week and the month, one a week for the
 * quarter. The depth chart reads a year of completed weeks separately, for its longer settings.
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
import { PERIOD_SHAPE, type MyPeriod, type PeriodTierWeek, type PulsePeriod } from '@/lib/pulse/period-shape';

export { PERIOD_SHAPE };
export type { MyPeriod, PulsePeriod, PeriodTierWeek } from '@/lib/pulse/period-shape';

const DAY = 86400;
const WEEK = 7 * DAY;

interface Exec { execute: (q: SQL) => Promise<{ rows: unknown[] }> }
async function rows<T>(q: SQL): Promise<T[]> {
  const client = (await getTypedClient()) as unknown as Exec;
  return (await client.execute(q)).rows as T[];
}
const n = (v: unknown) => Number(v ?? 0);

function mondayOf(ts: number): number {
  const d = new Date(ts * 1000);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
  return midnight - ((d.getUTCDay() + 6) % 7) * DAY;
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

export async function buildMyPeriod(opts: {
  /** One person, or a set of people for a department. */
  userId?: string;
  userIds?: string[];
  department: string | null;
  vendor: Vendor;
  nowS: number;
  period: PulsePeriod;
  /** Whether this viewer may see the person's by-hand estimate (admin, manager or self). */
  showHumanTime: boolean;
  humanTimeOn: boolean;
}): Promise<MyPeriod> {
  const { userId, userIds, department, vendor, period } = opts;
  const group = Array.isArray(userIds);
  const ownIds = new Set(group ? userIds! : [userId!]);
  if (ownIds.size === 0) ownIds.add('__none__');
  const idList = sql.join([...ownIds].map(id => sql`${id}`), sql`, `);
  // "the people this page is about": one person, or a department's members.
  const whoIn = (col: string) => sql`${sql.raw(col)} IN (${idList})`;
  const { buckets, bucketSecs } = PERIOD_SHAPE[period];
  const end = opts.nowS;
  const start = end - buckets * bucketSecs;
  const priorStart = start - buckets * bucketSecs;
  const bucketOf = (ts: number) => Math.min(buckets - 1, Math.max(0, Math.floor((ts - start) / bucketSecs)));
  const msgVendor = sql.raw(vendorClause(vendor, 'cm.'));
  const zeros = () => Array(buckets).fill(0) as number[];

  // ── Every classified task in this window and the one before, by bucket and tier ──
  const taskRows = await rows<{ at: number | string; tier: number | string }>(sql`
    SELECT cm.occurred_at AS at, pc.tier AS tier
    FROM pulse_classifications pc JOIN cowork_messages cm ON cm.id = pc.cowork_message_id
    WHERE ${whoIn('pc.user_id')} AND pc.classifier_status = 'classified'
      AND cm.occurred_at >= ${priorStart} AND cm.occurred_at < ${end} AND ${msgVendor}`);
  const realTrend = zeros();
  const allTrend = zeros();
  let nowReal = 0, nowAll = 0, beforeReal = 0, beforeAll = 0;
  for (const r of taskRows) {
    const at = n(r.at), real = n(r.tier) >= 2;
    if (at < start) { beforeAll++; if (real) beforeReal++; continue; }
    nowAll++; allTrend[bucketOf(at)]++;
    if (real) { nowReal++; realTrend[bucketOf(at)]++; }
  }

  // ── A year of completed weeks for the depth chart, and six weeks counting back from today ──
  const yearStart = mondayOf(end) - 52 * WEEK;
  const weekRows = await rows<{ wk: number | string; tier: number | string; c: number | string }>(sql`
    SELECT FLOOR((cm.occurred_at - ${yearStart}) / ${WEEK}) AS wk, pc.tier AS tier, COUNT(*) AS c
    FROM pulse_classifications pc JOIN cowork_messages cm ON cm.id = pc.cowork_message_id
    WHERE ${whoIn('pc.user_id')} AND pc.classifier_status = 'classified'
      AND cm.occurred_at >= ${yearStart} AND ${msgVendor}
    GROUP BY 1, 2`);
  const byWeek = new Map<number, PeriodTierWeek>();
  for (const r of weekRows) {
    const ws = yearStart + n(r.wk) * WEEK;
    const w = byWeek.get(ws) ?? { weekStart: ws, t1: 0, t2: 0, t3: 0 };
    const t = n(r.tier);
    if (t === 1) w.t1 += n(r.c); else if (t === 2) w.t2 += n(r.c); else if (t >= 3) w.t3 += n(r.c);
    byWeek.set(ws, w);
  }
  const thisWeek = mondayOf(end);
  const weeks = [...byWeek.values()].filter(w => w.weekStart < thisWeek).sort((a, b) => a.weekStart - b.weekStart);
  // The grid includes the week in progress, so a first week shows the day it starts.
  const grid = Array.from({ length: 6 }, (_, i) => {
    const ws = thisWeek - (5 - i) * WEEK;
    return byWeek.get(ws) ?? { weekStart: ws, t1: 0, t2: 0, t3: 0 };
  });

  // A department also says how many of its people did any of this work.
  let people: { deep: number; active: number } | null = null;
  if (group) {
    const pr = await rows<{ deep: number | string; active: number | string }>(sql`
      SELECT COUNT(DISTINCT CASE WHEN pc.tier >= 2 THEN pc.user_id END) AS deep,
             COUNT(DISTINCT pc.user_id) AS active
      FROM pulse_classifications pc JOIN cowork_messages cm ON cm.id = pc.cowork_message_id
      WHERE ${whoIn('pc.user_id')} AND pc.classifier_status = 'classified'
        AND cm.occurred_at >= ${start} AND cm.occurred_at < ${end} AND ${msgVendor}`);
    people = { deep: n(pr[0]?.deep), active: n(pr[0]?.active) };
  }

  // What to compare with: a person against their department, a department against the organisation.
  let deptAverage: number | null = null;
  if (group) {
    const d = await rows<{ people: number | string; real: number | string }>(sql`
      SELECT COUNT(DISTINCT pc.user_id) AS people, SUM(CASE WHEN pc.tier >= 2 THEN 1 ELSE 0 END) AS real
      FROM pulse_classifications pc JOIN cowork_messages cm ON cm.id = pc.cowork_message_id
      WHERE pc.classifier_status = 'classified' AND NOT ${whoIn('pc.user_id')}
        AND cm.occurred_at >= ${start} AND cm.occurred_at < ${end} AND ${msgVendor}`);
    const n2 = n(d[0]?.people);
    deptAverage = n2 >= 3 && ownIds.size > 0 ? (n(d[0]?.real) / n2) * ownIds.size : null;
  } else if (department) {
    const d = await rows<{ people: number | string; real: number | string }>(sql`
      SELECT COUNT(DISTINCT pc.user_id) AS people, SUM(CASE WHEN pc.tier >= 2 THEN 1 ELSE 0 END) AS real
      FROM pulse_classifications pc JOIN cowork_messages cm ON cm.id = pc.cowork_message_id
      WHERE pc.classifier_status = 'classified' AND pc.user_id IN (${deptMembers(department)})
        AND cm.occurred_at >= ${start} AND cm.occurred_at < ${end} AND ${msgVendor}`);
    const people = n(d[0]?.people);
    deptAverage = people >= 3 ? n(d[0]?.real) / people : null;
  }

  // ── New ways of working: confirmed capabilities by the bucket they were confirmed in ──
  const capRows = await rows<{ confirmed_at: number | string | null; status: string }>(sql`
    SELECT confirmed_at, status FROM pulse_events
    WHERE ${whoIn('user_id')} AND event_type = 'capability_creation'
      AND (status = 'candidate' OR (status = 'confirmed' AND confirmed_at >= ${priorStart} AND confirmed_at < ${end}))`);
  const capTrend = zeros();
  let capNow = 0, capBefore = 0, pending = 0;
  for (const r of capRows) {
    if (r.status === 'candidate') { pending++; continue; }
    const at = n(r.confirmed_at);
    if (at >= start) { capNow++; capTrend[bucketOf(at)]++; } else capBefore++;
  }

  // ── Time by hand (Claude's estimate) against measured time with Claude ──
  let humanTime: MyPeriod['humanTime'] = null;
  if (opts.showHumanTime && opts.humanTimeOn) {
    const parts: SQL[] = [];
    if (vendor !== 'openai') parts.push(sql`SELECT first_event_at AS at, human_minutes_likely AS likely, active_secs AS secs FROM cowork_session_stats
      WHERE ${whoIn('user_id')} AND first_event_at >= ${start} AND first_event_at < ${end} AND human_minutes_likely IS NOT NULL AND active_secs > 0`);
    if (vendor !== 'claude') parts.push(sql`SELECT first_at AS at, human_minutes_likely AS likely, active_secs AS secs FROM chatgpt_session_time
      WHERE ${whoIn('user_id')} AND first_at >= ${start} AND first_at < ${end} AND human_minutes_likely IS NOT NULL AND active_secs > 0`);
    const ht = await rows<{ at: number | string; likely: number | string; secs: number | string }>(sql.join(parts, sql` UNION ALL `));
    if (ht.length > 0) {
      const trend = zeros();
      let likely = 0, secs = 0;
      for (const r of ht) { likely += n(r.likely); secs += n(r.secs); trend[bucketOf(n(r.at))] += n(r.likely); }
      humanTime = { sessions: ht.length, likelyMinutes: likely, claudeMinutes: secs / 60, trend };
    }
  }

  // ── What was produced: files Claude saved, sent or published, and the sessions behind them ──
  const outRows = await rows<{ session_id: string; output_name: string }>(sql`
    SELECT DISTINCT cm.session_id, cm.output_name FROM cowork_messages cm
    WHERE ${whoIn('cm.user_id')} AND cm.output_name IS NOT NULL
      AND cm.occurred_at >= ${start} AND cm.occurred_at < ${end} AND ${msgVendor}`);
  const kinds = new Map<string, number>();
  for (const r of outRows) {
    const k = OUTPUT_KIND[categorizeFilePath(r.output_name)] ?? 'Other';
    kinds.set(k, (kinds.get(k) ?? 0) + 1);
  }
  const sessRow = await rows<{ c: number | string }>(sql`
    SELECT COUNT(DISTINCT cm.session_id) AS c FROM cowork_messages cm
    WHERE ${whoIn('cm.user_id')} AND cm.message_type = 'cowork_user_message'
      AND cm.occurred_at >= ${start} AND cm.occurred_at < ${end} AND ${msgVendor}`);

  // ── Skills and connectors: the person's own, and what colleagues use that they don't ──
  const toolV = sql.raw(workPulseToolClause(vendor));
  const toolRows = await rows<{ type: 'skill' | 'connector'; name: string; user_id: string; c: number | string }>(sql`
    SELECT 'skill' AS type, skill_name AS name, user_id, COUNT(*) AS c FROM cowork_skill_invocations
      WHERE occurred_at >= ${start} AND occurred_at < ${end} AND ${toolV}
        ${group ? sql`` : department ? sql`AND (${whoIn('user_id')} OR user_id IN (${deptMembers(department)}))` : sql``}
      GROUP BY skill_name, user_id
    UNION ALL
    SELECT 'connector' AS type, mcp_server AS name, user_id, COUNT(*) AS c FROM cowork_mcp_invocations
      WHERE occurred_at >= ${start} AND occurred_at < ${end} AND ${toolV}
        AND mcp_server NOT IN ('workspace', 'cowork', 'Claude_in_Chrome')
        ${group ? sql`` : department ? sql`AND (${whoIn('user_id')} OR user_id IN (${deptMembers(department)}))` : sql``}
      GROUP BY mcp_server, user_id`);
  const own = new Map<string, number>();
  const others = new Map<string, { type: 'skill' | 'connector'; name: string; people: Set<string> }>();
  for (const r of toolRows) {
    if (!r.name || isBuiltInTool(r.type, r.name)) continue;
    const key = `${r.type}:${r.name}`;
    if (ownIds.has(r.user_id)) { own.set(key, (own.get(key) ?? 0) + n(r.c)); continue; }
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
    period,
    start,
    end,
    weeks,
    grid,
    people,
    realWork: { now: nowReal, all: nowAll, before: beforeReal, beforeAll, trend: realTrend, deptAverage },
    share: {
      now: nowAll > 0 ? nowReal / nowAll : null,
      before: beforeAll > 0 ? beforeReal / beforeAll : null,
      trend: allTrend.map((all, i) => (all > 0 ? realTrend[i] / all : null)),
    },
    capabilities: { confirmed: capNow, before: capBefore, pending, trend: capTrend },
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
