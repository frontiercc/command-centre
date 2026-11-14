// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * The figures Work Pulse Team coaching reads, for a department and for the organisation, from the
 * signals this product already has: the Cowork classifier's tiers and kinds of work, and the
 * measured session stats behind them. No model call.
 *
 * A team is a person's department, resolved as everywhere else: the login account's first, then the
 * monitored record's. Windows are the last 30 whole days against the 30 before, counted on when the
 * prompt happened, which is what the rest of Work Pulse counts on.
 *
 * The unit is the prompt, not the session, because that is what the Work Pulse classifier judges.
 * Where a figure is about a whole session (what it freed, whether anything came out of it) the
 * sessions are read on their own, so one long session is not counted once per prompt.
 *
 * Every platform Work Pulse covers is read: Claude Cowork, Claude in Office/Google, Claude Chat and
 * ChatGPT, narrowed by the All / Claude / ChatGPT switch. Sessions come from
 * lib/pulse/cowork/work-sessions.ts, so a platform is never counted two ways.
 */
import { sql, type SQL } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { getTierNames } from '@/lib/pulse/tier-config';
import { MECHANISM_TASK_TYPES } from '@/lib/finance/model-efficiency';
import { getConfigValue } from '@/lib/config';
import { kindLabel } from '@/lib/pulse/cowork/coaching-words';
import { vendorClause } from '@/lib/dashboard/product-sql';
import { isWorkPulseSurface } from '@/lib/pulse/work-surfaces';
import { skillVendor } from '@/lib/pulse/vendor-filter';
import { readSessionsPerPerson, readWorkSessions, type WorkPlatform } from '@/lib/pulse/cowork/work-sessions';
import type { Vendor } from '@/lib/dashboard/vendor';
import type { TierNames } from '@/lib/pulse/tier-names';

const DAY = 86400;
/** Under this many people a team's shares are counted but never turned into a share. */
export const MIN_TEAM_PEOPLE = 3;
/** Someone with fewer sessions than this in the window has hardly used it. */
export const HARDLY_USED_SESSIONS = 2;
/** Someone whose meaningful share is above this is one to learn from. */
export const CHAMPION_SHARE = 0.5;
/** ...on at least this much work. The unit here is the prompt, so a handful proves nothing. */
export const CHAMPION_MIN_PROMPTS = 10;
/** Someone with at least this many prompts is using it properly, whatever they get back. */
export const STUCK_MIN_PROMPTS = 15;
/** ...and below this share of meaningful work, they are getting little back. */
export const STUCK_SHARE = 0.2;
/** A kind of work repeated at least this many times, by this many people, with no skill behind it. */
export const REPEAT_MIN_PROMPTS = 8;
export const REPEAT_MIN_PEOPLE = 3;
/** Someone whose first prompt was within this many days is still finding their feet. */
export const NEW_STARTER_DAYS = 42;
/** Below this many finished sessions, "produced nothing" is not a share worth reading. */
export const OUTPUT_MIN_SESSIONS = 5;
/** At or above this share of sessions producing nothing, there is something to say. */
export const PRODUCED_NOTHING_SHARE = 0.6;
/** At most this many produced sessions are listed per team, newest first. */
export const PRODUCED_LIST_MAX = 200;
/** At most this many people are named as ones to learn from, per team. */
export const CHAMPIONS_PER_TEAM = 3;
/** A team this far below the organisation, as a share, is behind it. */
export const BEHIND_ORG = 0.1;
/** The depth floor an admin has not set (Admin → System, "Department depth floor"). */
export const DEFAULT_DEPTH_FLOOR = 33;

export interface KindShare { taskType: string; label: string; prompts: number; share: number }

