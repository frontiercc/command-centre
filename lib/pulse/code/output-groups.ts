// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * The one comparison every So what card is priced from: inside a team, the people who hand whole
 * pieces of work over against the people who do not, and what each group ships.
 *
 * Both groups are measured. Output is the commits made in each person's own sessions, as Claude Code
 * and Codex record them, so everyone with sessions in the window is counted, with no account
 * matching needed. No AI estimate goes anywhere near this.
 *
 * Who is in which group follows Team coaching's rule, so the two pages never disagree: fewer than
 * HARDLY_USED sessions in the window and a person is in neither group, otherwise more than half
 * their sessions in the top two tiers puts them in the first group. Automated runs are not a
 * person's own sessions and count in neither the grouping nor the output.
 *
 * The card refuses rather than guesses. A team whose sessions made no commits at all cannot be
 * answered. A group under MIN_GROUP people is too few to tell, which also stops a chart identifying
 * anyone.
 */
import { sql, type SQL } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { codeSessionVendor } from '@/lib/pulse/code/vendor-view';
import { codexActionCounts } from '@/lib/pulse/code/aggregator';
import { AUTOMATED_WORK_TYPE } from '@/lib/pulse/code/automated-runs';
import type { Vendor } from '@/lib/dashboard/vendor';

const DAY = 86400;
export const WINDOW_DAYS = 30;
/** Fewer sessions than this in the window and a person is in neither group. */
export const HARDLY_USED_SESSIONS = 2;
/** More than this share of a person's sessions in the top two tiers and they hand whole work over. */
export const DEEP_PERSON_SHARE = 0.5;
/** Under this many people in either group, the gap is too small a sample to price. */
export const MIN_GROUP = 3;

export type GroupName = 'deep' | 'shallow' | 'hardly';

export interface GroupFigures {
  people: number;
  commits: number;
  /** Commits per person over the window. Null when the group is too small to read. */
  perPerson: number | null;
}

export type GroupsVerdict = 'ok' | 'no_commits' | 'too_few';

export interface OutputGroups {
  department: string;
  /** Everyone in the team with a classified session of their own in the window. */
  people: number;
  deep: GroupFigures;
  shallow: GroupFigures;
  /** People using it too little to belong in either group. */
  hardly: number;
  /** A dot per person for the chart, in group order. No names: the chart is a count. */
  dots: GroupName[];
  /** Commits per person the second group would add if it worked like the first. */
  gapPerPerson: number | null;
  /** Those extra commits as whole people working the first group's way. */
  peopleWorth: number | null;
  verdict: GroupsVerdict;
}

interface PersonRow {
  user_id: string;
  department: string | null;
  sessions: number | string;
  deep_sessions: number | string;
  commits: number | string | null;
}

const n = (v: unknown) => Number(v ?? 0);

/** A person's department: the login account's first, then the monitored record's. */
function departmentSql(): SQL {
  return sql`COALESCE(NULLIF(au.department, ''), NULLIF(u.department, ''))`;
}

const NO_DEPARTMENT = 'No department';

interface Person { userId: string; department: string; group: GroupName; commits: number }

/** Which group a person belongs in, from their sessions in the window. */
export function groupFor(sessions: number, deepSessions: number): GroupName {
  if (sessions < HARDLY_USED_SESSIONS) return 'hardly';
  return deepSessions / sessions > DEEP_PERSON_SHARE ? 'deep' : 'shallow';
}

