// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * The choices Work Pulse So What finds on its own, rather than the ones a leader asks about. Each is
 * a move, what it gets, and the proof, read from figures this product already holds:
 *
 *  - A kind of work several people in a team repeat with no skill behind it (Team coaching's rule),
 *    with the measured time it took, split by whether the session was meaningful work.
 *  - How long each wave of new people took to start doing meaningful work.
 *  - People who were given it and have hardly used it since.
 *  - Teams where one or two people hold most of the meaningful work.
 *  - A new way of working a manager confirmed in one team, where other teams do the same work.
 *  - A kind of work a team now does far quicker than it did two months ago: time it has freed.
 *  - A team doing much more of its AI work in the evening or at weekends than the organisation.
 *
 * Every find works on whatever platforms a customer has: none needs two to be in use. Time here is
 * MEASURED active time, never the by-hand estimate. Depth (meaningful or not) and the kind of work
 * are the classifier's judgement of each prompt, and the cards that use them say so.
 */
import { sql, type SQL } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { getConfigValue } from '@/lib/config';
import { vendorClause } from '@/lib/dashboard/product-sql';
import { skillVendor } from '@/lib/pulse/vendor-filter';
import { isWorkPulseSurface } from '@/lib/pulse/work-surfaces';
import { MECHANISM_TASK_TYPES } from '@/lib/finance/model-efficiency';
import { kindLabel } from '@/lib/pulse/cowork/coaching-words';
import {
  CHAMPION_SHARE, HARDLY_USED_SESSIONS, REPEAT_MIN_PEOPLE, REPEAT_MIN_PROMPTS,
} from '@/lib/pulse/cowork/coaching-figures';
import {
  MIN_GROUP, NO_DEPARTMENT, WINDOW_DAYS, departmentSql, readPromptRows, type PromptRow, type WorkData,
} from '@/lib/pulse/cowork/work-groups';
import { readWorkSessions, type WorkSession } from '@/lib/pulse/cowork/work-sessions';
import type { Vendor } from '@/lib/dashboard/vendor';

const DAY = 86400;
/** Each side of a job's time split needs this many measured sessions before it is shown. */
export const JOB_MIN_SESSIONS = 5;
/** How far back a person counts as having been given it and hardly used it since. */
export const RARELY_USED_DAYS = 90;
/** A team where this share of the meaningful work sits with one or two people relies on them. */
export const KEY_PERSON_SHARE = 0.6;
/** A wave of new people smaller than this is not a wave. */
export const WAVE_MIN_PEOPLE = 5;
/** Time freed compares the last WINDOW_DAYS with the WINDOW_DAYS that ended this many days ago. */
export const EARLIER_ENDS_DAYS = 60;
/** Each window needs this many measured sessions of the kind of work before they are compared. */
export const FREED_MIN_SESSIONS = 5;
/** A session of it has to take at least this much less time now to count as time freed... */
export const FREED_MIN_DROP = 0.2;
/** ...and free at least this many hours a month. */
export const FREED_MIN_HOURS = 1;
/** A team needs this many people, and this many prompts, before its hours are compared. */
export const EVENING_MIN_PEOPLE = 5;
export const EVENING_MIN_PROMPTS = 50;
/** Its share of work out of hours has to be at least this, and this many times the organisation's. */
export const EVENING_MIN_SHARE = 0.2;
export const EVENING_TIMES_ORG = 2;
/** Out of hours: before this hour or from this hour on a weekday, and all weekend, in local time. */
export const DAY_STARTS = 7;
export const DAY_ENDS = 19;

export interface StandardJob {
  department: string;
  taskType: string;
  label: string;
  people: number;
  prompts: number;
  sessions: number;
  /** Measured time across the job's sessions. Null when none was measured. */
  measuredHours: number | null;
  /** Measured minutes a session, in sessions that were meaningful work and in the rest. Each is
   *  null unless that side has JOB_MIN_SESSIONS measured sessions. */
  deepMinutes: number | null;
  otherMinutes: number | null;
  /** Share of the job's sessions that used a skill: the figure its follow-up reads. */
  skillShare: number;
}

export interface Wave {
  /** The month the wave started, as YYYY-MM. */
  month: string;
  people: number;
  /** How many of them have done meaningful work so far. */
  reached: number;
  /** Weeks from their first prompt to half the wave getting there. Null when half never did. */
  weeksToHalf: number | null;
}

export interface RarelyUsed { people: number; costAMonth: number | null; days: number }

export interface KeyPeople {
  department: string;
  people: number;
  /** How many people hold the share below. One or two. */
  holders: number;
  share: number;
  /** Kinds of work in the team only one person does at all. */
  soloKinds: number;
}

export interface TimeFreed {
  department: string;
  taskType: string;
  label: string;
  /** People in the team doing this work in the last WINDOW_DAYS. */
  people: number;
  /** Measured minutes a session, in the earlier window and now. */
  beforeMinutes: number;
  nowMinutes: number;
  /** The earlier window's first day, for the card to name the month. */
  beforeFrom: number;
  /** Sessions of it in the last WINDOW_DAYS, and the hours a month the quicker time frees at that rate. */
  sessions: number;
  hoursAMonth: number;
}

export interface Evenings {
  department: string;
  people: number;
  /** People in the team with any work out of hours. */
  peopleOutOfHours: number;
  /** Share of the team's prompts out of hours, and the organisation's. */
  share: number;
  orgShare: number;
  timezone: string;
}

export interface Rollout {
  eventId: number;
  title: string;
  department: string;
  confirmedAt: number;
  taskType: string;
  label: string;
  /** Other teams that did the same kind of work in the window, and how many people in them. */
  teams: number;
  people: number;
  /** Teams with a confirmed new way of working of this kind: the figure its follow-up reads. */
  teamsWithOne: number;
}

export interface WorkFinds {
  jobs: StandardJob[];
  waves: Wave[];
  rarelyUsed: RarelyUsed | null;
  keyPeople: KeyPeople[];
  rollouts: Rollout[];
  timeFreed: TimeFreed[];
  evenings: Evenings[];
}

const n = (v: unknown) => Number(v ?? 0);
const dept = (r: { department: string | null }) => r.department || NO_DEPARTMENT;

/**
 * A card a leader has decided on, as its card id and team. A find that has since stopped meeting
 * its rule is still read for these, so the decision can come back with what happened since.
 */
export type Kept = (cardId: string, department: string) => boolean;
const keepNone: Kept = () => false;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** The month a timestamp falls in, as YYYY-MM. */
export function monthOf(epochS: number): string {
  return new Date(epochS * 1000).toISOString().slice(0, 7);
}

/** Each session's kind of work (the one most of its prompts were) and whether it was meaningful work. */
function sessionKinds(rows: PromptRow[]): Map<string, { taskType: string; deep: boolean }> {
  const by = new Map<string, { kinds: Map<string, number>; prompts: number; deep: number }>();
  for (const r of rows) {
    if (!r.session_id || MECHANISM_TASK_TYPES.has(r.task_type)) continue;
    const e = by.get(r.session_id) ?? { kinds: new Map<string, number>(), prompts: 0, deep: 0 };
    e.kinds.set(r.task_type, (e.kinds.get(r.task_type) ?? 0) + 1);
    e.prompts++;
    if (n(r.tier) >= 2) e.deep++;
    by.set(r.session_id, e);
  }
  const out = new Map<string, { taskType: string; deep: boolean }>();
  for (const [id, e] of by) {
    const top = [...e.kinds.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    out.set(id, { taskType: top[0], deep: e.deep / e.prompts > CHAMPION_SHARE });
  }
  return out;
}

/** Work several people in a team repeat with no skill behind it, with the measured time it took. */
export function standardJobs(rows: PromptRow[], sessions: WorkSession[], sessionsWithSkill: Set<string>, kept: Kept = keepNone): StandardJob[] {
  const kindsBySession = sessionKinds(rows);
  const timeBySession = new Map(sessions.filter(s => s.activeSecs !== null && s.activeSecs > 0).map(s => [s.sessionId, s.activeSecs!]));
  const by = new Map<string, { department: string; taskType: string; prompts: number; people: Set<string>; sessions: Set<string>; withSkill: number }>();
  for (const r of rows) {
    if (MECHANISM_TASK_TYPES.has(r.task_type)) continue;
    const key = `${dept(r)}\u0000${r.task_type}`;
    const e = by.get(key) ?? { department: dept(r), taskType: r.task_type, prompts: 0, people: new Set<string>(), sessions: new Set<string>(), withSkill: 0 };
    e.prompts++;
    e.people.add(r.user_id);
    if (r.session_id) {
      e.sessions.add(r.session_id);
      if (sessionsWithSkill.has(r.session_id)) e.withSkill++;
    }
    by.set(key, e);
  }
  return [...by.values()]
    .filter(e => (e.prompts >= REPEAT_MIN_PROMPTS && e.people.size >= REPEAT_MIN_PEOPLE && e.withSkill === 0)
      || kept(`standard_job:${e.taskType}`, e.department))
    .map(e => {
      // The job's sessions are the ones whose main kind of work it was.
      const own = [...e.sessions].filter(id => kindsBySession.get(id)?.taskType === e.taskType);
      const timed = own.filter(id => timeBySession.has(id));
      const deep = timed.filter(id => kindsBySession.get(id)!.deep).map(id => timeBySession.get(id)! / 60);
      const other = timed.filter(id => !kindsBySession.get(id)!.deep).map(id => timeBySession.get(id)! / 60);
      const bothSides = deep.length >= JOB_MIN_SESSIONS && other.length >= JOB_MIN_SESSIONS;
      return {
        department: e.department,
        taskType: e.taskType,
        label: kindLabel(e.taskType),
        people: e.people.size,
        prompts: e.prompts,
        sessions: e.sessions.size,
        measuredHours: timed.length > 0 ? timed.reduce((a, id) => a + timeBySession.get(id)!, 0) / 3600 : null,
        deepMinutes: bothSides ? mean(deep) : null,
        otherMinutes: bothSides ? mean(other) : null,
        skillShare: e.sessions.size > 0 ? [...e.sessions].filter(id => sessionsWithSkill.has(id)).length / e.sessions.size : 0,
      };
    })
    .sort((a, b) => b.people - a.people || b.prompts - a.prompts);
}

/** Teams where one or two people hold most of the meaningful work. */
export function keyPeople(rows: PromptRow[], kept: Kept = keepNone): KeyPeople[] {
  const deepBy = new Map<string, Map<string, number>>();
  const teamPeople = new Map<string, Set<string>>();
  const kindPeople = new Map<string, Map<string, Map<string, number>>>();
  for (const r of rows) {
    const d = dept(r);
    if (!teamPeople.has(d)) teamPeople.set(d, new Set());
    teamPeople.get(d)!.add(r.user_id);
    if (!MECHANISM_TASK_TYPES.has(r.task_type)) {
      const kinds = kindPeople.get(d) ?? new Map<string, Map<string, number>>();
      const who = kinds.get(r.task_type) ?? new Map<string, number>();
      who.set(r.user_id, (who.get(r.user_id) ?? 0) + 1);
      kinds.set(r.task_type, who);
      kindPeople.set(d, kinds);
    }
    if (n(r.tier) < 2) continue;
    const t = deepBy.get(d) ?? new Map<string, number>();
    t.set(r.user_id, (t.get(r.user_id) ?? 0) + 1);
    deepBy.set(d, t);
  }
  const out: KeyPeople[] = [];
  for (const [department, counts] of deepBy) {
    const people = teamPeople.get(department)?.size ?? 0;
    if (people < MIN_GROUP + 1) continue;
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    if (total === 0) continue;
    const top = [...counts.values()].sort((a, b) => b - a);
    // Kinds of work only one person in the team does, on enough work to matter (Team coaching's rule).
    const soloKinds = [...(kindPeople.get(department)?.values() ?? [])]
      .filter(who => who.size === 1 && [...who.values()][0] >= REPEAT_MIN_PROMPTS).length;
    let found = false;
    for (const holders of [1, 2]) {
      const share = top.slice(0, holders).reduce((a, b) => a + b, 0) / total;
      if (share >= KEY_PERSON_SHARE) {
        out.push({ department, people, holders, share, soloKinds });
        found = true;
        break;
      }
    }
    // A decided team is still read, by the top two, so its follow-up has a figure to compare.
    if (!found && kept('key_people', department)) {
      out.push({ department, people, holders: 2, share: top.slice(0, 2).reduce((a, b) => a + b, 0) / total, soloKinds });
    }
  }
  return out.sort((a, b) => b.people - a.people || b.share - a.share);
}

/**
 * Kinds of work a team now does far quicker than it did: measured minutes a session in the last
 * WINDOW_DAYS against the WINDOW_DAYS that ended EARLIER_ENDS_DAYS ago, in sessions whose main kind
 * of work it was. Time in the tool, so it says the work got quicker, not that less of it was done.
 */
export function timeFreed(
  now: { rows: PromptRow[]; sessions: WorkSession[] },
  before: { rows: PromptRow[]; sessions: WorkSession[]; from: number },
  kept: Kept = keepNone,
): TimeFreed[] {
  const timed = (w: { rows: PromptRow[]; sessions: WorkSession[] }) => {
    const kinds = sessionKinds(w.rows);
    const team = new Map(w.rows.filter(r => r.session_id).map(r => [r.session_id!, dept(r)]));
    const by = new Map<string, number[]>();
    for (const s of w.sessions) {
      const k = kinds.get(s.sessionId);
      const d = team.get(s.sessionId);
      if (!k || !d || s.activeSecs === null || s.activeSecs <= 0) continue;
      const key = `${d}\u0000${k.taskType}`;
      const list = by.get(key) ?? [];
      list.push(s.activeSecs / 60);
      by.set(key, list);
    }
    return by;
  };
  const nowBy = timed(now);
  const beforeBy = timed(before);
  const out: TimeFreed[] = [];
  for (const [key, mins] of nowBy) {
    const earlier = beforeBy.get(key);
    if (!earlier || earlier.length < FREED_MIN_SESSIONS || mins.length < FREED_MIN_SESSIONS) continue;
    const [department, taskType] = key.split('\u0000');
    const beforeMinutes = mean(earlier);
    const nowMinutes = mean(mins);
    const hoursAMonth = (mins.length * (beforeMinutes - nowMinutes)) / 60;
    const qualifies = nowMinutes <= beforeMinutes * (1 - FREED_MIN_DROP) && hoursAMonth >= FREED_MIN_HOURS;
    if (!qualifies && !kept(`time_freed:${taskType}`, department)) continue;
    out.push({
      department,
      taskType,
      label: kindLabel(taskType),
      people: new Set(now.rows.filter(r => dept(r) === department && r.task_type === taskType).map(r => r.user_id)).size,
      beforeMinutes,
      nowMinutes,
      beforeFrom: before.from,
      sessions: mins.length,
      hoursAMonth: Math.max(0, hoursAMonth),
    });
  }
  return out.sort((a, b) => b.hoursAMonth - a.hoursAMonth);
}

/**
 * One formatter per timezone. Building an Intl.DateTimeFormat is slow (it loads the timezone's
 * rules), and building one per prompt made the evenings card most of So What's wait.
 */
const hourFormatters = new Map<string, Intl.DateTimeFormat>();
function hourFormatter(timezone: string): Intl.DateTimeFormat {
  let f = hourFormatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'short', hour: 'numeric', hourCycle: 'h23' });
    hourFormatters.set(timezone, f);
  }
  return f;
}