export interface CoworkTeamFigures {
  department: string;
  people: number;
  prompts: number;
  sessions: number;
  /** Prompts the classifier put in the top two tiers, as a share; null below MIN_TEAM_PEOPLE. */
  deepShare: number | null;
  priorDeepShare: number | null;
  /** People who have hardly used it in the window, and that as a share. */
  hardlyUsed: number;
  hardlyUsedShare: number | null;
  /** Kinds of work, the mechanism labels left out, commonest first. */
  work: KindShare[];
  champions: Array<{ userId: string; name: string; prompts: number; deepShare: number }>;
  /** People using it steadily who still get single answers nearly every time. */
  stuck: Array<{ userId: string; name: string; prompts: number; deepShare: number }>;
  /** What the by-hand estimate says the team's sessions would have taken, against measured time. */
  freed: { sessions: number; byHandHours: number; aiHours: number } | null;
  /** Sessions that ended with nothing saved, sent or published. */
  producedNothing: { sessions: number; measured: number; share: number } | null;
  /** The sessions that produced something, newest first: who, when, where, the kind of work, and the
   *  names of what came out where the platform gave them. Admin and manager only, as the page is. */
  produced: ProducedSession[];
  /** Work several people repeat with no skill behind it: worth codifying once. */
  repeated: Array<{ taskType: string; label: string; prompts: number; people: number }>;
  /** People whose first prompt was recent, with how far they have got so far. */
  newStarters: Array<{ name: string; firstAt: number; prompts: number; deepShare: number }>;
  /** Kinds of work only one person in the team does at all. */
  soloWork: Array<{ taskType: string; label: string; name: string; prompts: number }>;
  /** New ways of working the classifier flagged in the window. */
  capabilities: number;
}

export interface ProducedSession {
  at: number | null;
  name: string;
  platform: WorkPlatform;
  /** The Claude in Office or Google app, where it was one. */
  product: string | null;
  /** The session's main kind of work, as the classifier judged its prompts. Null when none were judged. */
  kind: string | null;
  /** The names of what came out, comma-separated. Null where the platform gave none. */
  outputs: string | null;
}

export interface CoworkCoachingFigures {
  tierNames: TierNames;
  /** The organisation, as the line a team is read against. */
  org: { people: number; prompts: number; deepShare: number | null; priorDeepShare: number | null; hardlyUsedShare: number | null; work: KindShare[] };
  teams: CoworkTeamFigures[];
  /** The share of work an admin expects to reach the top two tiers, as a percentage. */
  depthFloor: number;
}

interface Row {
  user_id: string;
  name: string | null;
  department: string | null;
  tier: number | string;
  task_type: string;
  capability: number | string;
  occurred_at: number | string;
  session_id: string | null;
}

interface SessionRow {
  session_id: string;
  user_id: string;
  department: string | null;
  active_secs: number | string | null;
  produced_output: number | string | null;
  human_minutes: number | string | null;
  platform: WorkPlatform;
  last_at: number | null;
  outputs: string | null;
  product: string | null;
}

const NO_DEPARTMENT = 'No department';
const n = (v: unknown) => Number(v ?? 0);

/** A person's department: the login account's first, then the monitored record's. */
function departmentSql(): SQL {
  return sql`COALESCE(NULLIF(au.department, ''), NULLIF(u.department, ''))`;
}

/** The depth floor an admin set on Admin → System, as a percentage. Zero means no floor. */
export function parseDepthFloor(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || String(raw).trim() === '') return DEFAULT_DEPTH_FLOOR;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0 || v > 100) return DEFAULT_DEPTH_FLOOR;
  return Math.round(v);
}

/** Kinds of work by share of prompts. Mechanism labels describe how a session ran, not the work. */
function kinds(rows: Row[]): KindShare[] {
  const work = rows.filter(r => !MECHANISM_TASK_TYPES.has(r.task_type));
  const by = new Map<string, number>();
  for (const r of work) by.set(r.task_type, (by.get(r.task_type) ?? 0) + 1);
  const total = work.length;
  return [...by.entries()]
    .map(([taskType, prompts]) => ({ taskType, label: kindLabel(taskType), prompts, share: total > 0 ? prompts / total : 0 }))
    .sort((a, b) => b.prompts - a.prompts);
}

