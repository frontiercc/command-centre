// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * The comparison Work Pulse So What prices its team cards from: inside a team, the people who do
 * mostly meaningful work against the people who do not, and how often each group's sessions
 * produced something.
 *
 * Who is in which group follows Team coaching's rule for someone to learn from
 * (CHAMPION_MIN_PROMPTS prompts in the window, more than CHAMPION_SHARE of them in the top two
 * tiers), without its cap of three names, so the two pages never disagree. Fewer than
 * HARDLY_USED_SESSIONS sessions and a person has hardly used it; fewer than CHAMPION_MIN_PROMPTS
 * prompts and they used it too little to judge. Neither is in either group.
 *
 * Output is measured: whether a session produced something (lib/pulse/cowork/work-sessions.ts), on
 * every platform Work Pulse covers. It is a floor: a file was made, not that anyone used it.
 * Sessions where it was not measured are left out, never counted as producing nothing. Work Pulse
 * holds no count of how much each person produced, so no card can say how many people a gap is
 * worth, and the cards say so.
 *
 * The card refuses rather than guesses: a group under MIN_GROUP people is too few to tell (which
 * also stops a chart pointing at anyone), and a group with under MIN_MEASURED measured sessions
 * cannot be compared.
 */
import { sql, type SQL } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { vendorClause } from '@/lib/dashboard/product-sql';
import { isWorkPulseSurface } from '@/lib/pulse/work-surfaces';
import { readSessionsPerPerson, readWorkSessions, type WorkSession } from '@/lib/pulse/cowork/work-sessions';
import {
  CHAMPION_MIN_PROMPTS, CHAMPION_SHARE, HARDLY_USED_SESSIONS, OUTPUT_MIN_SESSIONS,
} from '@/lib/pulse/cowork/coaching-figures';
import type { Vendor } from '@/lib/dashboard/vendor';

const DAY = 86400;
export const WINDOW_DAYS = 30;
/** Under this many people in a group, the gap is too small a sample to read. */
export const MIN_GROUP = 3;
/** Under this many measured sessions in a group, its share is not worth reading. */
export const MIN_MEASURED = OUTPUT_MIN_SESSIONS;
/** A difference in produced share smaller than this is no gap. */
export const GAP_MIN = 0.1;
export const NO_DEPARTMENT = 'No department';

export type GroupName = 'deep' | 'shallow' | 'light' | 'hardly';

export interface GroupFigures {
  people: number;
  /** The group's sessions where output was measured, and how many produced something. */
  measured: number;
  produced: number;
  /** produced / measured. Null when the group is too small or too little was measured. */
  share: number | null;
}

export type GroupsVerdict = 'ok' | 'too_few' | 'not_measured';

export interface WorkGroups {
  department: string;
  /** Everyone in the team with a judged prompt in the window. */
  people: number;
  deep: GroupFigures;
  shallow: GroupFigures;
  /** People who used it too little to judge, and people who hardly used it: in neither group. */
  light: number;
  hardly: number;
  /** How much more often the first group's sessions produced something. Null unless both read. */
  gap: number | null;
  verdict: GroupsVerdict;
}

export interface Person {
  userId: string;
  department: string;
  prompts: number;
  deepPrompts: number;
  sessions: number;
  measured: number;
  produced: number;
}

/** One judged prompt, as So What reads it. */
export interface PromptRow {
  user_id: string;
  department: string | null;
  tier: number | string;
  task_type: string;
  session_id: string | null;
  occurred_at: number | string;
}

export interface WorkData {
  rows: PromptRow[];
  sessions: WorkSession[];
  sessionsByUser: Map<string, number>;
}

const n = (v: unknown) => Number(v ?? 0);

/** A person's department: the login account's first, then the monitored record's. */
export function departmentSql(): SQL {
  return sql`COALESCE(NULLIF(au.department, ''), NULLIF(u.department, ''))`;
}

/** Which group a person belongs in, from their prompts and sessions in the window. */
export function groupFor(prompts: number, deepPrompts: number, sessions: number): GroupName {
  if (sessions < HARDLY_USED_SESSIONS) return 'hardly';
  if (prompts < CHAMPION_MIN_PROMPTS) return 'light';
  return deepPrompts / prompts > CHAMPION_SHARE ? 'deep' : 'shallow';
}

