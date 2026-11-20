// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * The one comparison every So what card is priced from: inside a team, the people who hand whole
 * pieces of work over against the people who do not, and what each group produces.
 *
 * Both groups are measured. Output is three counts per person over the window:
 *  - commits: from GitHub where the person's account is linked, which counts commits made with any
 *    tool or none; from their own Claude Code and Codex sessions otherwise;
 *  - pull requests and accepted edits: from Claude Code's telemetry.
 * No AI estimate goes anywhere near this.
 *
 * Who is in which group follows Team coaching's rule, so the two pages never disagree: fewer than
 * HARDLY_USED sessions in the window and a person is in neither group, otherwise more than half
 * their sessions in the top two tiers puts them in the first group. Automated runs are not a
 * person's own sessions and count in neither the grouping nor the output.
 *
 * The card refuses rather than guesses. A team with no output on any of the three counts cannot be
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

/** The three things a person's output is counted in. */
export type OutputMeasure = 'commits' | 'prs' | 'edits';
export const OUTPUT_MEASURES: OutputMeasure[] = ['commits', 'prs', 'edits'];

export interface GroupFigures {
  people: number;
  commits: number;
  prs: number;
  edits: number;
  /** Commits per person over the window. Null when the group is too small to read. */
  perPerson: number | null;
  /** Pull requests and accepted edits per person. Null when the group is too small to read. */
  prsPerPerson: number | null;
  editsPerPerson: number | null;
}

export type GroupsVerdict = 'ok' | 'no_output' | 'too_few';

export interface OutputGroups {
  department: string;
  /** Everyone in the team with a classified session of their own in the window. */
  people: number;
  deep: GroupFigures;
  shallow: GroupFigures;
  /** People using it too little to belong in either group. */
  hardly: number;
  /** People in either group whose commits come from GitHub. */
  fromGithub: number;
  /** A dot per person for the chart, in group order. No names: the chart is a count. */
  dots: GroupName[];
  /** Commits per person the second group would add if it worked like the first. */
  gapPerPerson: number | null;
  /**
   * The gap as whole people working the first group's way: worked out for each count that has any
   * output, and the smallest of them taken, so no single count can overstate it.
   */
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

/** The day a window starts, as the text date GitHub rows are keyed by. */
export function dayString(epochS: number): string {
  return new Date(epochS * 1000).toISOString().slice(0, 10);
}

interface Person {
  userId: string;
  department: string;
  group: GroupName;
  commits: number;
  prs?: number;
  edits?: number;
  /** Their commits come from GitHub rather than their sessions. */
  fromGithub?: boolean;
}

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
  const sum = (ps: Person[], f: (p: Person) => number) => ps.reduce((a, p) => a + f(p), 0);
  const figures = (ps: Person[]): GroupFigures => {
    const enough = ps.length >= MIN_GROUP;
    const commits = sum(ps, p => p.commits);
    const prs = sum(ps, p => p.prs ?? 0);
    const edits = sum(ps, p => p.edits ?? 0);
    return {
      people: ps.length, commits, prs, edits,
      perPerson: enough ? commits / ps.length : null,
      prsPerPerson: enough ? prs / ps.length : null,
      editsPerPerson: enough ? edits / ps.length : null,
    };
  };
  const deep = figures(deepPeople);
  const shallow = figures(shallowPeople);

  const total = (m: OutputMeasure) => deep[m] + shallow[m];
  const verdict: GroupsVerdict =
    deep.perPerson === null || shallow.perPerson === null ? 'too_few'
      : OUTPUT_MEASURES.every(m => total(m) === 0) ? 'no_output'
        : 'ok';

  const perPersonOf = (g: GroupFigures, m: OutputMeasure) =>
    m === 'commits' ? g.perPerson : m === 'prs' ? g.prsPerPerson : g.editsPerPerson;
  const gapPerPerson = verdict === 'ok' ? deep.perPerson! - shallow.perPerson! : null;
  // Priced as people working the first group's way, for each count with any output; the smallest
  // reading is the one used.
  let peopleWorth: number | null = null;
  if (verdict === 'ok') {
    const worths = OUTPUT_MEASURES.filter(m => total(m) > 0).map(m => {
      const d = perPersonOf(deep, m)!;
      const s = perPersonOf(shallow, m)!;
      return d > 0 && d > s ? ((d - s) * shallow.people) / d : 0;
    });
    const least = worths.length > 0 ? Math.min(...worths) : 0;
    peopleWorth = least > 0 ? least : null;
  }

  return {
    department,
    people: people.length,
    deep,
    shallow,
    hardly: people.filter(p => p.group === 'hardly').length,
    fromGithub: counted.filter(p => p.fromGithub).length,
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

  // Commits from GitHub, for people whose account is linked: every commit they made, with a tool
  // or without. The product view reads the matching column.
  const githubColumn = vendor === 'claude' ? sql`claude_commit_count` : vendor === 'openai' ? sql`codex_commit_count` : sql`commit_count`;
  const githubRows = (await run(sql`
    SELECT user_id, SUM(COALESCE(${githubColumn}, 0)) AS commits
    FROM github_user_repo_stats
    WHERE date >= ${dayString(since)}
    GROUP BY user_id
  `)) as Array<{ user_id: string; commits: number | string }>;
  const githubCommits = new Map(githubRows.map(r => [r.user_id, n(r.commits)]));

  // Pull requests and accepted edits, from Claude Code's telemetry. Codex sends neither.
  const otelRows = vendor === 'openai' ? [] : (await run(sql`
    SELECT m.user_id,
           SUM(CASE WHEN m.metric_name = 'claude_code.pull_request.count' THEN m.value ELSE 0 END) AS prs,
           SUM(CASE WHEN m.metric_name = 'claude_code.code_edit_tool.decision' AND m.type = 'accept' THEN m.value ELSE 0 END) AS edits
    FROM code_otel_metrics m
    LEFT JOIN code_session_classifications csc ON csc.session_id = m.session_id
    WHERE m.occurred_at >= ${since}
      AND m.metric_name IN ('claude_code.pull_request.count', 'claude_code.code_edit_tool.decision')
      AND (csc.work_type IS NULL OR csc.work_type <> ${AUTOMATED_WORK_TYPE})
    GROUP BY m.user_id
  `)) as Array<{ user_id: string; prs: number | string; edits: number | string }>;
  const otel = new Map(otelRows.map(r => [r.user_id, { prs: Math.round(n(r.prs)), edits: Math.round(n(r.edits)) }]));

  const byTeam = new Map<string, Person[]>();
  for (const r of personRows) {
    const department = r.department || NO_DEPARTMENT;
    const fromGithub = githubCommits.has(r.user_id);
    const person: Person = {
      userId: r.user_id,
      department,
      group: groupFor(n(r.sessions), n(r.deep_sessions)),
      commits: fromGithub ? githubCommits.get(r.user_id)! : n(r.commits) + (codexCommits.get(r.user_id) ?? 0),
      prs: otel.get(r.user_id)?.prs ?? 0,
      edits: otel.get(r.user_id)?.edits ?? 0,
      fromGithub,
    };
    const list = byTeam.get(department);
    if (list) list.push(person); else byTeam.set(department, [person]);
  }

  // "No department" is everyone without one yet, not a team, so it gets no card, as on Departments.
  return [...byTeam.entries()]
    .filter(([department]) => department !== NO_DEPARTMENT)
    .map(([department, ps]) => groupsFrom(department, ps))
    .sort((a, b) => b.people - a.people);
}
