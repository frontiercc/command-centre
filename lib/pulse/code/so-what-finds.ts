// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * The choices So what finds on its own, rather than the ones a leader asks about. Each is a move,
 * what it gets, and the proof, read from figures this product already holds.
 *
 *  - A recurring job where the people who hand it over whole finish it far quicker than the rest.
 *  - How long each wave of new engineers took to start handing whole work over.
 *  - People who were given it and have hardly touched it since.
 *  - Teams where one or two people hold all the handed-over work.
 *
 * Time here is MEASURED active time on both sides, never Claude's estimate of how long a job would
 * have taken by hand. The two groups follow the same rule as everything else on the page.
 */
import { sql, type SQL } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { codeSessionVendor } from '@/lib/pulse/code/vendor-view';
import { getCodeWorkTypeDefinitions } from '@/lib/pulse/code/tier-config';
import { codeWorkTypeLabel } from '@/lib/pulse/code/work-type-labels';
import { getConfigValue } from '@/lib/config';
import { DEEP_PERSON_SHARE, HARDLY_USED_SESSIONS, MIN_GROUP, WINDOW_DAYS } from '@/lib/pulse/code/output-groups';
import type { Vendor } from '@/lib/dashboard/vendor';

const DAY = 86400;
/** A job needs this many sessions on each side before its timings are worth comparing. */
export const JOB_MIN_SESSIONS = 10;
/** ...and the quicker side has to be at least this much quicker to be worth a move. */
export const JOB_MIN_SAVING = 0.15;
/** How far back a person counts as having been given it and hardly used it since. */
export const RARELY_USED_DAYS = 90;
/** A team where this share of handed-over work sits with one or two people is a key-person risk. */
export const KEY_PERSON_SHARE = 0.6;
/** A wave of joiners smaller than this is not a wave. */
export const WAVE_MIN_PEOPLE = 5;

export interface StandardJob {
  workType: string;
  label: string;
  people: number;
  deepPeople: number;
  deepMinutes: number;
  shallowPeople: number;
  shallowSessions: number;
  shallowMinutes: number;
  /** Hours a month freed if the slower side worked like the quicker one. */
  hoursAMonth: number;
}

export interface Wave {
  /** The month the wave started, as YYYY-MM. */
  month: string;
  people: number;
  /** How many of them now hand whole pieces of work over. */
  reached: number;
  /** Weeks from their first session to half the wave getting there. Null when half never did. */
  weeksToHalf: number | null;
}

export interface RarelyUsed {
  people: number;
  /** What those people cost a month, only where an admin has set a seat price. */
  costAMonth: number | null;
  days: number;
}

export interface KeyPeople {
  department: string;
  people: number;
  /** How many people hold the share below. One or two. */
  holders: number;
  share: number;
}

export interface Finds {
  jobs: StandardJob[];
  waves: Wave[];
  rarelyUsed: RarelyUsed | null;
  keyPeople: KeyPeople[];
}

interface SessionRow {
  user_id: string;
  department: string | null;
  work_type: string;
  tier: number | string;
  active_secs: number | string | null;
  last_at: number | string;
}

const n = (v: unknown) => Number(v ?? 0);
const NO_DEPARTMENT = 'No department';

function departmentSql(): SQL {
  return sql`COALESCE(NULLIF(au.department, ''), NULLIF(u.department, ''))`;
}

/** The month a timestamp falls in, as YYYY-MM. */
export function monthOf(epochS: number): string {
  return new Date(epochS * 1000).toISOString().slice(0, 7);
}