function peopleFigures(rows: Row[], sessionsByUser: Map<string, number>): {
  people: number; hardlyUsed: number;
  champions: CoworkTeamFigures['champions'];
  stuck: CoworkTeamFigures['stuck'];
} {
  const by = new Map<string, { name: string; prompts: number; deep: number }>();
  for (const r of rows) {
    const e = by.get(r.user_id) ?? { name: r.name ?? r.user_id, prompts: 0, deep: 0 };
    e.prompts++;
    if (n(r.tier) >= 2) e.deep++;
    by.set(r.user_id, e);
  }
  const champions = [...by.entries()]
    .filter(([, v]) => v.prompts >= CHAMPION_MIN_PROMPTS && v.deep / v.prompts > CHAMPION_SHARE)
    .sort((a, b) => b[1].deep / b[1].prompts - a[1].deep / a[1].prompts || b[1].prompts - a[1].prompts)
    .slice(0, CHAMPIONS_PER_TEAM)
    .map(([userId, v]) => ({ userId, name: v.name, prompts: v.prompts, deepShare: v.deep / v.prompts }));
  const stuck = [...by.entries()]
    .filter(([, v]) => v.prompts >= STUCK_MIN_PROMPTS && v.deep / v.prompts < STUCK_SHARE)
    .sort((a, b) => b[1].prompts - a[1].prompts)
    .slice(0, CHAMPIONS_PER_TEAM)
    .map(([userId, v]) => ({ userId, name: v.name, prompts: v.prompts, deepShare: v.deep / v.prompts }));
  return {
    people: by.size,
    // Hardly used is about sessions, not prompts: one long conversation is still one sitting.
    hardlyUsed: [...by.keys()].filter(id => (sessionsByUser.get(id) ?? 0) < HARDLY_USED_SESSIONS).length,
    champions,
    stuck,
  };
}

/** What the by-hand estimates say a set of sessions would have taken, against measured time. */
function freedFrom(sessions: SessionRow[]): CoworkTeamFigures['freed'] {
  const withEstimate = sessions.filter(s => s.human_minutes !== null && n(s.active_secs) > 0);
  if (withEstimate.length === 0) return null;
  let byHand = 0, ai = 0;
  for (const s of withEstimate) {
    byHand += n(s.human_minutes);
    ai += n(s.active_secs) / 60;
  }
  return { sessions: withEstimate.length, byHandHours: byHand / 60, aiHours: ai / 60 };
}

/** Sessions that ended with nothing saved, sent or published. Unmeasured sessions are left out. */
function producedNothing(sessions: SessionRow[]): CoworkTeamFigures['producedNothing'] {
  const measured = sessions.filter(s => s.produced_output !== null);
  if (measured.length < OUTPUT_MIN_SESSIONS) return null;
  const nothing = measured.filter(s => n(s.produced_output) === 0).length;
  return { sessions: nothing, measured: measured.length, share: nothing / measured.length };
}

/** The sessions that produced something, newest first, with who and the session's main kind of work. */
function producedSessions(sessions: SessionRow[], rows: Row[]): ProducedSession[] {
  const names = new Map<string, string>();
  const kinds = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (r.name) names.set(r.user_id, r.name);
    if (!r.session_id || MECHANISM_TASK_TYPES.has(r.task_type)) continue;
    const k = kinds.get(r.session_id) ?? new Map<string, number>();
    k.set(r.task_type, (k.get(r.task_type) ?? 0) + 1);
    kinds.set(r.session_id, k);
  }
  return sessions
    .filter(s => n(s.produced_output) === 1)
    .map(s => {
      const top = [...(kinds.get(s.session_id)?.entries() ?? [])].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
      return {
        at: s.last_at,
        name: names.get(s.user_id) ?? 'Someone in the team',
        platform: s.platform,
        product: s.product,
        kind: top ? kindLabel(top[0]) : null,
        outputs: s.outputs,
      };
    })
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
    .slice(0, PRODUCED_LIST_MAX);
}

/** Kinds of work several people repeat with no skill used in any of those sessions. */
function repeatedWithoutSkill(rows: Row[], sessionsWithSkill: Set<string>): CoworkTeamFigures['repeated'] {
  const by = new Map<string, { prompts: number; people: Set<string>; withSkill: number }>();
  for (const r of rows) {
    if (MECHANISM_TASK_TYPES.has(r.task_type)) continue;
    const e = by.get(r.task_type) ?? { prompts: 0, people: new Set<string>(), withSkill: 0 };
    e.prompts++;
    e.people.add(r.user_id);
    if (r.session_id && sessionsWithSkill.has(r.session_id)) e.withSkill++;
    by.set(r.task_type, e);
  }
  return [...by.entries()]
    .filter(([, v]) => v.prompts >= REPEAT_MIN_PROMPTS && v.people.size >= REPEAT_MIN_PEOPLE && v.withSkill === 0)
    .sort((a, b) => b[1].prompts - a[1].prompts)
    .slice(0, 3)
    .map(([taskType, v]) => ({ taskType, label: kindLabel(taskType), prompts: v.prompts, people: v.people.size }));
}