/** Whether a moment was out of hours in a timezone: a weekday evening or night, or the weekend. */
export function outOfHours(epochS: number, timezone: string): boolean {
  const parts = hourFormatter(timezone).formatToParts(new Date(epochS * 1000));
  const weekday = parts.find(p => p.type === 'weekday')?.value ?? '';
  const hour = Number(parts.find(p => p.type === 'hour')?.value ?? 12);
  return weekday === 'Sat' || weekday === 'Sun' || hour < DAY_STARTS || hour >= DAY_ENDS;
}

/** Every timezone's offset is a whole number of 15 minutes, so a 15-minute slot is all in or all out of hours. */
const SLOT_SECS = 15 * 60;

/** Teams doing far more of their AI work out of hours than the organisation. Counts only, never a person. */
export function evenings(rows: PromptRow[], timezone: string, kept: Kept = keepNone): Evenings[] {
  // Each 15-minute slot is worked out once: a busy hub has thousands of prompts in the same few slots.
  const bySlot = new Map<number, boolean>();
  const late = rows.map(r => {
    const at = n(r.occurred_at);
    const slot = Math.floor(at / SLOT_SECS);
    let v = bySlot.get(slot);
    if (v === undefined) { v = outOfHours(slot * SLOT_SECS, timezone); bySlot.set(slot, v); }
    return v;
  });
  const orgShare = rows.length > 0 ? late.filter(Boolean).length / rows.length : 0;
  const by = new Map<string, { prompts: number; late: number; people: Set<string>; latePeople: Set<string> }>();
  rows.forEach((r, i) => {
    const e = by.get(dept(r)) ?? { prompts: 0, late: 0, people: new Set<string>(), latePeople: new Set<string>() };
    e.prompts++;
    e.people.add(r.user_id);
    if (late[i]) { e.late++; e.latePeople.add(r.user_id); }
    by.set(dept(r), e);
  });
  const out: Evenings[] = [];
  for (const [department, e] of by) {
    if (department === NO_DEPARTMENT || e.people.size < EVENING_MIN_PEOPLE || e.prompts < EVENING_MIN_PROMPTS) continue;
    const share = e.late / e.prompts;
    const qualifies = share >= EVENING_MIN_SHARE && share >= orgShare * EVENING_TIMES_ORG;
    if (!qualifies && !kept('evenings', department)) continue;
    out.push({ department, people: e.people.size, peopleOutOfHours: e.latePeople.size, share, orgShare, timezone });
  }
  return out.sort((a, b) => b.share - a.share);
}