/** Jobs where the people who hand them over whole finish far quicker, worth making the standard way. */
export function standardJobs(rows: SessionRow[], deepPeople: Set<string>, labels: Map<string, string | undefined>): StandardJob[] {
  const by = new Map<string, { deep: number[]; shallow: number[]; deepWho: Set<string>; shallowWho: Set<string> }>();
  for (const r of rows) {
    const mins = n(r.active_secs) / 60;
    if (mins <= 0) continue;
    const e = by.get(r.work_type) ?? { deep: [], shallow: [], deepWho: new Set<string>(), shallowWho: new Set<string>() };
    if (deepPeople.has(r.user_id)) { e.deep.push(mins); e.deepWho.add(r.user_id); }
    else { e.shallow.push(mins); e.shallowWho.add(r.user_id); }
    by.set(r.work_type, e);
  }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return [...by.entries()]
    .filter(([, v]) =>
      v.deep.length >= JOB_MIN_SESSIONS && v.shallow.length >= JOB_MIN_SESSIONS &&
      v.deepWho.size >= MIN_GROUP && v.shallowWho.size >= MIN_GROUP &&
      mean(v.deep) < mean(v.shallow) * (1 - JOB_MIN_SAVING))
    .map(([workType, v]) => {
      const deepMinutes = mean(v.deep);
      const shallowMinutes = mean(v.shallow);
      return {
        workType,
        label: codeWorkTypeLabel(workType, labels.get(workType)),
        people: v.deepWho.size + v.shallowWho.size,
        deepPeople: v.deepWho.size,
        deepMinutes,
        shallowPeople: v.shallowWho.size,
        shallowSessions: v.shallow.length,
        shallowMinutes,
        hoursAMonth: (v.shallow.length * (shallowMinutes - deepMinutes)) / 60,
      };
    })
    .sort((a, b) => b.hoursAMonth - a.hoursAMonth);
}

/** Teams where one or two people hold most of the handed-over work. */
export function keyPeople(rows: SessionRow[]): KeyPeople[] {
  const byTeam = new Map<string, Map<string, number>>();
  const teamPeople = new Map<string, Set<string>>();
  for (const r of rows) {
    const d = r.department || NO_DEPARTMENT;
    if (!teamPeople.has(d)) teamPeople.set(d, new Set());
    teamPeople.get(d)!.add(r.user_id);
    if (n(r.tier) < 2) continue;
    const t = byTeam.get(d) ?? new Map<string, number>();
    t.set(r.user_id, (t.get(r.user_id) ?? 0) + 1);
    byTeam.set(d, t);
  }
  const out: KeyPeople[] = [];
  for (const [department, counts] of byTeam) {
    const people = teamPeople.get(department)?.size ?? 0;
    if (people < MIN_GROUP + 1) continue;
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    if (total === 0) continue;
    const top = [...counts.values()].sort((a, b) => b - a);
    for (const holders of [1, 2]) {
      const share = top.slice(0, holders).reduce((a, b) => a + b, 0) / total;
      if (share >= KEY_PERSON_SHARE) {
        out.push({ department, people, holders, share });
        break;
      }
    }
  }
  return out.sort((a, b) => b.share - a.share);
}

