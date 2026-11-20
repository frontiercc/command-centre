// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * The figures Team coaching reads, for a department and for the organisation, from the signals
 * this product already has: the Code session classifier's tiers and kinds of work, and the
 * measured session stats behind them. No model call.
 *
 * A team is a person's department, resolved as everywhere else: the login account's first, then
 * the monitored record's. Windows are the last 30 whole days against the 30 before, which is what
 * the rest of Developer Pulse compares on.
 */
import { sql, type SQL } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { codeSessionVendor } from '@/lib/pulse/code/vendor-view';
import { codexActionCounts } from '@/lib/pulse/code/aggregator';
import { getCodeWorkTypeDefinitions } from '@/lib/pulse/code/tier-config';
import { codeWorkTypeLabel } from '@/lib/pulse/code/work-type-labels';
import { getCodeTierNames } from '@/lib/pulse/code/weekly-tiers';
import { AUTOMATED_WORK_TYPE } from '@/lib/pulse/code/automated-runs';
import { getConfigValue } from '@/lib/config';
import type { Vendor } from '@/lib/dashboard/vendor';
import type { TierNames } from '@/lib/pulse/tier-names';

const DAY = 86400;
/** Under this many people a team's shares are counted but never turned into a share. */
export const MIN_TEAM_PEOPLE = 3;
/** Someone with fewer sessions than this in the window has hardly used it. */
export const HARDLY_USED_SESSIONS = 2;
/** Someone whose multi-step share is above this is one to learn from. */
export const CHAMPION_SHARE = 0.5;
/** Someone with at least this many sessions is using it properly, whatever they get from it. */
export const STUCK_MIN_SESSIONS = 5;
/** ...and below this share of multi-step work, they are getting little back. */
export const STUCK_SHARE = 0.2;
/** A kind of work repeated at least this many times, by this many people, with no skill behind it. */
export const REPEAT_MIN_SESSIONS = 8;
export const REPEAT_MIN_PEOPLE = 3;
/** Someone whose first session was within this many days is still finding their feet. */
export const NEW_STARTER_DAYS = 42;
/** A session at least this long that committed nothing is worth a look. */
export const LONG_SESSION_SECS = 3600;
/** Below this share of the team's long sessions, there is nothing to say. */
export const LONG_NOTHING_SHARE = 0.25;
/** The team's accepted-edit share this far below the organisation's is worth coaching. */
export const ACCEPTANCE_GAP = 0.1;
/** At most this many people are named as ones to learn from, per team. */
export const CHAMPIONS_PER_TEAM = 3;
/** A kind of work this far from its target, in points, is worth acting on. */
export const TARGET_GAP_PP = 5;

export interface WorkShare { workType: string; label: string; sessions: number; share: number; target: number | null }

export interface TeamFigures {
  department: string;
  people: number;
  sessions: number;
  /** Sessions the classifier put in the top two tiers, as a share; null below MIN_TEAM_PEOPLE. */
  deepShare: number | null;
  priorDeepShare: number | null;
  /** People who have hardly used it in the window, and that as a share. */
  hardlyUsed: number;
  hardlyUsedShare: number | null;
  work: WorkShare[];
  champions: Array<{ userId: string; name: string; sessions: number; deepShare: number }>;
  /** People using it steadily who still get single-step answers nearly every time. */
  stuck: Array<{ userId: string; name: string; sessions: number; deepShare: number }>;
  /** What the by-hand estimate says the team's sessions would have taken, against measured time. */
  freed: { sessions: number; byHandHours: number; aiHours: number; topKind: string | null } | null;
  /** Work several people repeat with no skill behind it: worth codifying once. */
  repeated: Array<{ workType: string; label: string; sessions: number; people: number }>;
  /** People whose first session was recent, with how far they have got so far. */
  newStarters: Array<{ name: string; firstAt: number; sessions: number; deepShare: number }>;
  /** Long sessions that committed nothing: the shape of the task, or the context, is wrong. */
  longNothing: { sessions: number; long: number; share: number } | null;
  /** The team's accepted edits against the organisation's. */
  editAcceptance: { team: number; org: number | null } | null;
  /** The model most of the team's single-step sessions ran on. Spend Review owns what it costs. */
  costlyOnSimple: { model: string; sessions: number } | null;
}

export interface CoachingFigures {
  tierNames: TierNames;
  /** The organisation, as the line a team is read against. */
  org: { people: number; sessions: number; deepShare: number | null; priorDeepShare: number | null; hardlyUsedShare: number | null; work: WorkShare[] };
  teams: TeamFigures[];
  /** The share of sessions an admin intends each kind of work to take, by work type. */
  targets: Record<string, number>;
}