/** Everything the page finds on its own. `data` is the window So What already read. */
/** A confirmed new way of working, as read for the rollout finds. */
export interface ConfirmedWay { id: number | string; title: string; confirmed_at: number | string; task_type: string; department: string | null }

/**
 * Rollouts: each confirmed new way of working, and the other teams doing the same kind of work
 * without one. "No department" is not a team, so it is never counted as one, as on the evenings card.
 */
export function rolloutsFrom(confirmed: ConfirmedWay[], rows: PromptRow[], kept: Kept = keepNone): Rollout[] {
  const withOne = new Map<string, Set<string>>();
  for (const c of confirmed) {
    if (dept(c) === NO_DEPARTMENT) continue;
    const set = withOne.get(c.task_type) ?? new Set<string>();
    set.add(dept(c));
    withOne.set(c.task_type, set);
  }
  const rollouts: Rollout[] = [];
  for (const c of confirmed) {
    if (MECHANISM_TASK_TYPES.has(c.task_type)) continue;
    const others = rows.filter(r => r.task_type === c.task_type && dept(r) !== NO_DEPARTMENT && dept(r) !== dept(c)
      && !withOne.get(c.task_type)?.has(dept(r)));
    const teams = new Set(others.map(r => dept(r))).size;
    if (teams === 0 && !kept(`rollout:${n(c.id)}`, dept(c))) continue;
    rollouts.push({
      eventId: n(c.id),
      title: c.title,
      department: dept(c),
      confirmedAt: n(c.confirmed_at),
      taskType: c.task_type,
      label: kindLabel(c.task_type),
      teams,
      people: new Set(others.map(r => r.user_id)).size,
      teamsWithOne: withOne.get(c.task_type)?.size ?? 0,
    });
  }
  return rollouts;
}