/** Everything the page finds on its own. */
export async function getFinds(vendor: Vendor, nowS = Math.floor(Date.now() / 1000)): Promise<Finds> {
  const since = nowS - WINDOW_DAYS * DAY;
  const client = await getTypedClient();
  const run = async (q: SQL) =>
    (await (client as unknown as { execute: (query: SQL) => Promise<{ rows: unknown[] }> }).execute(q)).rows;

  const rows = (await run(sql`
    SELECT csc.user_id, ${departmentSql()} AS department, csc.work_type, csc.tier,
           css.active_secs, css.last_at
    FROM code_session_classifications csc
    JOIN code_session_stats css ON css.session_id = csc.session_id
    LEFT JOIN users u ON u.id = csc.user_id
    LEFT JOIN admin_users au ON au.linked_cowork_user_id = csc.user_id
    WHERE csc.status = 'classified' AND css.last_at >= ${since}
      AND ${codeSessionVendor(sql`css.session_id`, vendor)}
  `)) as SessionRow[];

  // Who hands whole pieces of work over, by the same rule the rest of the page uses.
  const perPerson = new Map<string, { sessions: number; deep: number }>();
  for (const r of rows) {
    const e = perPerson.get(r.user_id) ?? { sessions: 0, deep: 0 };
    e.sessions++;
    if (n(r.tier) >= 2) e.deep++;
    perPerson.set(r.user_id, e);
  }
  const deepPeople = new Set(
    [...perPerson.entries()]
      .filter(([, v]) => v.sessions >= HARDLY_USED_SESSIONS && v.deep / v.sessions > DEEP_PERSON_SHARE)
      .map(([id]) => id),
  );

  // Each person's first session ever, and the first one they handed whole work over in.
  const firstRows = (await run(sql`
    SELECT css.user_id,
           MIN(css.first_at) AS first_at,
           MIN(CASE WHEN csc.tier >= 2 THEN css.first_at END) AS first_deep_at
    FROM code_session_stats css
    LEFT JOIN code_session_classifications csc
      ON csc.session_id = css.session_id AND csc.status = 'classified'
    WHERE ${codeSessionVendor(sql`css.session_id`, vendor)}
    GROUP BY css.user_id
  `)) as Array<{ user_id: string; first_at: number | string; first_deep_at: number | string | null }>;

  const byMonth = new Map<string, Array<{ firstAt: number; firstDeepAt: number | null }>>();
  for (const r of firstRows) {
    const firstAt = n(r.first_at);
    if (firstAt <= 0) continue;
    const month = monthOf(firstAt);
    const list = byMonth.get(month) ?? [];
    list.push({ firstAt, firstDeepAt: r.first_deep_at === null ? null : n(r.first_deep_at) });
    byMonth.set(month, list);
  }
  const waves: Wave[] = [...byMonth.entries()]
    .filter(([, ps]) => ps.length >= WAVE_MIN_PEOPLE)
    .map(([month, ps]) => {
      const weeks = ps
        .filter(p => p.firstDeepAt !== null)
        .map(p => (p.firstDeepAt! - p.firstAt) / (7 * DAY))
        .sort((a, b) => a - b);
      const halfway = Math.ceil(ps.length / 2);
      return {
        month,
        people: ps.length,
        reached: weeks.length,
        weeksToHalf: weeks.length >= halfway ? Math.max(0, Math.round(weeks[halfway - 1] * 10) / 10) : null,
      };
    })
    .sort((a, b) => b.month.localeCompare(a.month))
    .slice(0, 6);

  // People who were given it and have hardly used it since.
  const rarelyRows = (await run(sql`
    SELECT COUNT(*) AS people FROM (
      SELECT css.user_id,
             SUM(CASE WHEN css.last_at >= ${nowS - RARELY_USED_DAYS * DAY} THEN 1 ELSE 0 END) AS recent
      FROM code_session_stats css
      WHERE ${codeSessionVendor(sql`css.session_id`, vendor)}
      GROUP BY css.user_id
    ) q WHERE q.recent < ${HARDLY_USED_SESSIONS}
  `)) as Array<{ people: number | string }>;
  const rarelyCount = n(rarelyRows[0]?.people);
  const seatPrice = Number(await getConfigValue('finopsSeatPriceMonthly'));
  const rarelyUsed: RarelyUsed | null = rarelyCount > 0
    ? {
        people: rarelyCount,
        // Never invented: no price set, no cost shown.
        costAMonth: Number.isFinite(seatPrice) && seatPrice > 0 ? rarelyCount * seatPrice : null,
        days: RARELY_USED_DAYS,
      }
    : null;

  const labels = await getCodeWorkTypeDefinitions();
  return {
    // Capped at two so recurring jobs cannot fill the page and hide the other kinds of find.
    jobs: standardJobs(rows, deepPeople, labels).slice(0, 2),
    waves,
    rarelyUsed,
    keyPeople: keyPeople(rows).slice(0, 3),
  };
}