/** The figures for one team, from its people. */
export function groupsFrom(department: string, people: Person[]): WorkGroups {
  const named = people.map(p => ({ ...p, group: groupFor(p.prompts, p.deepPrompts, p.sessions) }));
  const figures = (group: GroupName): GroupFigures => {
    const ps = named.filter(p => p.group === group);
    const measured = ps.reduce((a, p) => a + p.measured, 0);
    const produced = ps.reduce((a, p) => a + p.produced, 0);
    return {
      people: ps.length,
      measured,
      produced,
      share: ps.length >= MIN_GROUP && measured >= MIN_MEASURED ? produced / measured : null,
    };
  };
  const deep = figures('deep');
  const shallow = figures('shallow');
  const verdict: GroupsVerdict =
    deep.people < MIN_GROUP || shallow.people < MIN_GROUP ? 'too_few'
      : deep.share === null || shallow.share === null ? 'not_measured'
        : 'ok';
  return {
    department,
    people: people.length,
    deep,
    shallow,
    light: named.filter(p => p.group === 'light').length,
    hardly: named.filter(p => p.group === 'hardly').length,
    gap: verdict === 'ok' ? deep.share! - shallow.share! : null,
    verdict,
  };
}

/** The judged prompts in [since, until), on every platform the vendor covers. */
export async function readPromptRows(vendor: Vendor, since: number, until = Number.MAX_SAFE_INTEGER): Promise<PromptRow[]> {
  const client = await getTypedClient();
  return (await (client as unknown as { execute: (query: SQL) => Promise<{ rows: unknown[] }> }).execute(sql`
    SELECT pc.user_id, ${departmentSql()} AS department, pc.tier, pc.task_type, cm.session_id, cm.occurred_at
    FROM pulse_classifications pc
    JOIN cowork_messages cm ON cm.id = pc.cowork_message_id
    LEFT JOIN users u ON u.id = pc.user_id
    LEFT JOIN admin_users au ON au.linked_cowork_user_id = pc.user_id
    WHERE pc.classifier_status = 'classified'
      AND ${isWorkPulseSurface(sql`cm.surface`, true)} AND ${sql.raw(vendorClause(vendor, 'cm.'))}
      AND cm.occurred_at >= ${since} AND cm.occurred_at < ${until}
  `)).rows as PromptRow[];
}

/** Everything So What reads for the window, on every platform the vendor covers. */
export async function loadWorkData(vendor: Vendor, nowS = Math.floor(Date.now() / 1000)): Promise<WorkData> {
  const since = nowS - WINDOW_DAYS * DAY;
  return {
    rows: await readPromptRows(vendor, since),
    sessions: await readWorkSessions({ since, vendor }),
    sessionsByUser: await readSessionsPerPerson({ since, vendor }),
  };
}

/** Each person in the window, with their prompts, sessions and what their sessions produced. */
export function peopleFrom(data: WorkData): Person[] {
  const by = new Map<string, Person>();
  for (const r of data.rows) {
    const p = by.get(r.user_id) ?? {
      userId: r.user_id, department: r.department || NO_DEPARTMENT, prompts: 0, deepPrompts: 0,
      sessions: data.sessionsByUser.get(r.user_id) ?? 0, measured: 0, produced: 0,
    };
    p.prompts++;
    if (n(r.tier) >= 2) p.deepPrompts++;
    by.set(r.user_id, p);
  }
  for (const s of data.sessions) {
    const p = by.get(s.userId);
    if (!p || s.produced === null) continue;
    p.measured++;
    if (s.produced) p.produced++;
  }
  return [...by.values()];
}

/** Every team's two groups, biggest team first. */
export function groupsByTeam(people: Person[]): WorkGroups[] {
  const byTeam = new Map<string, Person[]>();
  for (const p of people) {
    const list = byTeam.get(p.department);
    if (list) list.push(p); else byTeam.set(p.department, [p]);
  }
  return [...byTeam.entries()]
    .map(([department, ps]) => groupsFrom(department, ps))
    .sort((a, b) => b.people - a.people || a.department.localeCompare(b.department));
}