export async function getWorkFinds(vendor: Vendor, data: WorkData, kept: Kept = keepNone, nowS = Math.floor(Date.now() / 1000)): Promise<WorkFinds> {
  const since = nowS - WINDOW_DAYS * DAY;
  const client = await getTypedClient();
  const run = async (q: SQL) =>
    (await (client as unknown as { execute: (query: SQL) => Promise<{ rows: unknown[] }> }).execute(q)).rows;
  const onWorkPulse = sql`${isWorkPulseSurface(sql`cm.surface`, true)} AND ${sql.raw(vendorClause(vendor, 'cm.'))}`;

  // Which sessions used a skill at all, for work worth making a standard skill.
  const skillRows = (await run(sql`
    SELECT DISTINCT session_id FROM cowork_skill_invocations WHERE occurred_at >= ${since} AND ${skillVendor(vendor)}
  `)) as Array<{ session_id: string }>;
  const sessionsWithSkill = new Set(skillRows.map(r => r.session_id));
  const allJobs = standardJobs(data.rows, data.sessions, sessionsWithSkill, kept);
  // The earlier window for time freed: the WINDOW_DAYS that ended EARLIER_ENDS_DAYS ago.
  const earlierFrom = nowS - (EARLIER_ENDS_DAYS + WINDOW_DAYS) * DAY;
  const earlierUntil = nowS - EARLIER_ENDS_DAYS * DAY;
  const earlier = {
    rows: await readPromptRows(vendor, earlierFrom, earlierUntil),
    sessions: await readWorkSessions({ since: earlierFrom, until: earlierUntil, vendor }),
    from: earlierFrom,
  };
  // Out of hours is read in the organisation's own timezone (Admin, the one telemetry alerts use).
  const timezone = (await getConfigValue('telemetrySilenceTimezone')) || 'Europe/London';
  const keptOrTop = <T>(xs: T[], isKept: (x: T) => boolean, top: number) =>
    xs.filter((x, i) => i < top || isKept(x));
  const jobs = keptOrTop(allJobs, j => kept(`standard_job:${j.taskType}`, j.department), 2);

  // Each person's first judged prompt ever, and their first meaningful one.
  const firstRows = (await run(sql`
    SELECT pc.user_id, MIN(cm.occurred_at) AS first_at,
           MIN(CASE WHEN pc.tier >= 2 THEN cm.occurred_at END) AS first_deep_at
    FROM pulse_classifications pc
    JOIN cowork_messages cm ON cm.id = pc.cowork_message_id
    WHERE pc.classifier_status = 'classified' AND ${onWorkPulse}
    GROUP BY pc.user_id
  `)) as Array<{ user_id: string; first_at: number | string; first_deep_at: number | string | null }>;
  const byMonth = new Map<string, Array<{ firstAt: number; firstDeepAt: number | null }>>();
  for (const r of firstRows) {
    const firstAt = n(r.first_at);
    if (firstAt <= 0) continue;
    const list = byMonth.get(monthOf(firstAt)) ?? [];
    list.push({ firstAt, firstDeepAt: r.first_deep_at === null ? null : n(r.first_deep_at) });
    byMonth.set(monthOf(firstAt), list);
  }
  const waves: Wave[] = [...byMonth.entries()]
    .filter(([, ps]) => ps.length >= WAVE_MIN_PEOPLE)
    .map(([month, ps]) => {
      const weeks = ps.filter(p => p.firstDeepAt !== null).map(p => (p.firstDeepAt! - p.firstAt) / (7 * DAY)).sort((a, b) => a - b);
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

  // People who have used it and have hardly used it since: fewer than two sessions in 90 days.
  const rarelyRows = (await run(sql`
    SELECT COUNT(*) AS people FROM (
      SELECT cm.user_id,
             COUNT(DISTINCT CASE WHEN cm.occurred_at >= ${nowS - RARELY_USED_DAYS * DAY} THEN cm.session_id END) AS recent
      FROM cowork_messages cm
      WHERE cm.message_type = 'cowork_user_message' AND cm.user_id IS NOT NULL AND ${onWorkPulse}
      GROUP BY cm.user_id
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

  // New ways of working a manager confirmed, with the kind of work they were found in.
  const confirmed = (await run(sql`
    SELECT pe.id, pe.title, pe.confirmed_at, pc.task_type, ${departmentSql()} AS department
    FROM pulse_events pe
    JOIN cowork_messages cm ON cm.id = pe.cowork_message_id
    JOIN pulse_classifications pc ON pc.cowork_message_id = pe.cowork_message_id
    LEFT JOIN users u ON u.id = pe.user_id
    LEFT JOIN admin_users au ON au.linked_cowork_user_id = pe.user_id
    WHERE pe.event_type = 'capability_creation' AND pe.status = 'confirmed' AND pe.confirmed_at IS NOT NULL
      AND ${onWorkPulse}
    ORDER BY pe.confirmed_at DESC
  `)) as ConfirmedWay[];
  const rollouts = rolloutsFrom(confirmed, data.rows, kept);

  return {
    jobs,
    waves,
    rarelyUsed,
    keyPeople: keptOrTop(keyPeople(data.rows, kept), k => kept('key_people', k.department), 2),
    rollouts: keptOrTop(rollouts.sort((a, b) => b.people - a.people), r => kept(`rollout:${r.eventId}`, r.department), 2),
    timeFreed: keptOrTop(timeFreed(data, earlier, kept), t => kept(`time_freed:${t.taskType}`, t.department), 2),
    evenings: keptOrTop(evenings(data.rows, timezone, kept), e => kept('evenings', e.department), 2),
  };
}