/** The figures for one team, from people already grouped. */
export function groupsFrom(department: string, people: Person[]): OutputGroups {
  const counted = people.filter(p => p.group !== 'hardly');
  const deepPeople = counted.filter(p => p.group === 'deep');
  const shallowPeople = counted.filter(p => p.group === 'shallow');
  const figures = (ps: Person[]): GroupFigures => {
    const commits = ps.reduce((a, p) => a + p.commits, 0);
    return { people: ps.length, commits, perPerson: ps.length >= MIN_GROUP ? commits / ps.length : null };
  };
  const deep = figures(deepPeople);
  const shallow = figures(shallowPeople);

  const verdict: GroupsVerdict =
    deep.perPerson === null || shallow.perPerson === null ? 'too_few'
      : deep.commits + shallow.commits === 0 ? 'no_commits'
        : 'ok';

  const gapPerPerson = verdict === 'ok' ? deep.perPerson! - shallow.perPerson! : null;
  // Priced as people working the first group's way, which is the smaller of the two readings.
  const peopleWorth = gapPerPerson !== null && gapPerPerson > 0 && deep.perPerson! > 0
    ? (gapPerPerson * shallow.people) / deep.perPerson!
    : null;

  return {
    department,
    people: people.length,
    deep,
    shallow,
    hardly: people.filter(p => p.group === 'hardly').length,
    dots: [...deepPeople.map(() => 'deep' as const), ...shallowPeople.map(() => 'shallow' as const)],
    gapPerPerson,
    peopleWorth,
    verdict,
  };
}

/** Every team's two groups, over the last WINDOW_DAYS. */
export async function getOutputGroups(vendor: Vendor, nowS = Math.floor(Date.now() / 1000)): Promise<OutputGroups[]> {
  const since = nowS - WINDOW_DAYS * DAY;
  const client = await getTypedClient();
  const run = async (q: SQL) =>
    (await (client as unknown as { execute: (query: SQL) => Promise<{ rows: unknown[] }> }).execute(q)).rows;

  // Each person's own sessions in the window, how many went deep, and the commits Claude Code
  // recorded in them. Automated runs are left out of all three.
  const personRows = (await run(sql`
    SELECT csc.user_id,
           ${departmentSql()} AS department,
           COUNT(*) AS sessions,
           SUM(CASE WHEN csc.tier >= 2 THEN 1 ELSE 0 END) AS deep_sessions,
           SUM(CASE WHEN css.session_id LIKE 'codex:%' THEN 0 ELSE COALESCE(css.commit_count, 0) END) AS commits
    FROM code_session_classifications csc
    JOIN code_session_stats css ON css.session_id = csc.session_id
    LEFT JOIN users u ON u.id = csc.user_id
    LEFT JOIN admin_users au ON au.linked_cowork_user_id = csc.user_id
    WHERE csc.status = 'classified' AND css.last_at >= ${since}
      AND csc.work_type <> ${AUTOMATED_WORK_TYPE}
      AND ${codeSessionVendor(sql`css.session_id`, vendor)}
    GROUP BY csc.user_id, ${departmentSql()}
  `)) as PersonRow[];

  // A Codex session's commits are in its own actions, which Claude Code's telemetry never sees.
  const codexRows = (await run(sql`
    SELECT csc.user_id, css.session_id
    FROM code_session_classifications csc
    JOIN code_session_stats css ON css.session_id = csc.session_id
    WHERE csc.status = 'classified' AND css.last_at >= ${since}
      AND csc.work_type <> ${AUTOMATED_WORK_TYPE}
      AND css.session_id LIKE 'codex:%'
      AND ${codeSessionVendor(sql`css.session_id`, vendor)}
  `)) as Array<{ user_id: string; session_id: string }>;
  const codexCommits = new Map<string, number>();
  if (codexRows.length > 0) {
    const counts = await codexActionCounts(client, codexRows.map(r => r.session_id));
    for (const r of codexRows) {
      codexCommits.set(r.user_id, (codexCommits.get(r.user_id) ?? 0) + (counts.get(r.session_id)?.commits ?? 0));
    }
  }

  const byTeam = new Map<string, Person[]>();
  for (const r of personRows) {
    const department = r.department || NO_DEPARTMENT;
    const person: Person = {
      userId: r.user_id,
      department,
      group: groupFor(n(r.sessions), n(r.deep_sessions)),
      commits: n(r.commits) + (codexCommits.get(r.user_id) ?? 0),
    };
    const list = byTeam.get(department);
    if (list) list.push(person); else byTeam.set(department, [person]);
  }

  return [...byTeam.entries()]
    .map(([department, ps]) => groupsFrom(department, ps))
    .sort((a, b) => b.people - a.people);
}