/** The share an admin intends each kind of work to take (config key codeEffortTargets). */
export function parseWorkTargets(raw: string | null | undefined): Record<string, number> {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(obj ?? {})) {
      if (v === null || v === undefined || v === '') continue;
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0 && n <= 100) out[k] = Math.round(n);
    }
    return out;
  } catch {
    return {};
  }
}

interface Row {
  user_id: string;
  name: string | null;
  department: string | null;
  work_type: string;
  tier: number | string;
  last_at: number | string;
  session_id: string;
  skills_json: string | null;
  /** Claude's estimate of how long this session's work would have taken by hand. */
  human_minutes: number | string | null;
  active_secs: number | string | null;
  commit_count: number | string | null;
  models_json: string | null;
  first_at: number | string | null;
}

const NO_DEPARTMENT = 'No department';
const n = (v: unknown) => Number(v ?? 0);

/** A person's department: the login account's first, then the monitored record's. */
function departmentSql(): SQL {
  return sql`COALESCE(NULLIF(au.department, ''), NULLIF(u.department, ''))`;
}

function shares(rows: Row[], targets: Record<string, number>, labels: Map<string, string | undefined>): WorkShare[] {
  const by = new Map<string, number>();
  for (const r of rows) by.set(r.work_type, (by.get(r.work_type) ?? 0) + 1);
  const total = rows.length;
  return [...by.entries()]
    .map(([workType, sessions]) => ({
      workType,
      label: codeWorkTypeLabel(workType, labels.get(workType)),
      sessions,
      share: total > 0 ? sessions / total : 0,
      target: targets[workType] ?? null,
    }))
    .sort((a, b) => b.sessions - a.sessions);
}

function peopleFigures(rows: Row[]): {
  people: number; hardlyUsed: number;
  champions: Array<{ userId: string; name: string; sessions: number; deepShare: number }>;
  stuck: Array<{ userId: string; name: string; sessions: number; deepShare: number }>;
} {
  const by = new Map<string, { name: string; sessions: number; deep: number }>();
  for (const r of rows) {
    const e = by.get(r.user_id) ?? { name: r.name ?? r.user_id, sessions: 0, deep: 0 };
    e.sessions++;
    if (n(r.tier) >= 2) e.deep++;
    by.set(r.user_id, e);
  }
  const champions = [...by.entries()]
    .filter(([, v]) => v.sessions >= HARDLY_USED_SESSIONS && v.deep / v.sessions > CHAMPION_SHARE)
    .sort((a, b) => b[1].deep / b[1].sessions - a[1].deep / a[1].sessions || b[1].sessions - a[1].sessions)
    .slice(0, CHAMPIONS_PER_TEAM)
    .map(([userId, v]) => ({ userId, name: v.name, sessions: v.sessions, deepShare: v.deep / v.sessions }));
  const stuck = [...by.entries()]
    .filter(([, v]) => v.sessions >= STUCK_MIN_SESSIONS && v.deep / v.sessions < STUCK_SHARE)
    .sort((a, b) => b[1].sessions - a[1].sessions)
    .slice(0, CHAMPIONS_PER_TEAM)
    .map(([userId, v]) => ({ userId, name: v.name, sessions: v.sessions, deepShare: v.deep / v.sessions }));
  return {
    people: by.size,
    hardlyUsed: [...by.values()].filter(v => v.sessions < HARDLY_USED_SESSIONS).length,
    champions,
    stuck,
  };
}

/** What the by-hand estimates say a set of sessions would have taken, against measured time. */
function freedFrom(rows: Row[], labels: Map<string, string | undefined>): TeamFigures['freed'] {
  const withEstimate = rows.filter(r => r.human_minutes !== null && n(r.active_secs) > 0);
  if (withEstimate.length === 0) return null;
  const byKind = new Map<string, number>();
  let byHand = 0, ai = 0;
  for (const r of withEstimate) {
    const m = n(r.human_minutes);
    byHand += m;
    ai += n(r.active_secs) / 60;
    byKind.set(r.work_type, (byKind.get(r.work_type) ?? 0) + m);
  }
  const top = [...byKind.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    sessions: withEstimate.length,
    byHandHours: byHand / 60,
    aiHours: ai / 60,
    topKind: top ? codeWorkTypeLabel(top[0], labels.get(top[0])) : null,
  };
}

/** Kinds of work several people repeat with no skill behind any of those sessions. */
function repeatedWithoutSkill(rows: Row[], labels: Map<string, string | undefined>): TeamFigures['repeated'] {
  const by = new Map<string, { sessions: number; people: Set<string>; withSkill: number }>();
  for (const r of rows) {
    const e = by.get(r.work_type) ?? { sessions: 0, people: new Set<string>(), withSkill: 0 };
    e.sessions++;
    e.people.add(r.user_id);
    const skills = r.skills_json?.trim();
    if (skills && skills !== '[]' && skills !== '{}') e.withSkill++;
    by.set(r.work_type, e);
  }
  return [...by.entries()]
    .filter(([, v]) => v.sessions >= REPEAT_MIN_SESSIONS && v.people.size >= REPEAT_MIN_PEOPLE && v.withSkill === 0)
    .sort((a, b) => b[1].sessions - a[1].sessions)
    .slice(0, 3)
    .map(([workType, v]) => ({ workType, label: codeWorkTypeLabel(workType, labels.get(workType)), sessions: v.sessions, people: v.people.size }));
}