/** People whose very first prompt was inside NEW_STARTER_DAYS, and how far they have got. */
function newStarters(rows: Row[], firstEver: Map<string, number>, nowS: number): CoworkTeamFigures['newStarters'] {
  const by = new Map<string, { name: string; prompts: number; deep: number }>();
  for (const r of rows) {
    const first = firstEver.get(r.user_id);
    if (first === undefined || first < nowS - NEW_STARTER_DAYS * DAY) continue;
    const e = by.get(r.user_id) ?? { name: r.name ?? r.user_id, prompts: 0, deep: 0 };
    e.prompts++;
    if (n(r.tier) >= 2) e.deep++;
    by.set(r.user_id, e);
  }
  return [...by.entries()]
    .map(([userId, v]) => ({ name: v.name, firstAt: firstEver.get(userId)!, prompts: v.prompts, deepShare: v.prompts > 0 ? v.deep / v.prompts : 0 }))
    .sort((a, b) => b.firstAt - a.firstAt)
    .slice(0, 5);
}

/** Kinds of work only one person in the team does at all: the team loses it if they go. */
function soloWork(rows: Row[]): CoworkTeamFigures['soloWork'] {
  const by = new Map<string, { people: Map<string, { name: string; prompts: number }> }>();
  for (const r of rows) {
    if (MECHANISM_TASK_TYPES.has(r.task_type)) continue;
    const e = by.get(r.task_type) ?? { people: new Map() };
    const p = e.people.get(r.user_id) ?? { name: r.name ?? r.user_id, prompts: 0 };
    p.prompts++;
    e.people.set(r.user_id, p);
    by.set(r.task_type, e);
  }
  return [...by.entries()]
    .filter(([, v]) => v.people.size === 1)
    .map(([taskType, v]) => {
      const only = [...v.people.values()][0];
      return { taskType, label: kindLabel(taskType), name: only.name, prompts: only.prompts };
    })
    .filter(x => x.prompts >= REPEAT_MIN_PROMPTS)
    .sort((a, b) => b.prompts - a.prompts)
    .slice(0, 3);
}

/**
 * The figures for every team and the organisation. `vendor` is the switch's view; a route passes
 * the visible one, so ChatGPT is left out whenever an admin has hidden it.
 */
