// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * The one comparison every So what card is priced from: inside a team, the people who hand whole
 * pieces of work over against the people who do not, and what each group ships.
 *
 * Both groups are measured. Output is commits per person from GitHub, which counts commits made
 * with Claude Code, with Codex and with no tool recorded, so a person who hardly uses Claude is
 * still counted fairly. No AI estimate goes anywhere near this.
 *
 * Who is in which group follows Team coaching's rule, so the two pages never disagree: fewer than
 * HARDLY_USED sessions in the window and a person is in neither group, otherwise more than half
 * their sessions in the top two tiers puts them in the first group.
 *
 * The card refuses rather than guesses. A team with no GitHub data at all cannot be answered. A
 * group under MIN_GROUP people is too few to tell, which also stops a chart identifying anyone.
 */
import { sql, type SQL } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { codeSessionVendor } from '@/lib/pulse/code/vendor-view';
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

export type GroupsVerdict = 'ok' | 'no_github' | 'too_few';

export interface OutputGroups {
  department: string;
  /** Everyone in the team with a classified session in the window. */
  people: number;
  deep: GroupFigures;
  shallow: GroupFigures;
  /** People using it too little to belong in either group. */
  hardly: number;
  /** People left out because no GitHub commits can be attributed to them. */
  unmatched: number;
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
}

interface CommitRow { user_id: string; commits: number | string }

const n = (v: unknown) => Number(v ?? 0);

/** A person's department: the login account's first, then the monitored record's. */
function departmentSql(): SQL {
  return sql`COALESCE(NULLIF(au.department, ''), NULLIF(u.department, ''))`;
}

const NO_DEPARTMENT = 'No department';

/** The day a window starts, as the text date GitHub rows are keyed by. */
export function dayString(epochS: number): string {
  return new Date(epochS * 1000).toISOString().slice(0, 10);
}

interface Person { userId: string; department: string; group: GroupName; commits: number; matched: boolean }

/** Which group a person belongs in, from their sessions in the window. */
export function groupFor(sessions: number, deepSessions: number): GroupName {
  if (sessions < HARDLY_USED_SESSIONS) return 'hardly';
  return deepSessions / sessions > DEEP_PERSON_SHARE ? 'deep' : 'shallow';
}

/** The figures for one team, from people already grouped and matched. */
export function groupsFrom(department: string, people: Person[]): OutputGroups {
  const counted = people.filter(p => p.group !== 'hardly' && p.matched);
  const deepPeople = counted.filter(p => p.group === 'deep');
  const shallowPeople = counted.filter(p => p.group === 'shallow');
  const figures = (ps: Person[]): GroupFigures => {
    const commits = ps.reduce((a, p) => a + p.commits, 0);
    return { people: ps.length, commits, perPerson: ps.length >= MIN_GROUP ? commits / ps.length : null };
  };
  const deep = figures(deepPeople);
  const shallow = figures(shallowPeople);

  const inTeam = people.filter(p => p.group !== 'hardly');
  const verdict: GroupsVerdict =
    inTeam.every(p => !p.matched) ? 'no_github'
      : deep.perPerson === null || shallow.perPerson === null ? 'too_few'
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
    unmatched: inTeam.filter(p => !p.matched).length,
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

  const personRows = (await run(sql`
    SELECT csc.user_id,
           ${departmentSql()} AS department,
           COUNT(*) AS sessions,
           SUM(CASE WHEN csc.tier >= 2 THEN 1 ELSE 0 END) AS deep_sessions
    FROM code_session_classifications csc
    JOIN code_session_stats css ON css.session_id = csc.session_id
    LEFT JOIN users u ON u.id = csc.user_id
    LEFT JOIN admin_users au ON au.linked_cowork_user_id = csc.user_id
    WHERE csc.status = 'classified' AND css.last_at >= ${since}
      AND ${codeSessionVendor(sql`css.session_id`, vendor)}
    GROUP BY csc.user_id, ${departmentSql()}
  `)) as PersonRow[];

  // Commits per person over the same window: made with Claude, with Codex and with no tool.
  const commitRows = (await run(sql`
    SELECT user_id, SUM(commit_count) AS commits
    FROM github_user_repo_stats
    WHERE date >= ${dayString(since)}
    GROUP BY user_id
  `)) as CommitRow[];
  const commits = new Map(commitRows.map(r => [r.user_id, n(r.commits)]));

  const byTeam = new Map<string, Person[]>();
  for (const r of personRows) {
    const department = r.department || NO_DEPARTMENT;
    const person: Person = {
      userId: r.user_id,
      department,
      group: groupFor(n(r.sessions), n(r.deep_sessions)),
      commits: commits.get(r.user_id) ?? 0,
      // Nothing tells matched-with-no-commits from unmatched, so having commits is the test.
      matched: commits.has(r.user_id),
    };
    const list = byTeam.get(department);
    if (list) list.push(person); else byTeam.set(department, [person]);
  }

  return [...byTeam.entries()]
    .map(([department, ps]) => groupsFrom(department, ps))
    .sort((a, b) => b.people - a.people);
}