/** People whose very first session was inside NEW_STARTER_DAYS, and how far they have got. */
function newStarters(rows: Row[], firstEver: Map<string, number>, nowS: number): TeamFigures['newStarters'] {
  const by = new Map<string, { name: string; sessions: number; deep: number }>();
  for (const r of rows) {
    const first = firstEver.get(r.user_id);
    if (first === undefined || first < nowS - NEW_STARTER_DAYS * DAY) continue;
    const e = by.get(r.user_id) ?? { name: r.name ?? r.user_id, sessions: 0, deep: 0 };
    e.sessions++;
    if (n(r.tier) >= 2) e.deep++;
    by.set(r.user_id, e);
  }
  return [...by.entries()]
    .map(([userId, v]) => ({ name: v.name, firstAt: firstEver.get(userId)!, sessions: v.sessions, deepShare: v.sessions > 0 ? v.deep / v.sessions : 0 }))
    .sort((a, b) => b.firstAt - a.firstAt)
    .slice(0, 5);
}

/** Long sessions that committed nothing. Null when the team has no long sessions at all. */
function longNothing(rows: Row[]): TeamFigures['longNothing'] {
  const long = rows.filter(r => n(r.active_secs) >= LONG_SESSION_SECS);
  if (long.length === 0) return null;
  const nothing = long.filter(r => n(r.commit_count) === 0).length;
  return { sessions: nothing, long: long.length, share: nothing / long.length };
}

/** The model most of the team's single-step sessions ran on, from the session's own model list. */
function costlyOnSimple(rows: Row[]): TeamFigures['costlyOnSimple'] {
  const simple = rows.filter(r => n(r.tier) === 1);
  if (simple.length === 0) return null;
  const by = new Map<string, number>();
  for (const r of simple) {
    let models: string[] = [];
    try {
      const parsed = JSON.parse(r.models_json ?? '[]');
      models = Array.isArray(parsed) ? parsed.map(String) : Object.keys(parsed ?? {});
    } catch { continue; }
    for (const m of models) by.set(m, (by.get(m) ?? 0) + 1);
  }
  const top = [...by.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!top || top[1] < 5) return null;
  return { model: top[0], sessions: top[1] };
}

