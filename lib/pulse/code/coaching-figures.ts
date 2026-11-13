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
import { getCodeWorkTypeDefinitions } from '@/lib/pulse/code/tier-config';
import { codeWorkTypeLabel } from '@/lib/pulse/code/work-type-labels';
import { getCodeTierNames } from '@/lib/pulse/code/weekly-tiers';
import { getConfigValue } from '@/lib/config';
import type { Vendor } from '@/lib/dashboard/vendor';
import type { TierNames } from '@/lib/pulse/tier-names';

const DAY = 86400;
/** Under this many people a team's shares are counted but never turned into a share. */
export const MIN_TEAM_PEOPLE = 3;
/** Someone with fewer sessions than this in the window has hardly used it. */
export const HARDLY_USED_SESSIONS = 2;
/** Someone whose deeper share is above this is one to learn from. */
export const CHAMPION_SHARE = 0.5;
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
  return {
    people: by.size,
    hardlyUsed: [...by.values()].filter(v => v.sessions < HARDLY_USED_SESSIONS).length,
    champions,
  };
}

export async function getCoachingFigures(vendor: Vendor, nowS = Math.floor(Date.now() / 1000)): Promise<CoachingFigures> {
  const since = nowS - 30 * DAY;
  const priorSince = nowS - 60 * DAY;
  const client = await getTypedClient();
  const rows = (await (client as unknown as { execute: (q: SQL) => Promise<{ rows: unknown[] }> }).execute(sql`
    SELECT csc.user_id,
           COALESCE(NULLIF(au.display_name, ''), u.display_name, u.email) AS name,
           ${departmentSql()} AS department,
           csc.work_type, csc.tier, css.last_at
    FROM code_session_classifications csc
    JOIN code_session_stats css ON css.session_id = csc.session_id
    LEFT JOIN users u ON u.id = csc.user_id
    LEFT JOIN admin_users au ON au.linked_cowork_user_id = csc.user_id
    WHERE csc.status = 'classified' AND css.last_at >= ${priorSince}
      AND ${codeSessionVendor(sql`css.session_id`, vendor)}
  `)).rows as Row[];

  const inWindow = rows.filter(r => n(r.last_at) >= since);
  const before = rows.filter(r => n(r.last_at) < since);
  const labels = await getCodeWorkTypeDefinitions();
  const targets = parseWorkTargets(await getConfigValue('codeEffortTargets'));
  const tierNames = await getCodeTierNames();

  const deepShare = (rs: Row[], people: number) =>
    rs.length === 0 || people < MIN_TEAM_PEOPLE ? null : rs.filter(r => n(r.tier) >= 2).length / rs.length;

  const byTeam = new Map<string, Row[]>();
  const byTeamBefore = new Map<string, Row[]>();
  for (const r of inWindow) {
    const d = r.department || NO_DEPARTMENT;
    byTeam.set(d, [...(byTeam.get(d) ?? []), r]);
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
      work: shares(rs, targets, labels),
      champions: p.champions,
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
      work: shares(inWindow, targets, labels),
    },
    teams,
    targets,
  };
}