export async function getCoworkCoachingFigures(vendor: Vendor = 'all', nowS = Math.floor(Date.now() / 1000)): Promise<CoworkCoachingFigures> {
  const since = nowS - 30 * DAY;
  const priorSince = nowS - 60 * DAY;
  const client = await getTypedClient();
  const run = async (q: SQL) =>
    (await (client as unknown as { execute: (query: SQL) => Promise<{ rows: unknown[] }> }).execute(q)).rows;
  // The prompts Work Pulse judges, on every platform it covers, narrowed by the switch.
  const onWorkPulse = sql`${isWorkPulseSurface(sql`cm.surface`, true)} AND ${sql.raw(vendorClause(vendor, 'cm.'))}`;

  const rows = (await run(sql`
    SELECT pc.user_id,
           COALESCE(NULLIF(au.display_name, ''), u.display_name, u.email) AS name,
           ${departmentSql()} AS department,
           pc.tier, pc.task_type,
           pc.capability_creation_candidate AS capability,
           cm.occurred_at, cm.session_id
    FROM pulse_classifications pc
    JOIN cowork_messages cm ON cm.id = pc.cowork_message_id
    LEFT JOIN users u ON u.id = pc.user_id
    LEFT JOIN admin_users au ON au.linked_cowork_user_id = pc.user_id
    WHERE pc.classifier_status = 'classified'
      AND ${onWorkPulse}
      AND cm.occurred_at >= ${priorSince}
  `)) as Row[];

  // Sessions are read on their own, so a long session counts once rather than once per prompt.
  const sessionRows: SessionRow[] = (await readWorkSessions({ since, vendor })).map(s => ({
    session_id: s.sessionId,
    user_id: s.userId,
    department: s.department,
    active_secs: s.activeSecs,
    produced_output: s.produced === null ? null : s.produced ? 1 : 0,
    human_minutes: s.humanMinutes,
    platform: s.platform,
    last_at: s.lastAt,
    outputs: s.outputs,
    product: s.product,
  }));
  // How many conversations each person had, on every platform: hardly used is about sittings.
  const sessionsByUser = await readSessionsPerPerson({ since, vendor });

  // When each person's very first judged prompt was, so the plan can spot new starters.
  const firstRows = (await run(sql`
    SELECT pc.user_id, MIN(cm.occurred_at) AS first_at
    FROM pulse_classifications pc
    JOIN cowork_messages cm ON cm.id = pc.cowork_message_id
    WHERE pc.classifier_status = 'classified' AND ${onWorkPulse}
    GROUP BY pc.user_id
  `)) as Array<{ user_id: string; first_at: number | string }>;
  const firstEver = new Map(firstRows.map(r => [r.user_id, n(r.first_at)]));

  // Which sessions used a skill at all, for the work worth codifying.
  const skillRows = (await run(sql`
    SELECT DISTINCT session_id FROM cowork_skill_invocations WHERE occurred_at >= ${since} AND ${skillVendor(vendor)}
  `)) as Array<{ session_id: string }>;
  const sessionsWithSkill = new Set(skillRows.map(r => r.session_id));

  const tierNames = await getTierNames();
  const depthFloor = parseDepthFloor(await getConfigValue('targetDeptRealWorkPct'));

  const inWindow = rows.filter(r => n(r.occurred_at) >= since);
  const before = rows.filter(r => n(r.occurred_at) < since);

  const deepShare = (rs: Row[], people: number) =>
    rs.length === 0 || people < MIN_TEAM_PEOPLE ? null : rs.filter(r => n(r.tier) >= 2).length / rs.length;

  const group = <T extends { department: string | null }>(xs: T[]) => {
    const by = new Map<string, T[]>();
    for (const x of xs) {
      const d = x.department || NO_DEPARTMENT;
      const list = by.get(d);
      if (list) list.push(x); else by.set(d, [x]);
    }
    return by;
  };
  const byTeam = group(inWindow);
  const byTeamBefore = group(before);
  const sessionsByTeam = group(sessionRows);

  const teams: CoworkTeamFigures[] = [...byTeam.entries()].map(([department, rs]) => {
    const teamSessions = sessionsByTeam.get(department) ?? [];
    const p = peopleFigures(rs, sessionsByUser);
    const priorRows = byTeamBefore.get(department) ?? [];
    const priorPeople = new Set(priorRows.map(r => r.user_id)).size;
    return {
      department,
      people: p.people,
      prompts: rs.length,
      sessions: new Set(rs.map(r => r.session_id).filter(Boolean)).size,
      deepShare: deepShare(rs, p.people),
      priorDeepShare: deepShare(priorRows, priorPeople),
      hardlyUsed: p.hardlyUsed,
      hardlyUsedShare: p.people >= MIN_TEAM_PEOPLE ? p.hardlyUsed / p.people : null,
      work: kinds(rs),
      champions: p.champions,
      stuck: p.stuck,
      freed: freedFrom(teamSessions),
      producedNothing: producedNothing(teamSessions),
      produced: producedSessions(teamSessions, rows.filter(r => (r.department || NO_DEPARTMENT) === department)),
      repeated: repeatedWithoutSkill(rs, sessionsWithSkill),
      newStarters: newStarters(rs, firstEver, nowS),
      soloWork: soloWork(rs),
      capabilities: rs.filter(r => n(r.capability) === 1).length,
    };
  }).sort((a, b) => b.prompts - a.prompts);

  const orgPeople = peopleFigures(inWindow, sessionsByUser);
  const orgBeforePeople = new Set(before.map(r => r.user_id)).size;
  return {
    tierNames,
    org: {
      people: orgPeople.people,
      prompts: inWindow.length,
      deepShare: deepShare(inWindow, orgPeople.people),
      priorDeepShare: deepShare(before, orgBeforePeople),
      hardlyUsedShare: orgPeople.people > 0 ? orgPeople.hardlyUsed / orgPeople.people : null,
      work: kinds(inWindow),
    },
    teams,
    depthFloor,
  };
}