export async function getCoachingFigures(vendor: Vendor, nowS = Math.floor(Date.now() / 1000)): Promise<CoachingFigures> {
  const since = nowS - 30 * DAY;
  const priorSince = nowS - 60 * DAY;
  const client = await getTypedClient();
  const rows = (await (client as unknown as { execute: (q: SQL) => Promise<{ rows: unknown[] }> }).execute(sql`
    SELECT csc.user_id,
           COALESCE(NULLIF(au.display_name, ''), u.display_name, u.email) AS name,
           ${departmentSql()} AS department,
           csc.work_type, csc.tier, css.last_at, css.session_id, css.skills_json,
           csc.human_minutes_likely AS human_minutes, css.active_secs,
           css.commit_count, css.models_json, css.first_at
    FROM code_session_classifications csc
    JOIN code_session_stats css ON css.session_id = csc.session_id
    LEFT JOIN users u ON u.id = csc.user_id
    LEFT JOIN admin_users au ON au.linked_cowork_user_id = csc.user_id
    WHERE csc.status = 'classified' AND css.last_at >= ${priorSince}
      AND ${codeSessionVendor(sql`css.session_id`, vendor)}
  `)).rows as Row[];

  // A Codex session's commits are in its own actions (codex_actions): Claude Code's telemetry, which
  // fills commit_count, never sees them. The same counts the per-product figures and the classifier use.
  const codexIds = [...new Set(rows.map(r => r.session_id).filter(id => id.startsWith('codex:')))];
  if (codexIds.length > 0) {
    const counts = await codexActionCounts(client, codexIds);
    for (const r of rows) {
      if (r.session_id.startsWith('codex:')) r.commit_count = counts.get(r.session_id)?.commits ?? 0;
    }
  }

  // When each person's very first session was, so the plan can spot new starters.
  const firstRows = (await (client as unknown as { execute: (q: SQL) => Promise<{ rows: unknown[] }> }).execute(sql`
    SELECT user_id, MIN(first_at) AS first_at FROM code_session_stats
    WHERE ${codeSessionVendor(sql`session_id`, vendor)}
    GROUP BY user_id
  `)).rows as Array<{ user_id: string; first_at: number | string }>;
  const firstEver = new Map(firstRows.map(r => [r.user_id, n(r.first_at)]));

  // Accepted and rejected edits, from the weekly rows the aggregator already writes.
  const editRows = (await (client as unknown as { execute: (q: SQL) => Promise<{ rows: unknown[] }> }).execute(sql`
    SELECT scope_id AS user_id, SUM(edit_accept_count) AS accepted, SUM(edit_reject_count) AS rejected
    FROM code_metrics
    WHERE granularity = 'week' AND scope_type = 'user' AND period_start >= ${since}
    GROUP BY scope_id
  `)).rows as Array<{ user_id: string; accepted: number | string | null; rejected: number | string | null }>;
  const edits = new Map(editRows.map(r => [r.user_id, { accepted: n(r.accepted), rejected: n(r.rejected) }]));
  const acceptanceOf = (ids: Set<string>): number | null => {
    let a = 0, rj = 0;
    for (const id of ids) { const e = edits.get(id); if (e) { a += e.accepted; rj += e.rejected; } }
    return a + rj > 0 ? a / (a + rj) : null;
  };

  // Every session counts in the kinds of work, automated runs included, so they show as their own
  // kind. The figures about people (who goes deep, who is stuck, the team's deep share) read only the
  // sessions people ran themselves.
  const inWindowAll = rows.filter(r => n(r.last_at) >= since);
  const inWindow = inWindowAll.filter(r => r.work_type !== AUTOMATED_WORK_TYPE);
  const before = rows.filter(r => n(r.last_at) < since && r.work_type !== AUTOMATED_WORK_TYPE);
  const labels = await getCodeWorkTypeDefinitions();
  const targets = parseWorkTargets(await getConfigValue('codeEffortTargets'));
  const tierNames = await getCodeTierNames();

  const deepShare = (rs: Row[], people: number) =>
    rs.length === 0 || people < MIN_TEAM_PEOPLE ? null : rs.filter(r => n(r.tier) >= 2).length / rs.length;

  const byTeam = new Map<string, Row[]>();
  const byTeamAll = new Map<string, Row[]>();
  const byTeamBefore = new Map<string, Row[]>();
  for (const r of inWindowAll) {
    const d = r.department || NO_DEPARTMENT;
    byTeamAll.set(d, [...(byTeamAll.get(d) ?? []), r]);
    if (r.work_type !== AUTOMATED_WORK_TYPE) byTeam.set(d, [...(byTeam.get(d) ?? []), r]);
    else if (!byTeam.has(d)) byTeam.set(d, []);
  }
  for (const r of before) {
    const d = r.department || NO_DEPARTMENT;
    byTeamBefore.set(d, [...(byTeamBefore.get(d) ?? []), r]);
  }

  const teams: TeamFigures[] = [...byTeam.entries()].map(([department, rs]) => {
    const p = peopleFigures(rs);
    const priorRows = byTeamBefore.get(department) ?? [];
    const priorPeople = new Set(priorRows.map(r => r.user_id)).size;
    return {
      department,
      people: p.people,
      sessions: rs.length,
      deepShare: deepShare(rs, p.people),
      priorDeepShare: deepShare(priorRows, priorPeople),
      hardlyUsed: p.hardlyUsed,
      hardlyUsedShare: p.people >= MIN_TEAM_PEOPLE ? p.hardlyUsed / p.people : null,
      work: shares(byTeamAll.get(department) ?? rs, targets, labels),
      champions: p.champions,
      stuck: p.stuck,
      freed: freedFrom(rs, labels),
      repeated: repeatedWithoutSkill(rs, labels),
      newStarters: newStarters(rs, firstEver, nowS),
      longNothing: longNothing(rs),
      editAcceptance: (() => {
        // Edit decisions come from Claude Code's telemetry alone; Codex sends none.
        if (vendor === 'openai') return null;
        const team = acceptanceOf(new Set(rs.map(r => r.user_id)));
        return team === null ? null : { team, org: acceptanceOf(new Set(inWindow.map(r => r.user_id))) };
      })(),
      costlyOnSimple: costlyOnSimple(rs),
    };
  }).sort((a, b) => b.sessions - a.sessions);

  const orgPeople = peopleFigures(inWindow);
  const orgBeforePeople = new Set(before.map(r => r.user_id)).size;
  return {
    tierNames,
    org: {
      people: orgPeople.people,
      sessions: inWindow.length,
      deepShare: deepShare(inWindow, orgPeople.people),
      priorDeepShare: deepShare(before, orgBeforePeople),
      hardlyUsedShare: orgPeople.people > 0 ? orgPeople.hardlyUsed / orgPeople.people : null,
      work: shares(inWindowAll, targets, labels),
    },
    teams,
    targets,
  };
}
