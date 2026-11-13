// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Decisions (Developer Pulse, admin and manager): what a leader acts on this month, from the same
 * figures Team coaching reads (lib/pulse/code/coaching-figures.ts). One query path, no model call,
 * and every sentence traces to a stored figure.
 *
 * The page is about teams, not people: it names a team, says what is wrong there, and links into
 * that team's coaching plan. Named people stay on the coaching page, one click away.
 */
import { getCoachingFigures, type CoachingFigures, type TeamFigures } from '@/lib/pulse/code/coaching-figures';
import { BEYOND_QUICK } from '@/lib/pulse/code/coaching-words';
import type { Vendor } from '@/lib/dashboard/vendor';
import type { TierNames } from '@/lib/pulse/tier-names';

/** A team needs this many people before its shares are compared with anyone else's. */
export const MIN_TEAM_PEOPLE = 3;
/** A team this far below the organisation, in points, stands out. */
export const BEHIND_PP = 0.1;
/** A kind of work this far from its target, in points, stands out. */
export const TARGET_PP = 5;
/** At most this many things to act on. */
export const ACT_ON = 5;

export type Status = 'good' | 'watch' | 'poor' | 'unknown';

export interface Headline {
  key: string;
  question: string;
  value: string | null;
  detail: string | null;
  status: Status;
}

export interface ActItem {
  key: string;
  department: string;
  what: string;
  why: string;
  /** Bigger means more people affected: the list is ordered by it. */
  reach: number;
}

export interface Cohorts {
  /** People by how far they get, least first. Counted across every team. */
  counts: { hardly: number; single: number; multi: number };
  teams: Array<{ department: string; people: number; hardly: number; single: number; multi: number; deepShare: number | null }>;
}

export interface Decisions {
  tierNames: TierNames;
  headlines: Headline[];
  actOn: ActItem[];
  effort: { org: CoachingFigures['org']['work']; teams: Array<{ department: string; label: string; share: number; target: number; pp: number }> };
  cohorts: Cohorts;
  /** Work repeated across teams with nothing shared behind it. */
  codify: Array<{ label: string; sessions: number; people: number; teams: number }>;
  /** How far people get in their first weeks, and how that compares. */
  newStarters: { people: number; deepShare: number | null; orgDeepShare: number | null };
  freed: { sessions: number; byHandHours: number; aiHours: number } | null;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const plural = (c: number, one: string, many: string) => `${c} ${c === 1 ? one : many}`;
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** Enough people to compare, and a share to compare with. */
const comparable = (t: TeamFigures) => t.people >= MIN_TEAM_PEOPLE && t.deepShare !== null;

export function buildDecisions(f: CoachingFigures): Decisions {
  const org = f.org;
  const teams = f.teams;

  // ── Who gets how far. A person is counted once, in the team they belong to. ──
  const cohortTeams = teams.map(t => {
    const multi = t.deepShare === null ? 0 : Math.round(t.deepShare * (t.people - t.hardlyUsed));
    return {
      department: t.department,
      people: t.people,
      hardly: t.hardlyUsed,
      single: Math.max(0, t.people - t.hardlyUsed - multi),
      multi,
      deepShare: t.deepShare,
    };
  });
  const cohorts: Cohorts = {
    counts: {
      hardly: cohortTeams.reduce((a, t) => a + t.hardly, 0),
      single: cohortTeams.reduce((a, t) => a + t.single, 0),
      multi: cohortTeams.reduce((a, t) => a + t.multi, 0),
    },
    teams: cohortTeams.sort((a, b) => (b.deepShare ?? -1) - (a.deepShare ?? -1)),
  };

  // ── What it freed, added up across teams that have estimates ──
  const withFreed = teams.filter(t => t.freed);
  const freed = withFreed.length === 0 ? null : {
    sessions: withFreed.reduce((a, t) => a + t.freed!.sessions, 0),
    byHandHours: withFreed.reduce((a, t) => a + t.freed!.byHandHours, 0),
    aiHours: withFreed.reduce((a, t) => a + t.freed!.aiHours, 0),
  };

  // ── Work repeated in more than one team with nothing shared behind it ──
  const byKind = new Map<string, { label: string; sessions: number; people: number; teams: number }>();
  for (const t of teams) {
    for (const r of t.repeated) {
      const e = byKind.get(r.workType) ?? { label: r.label, sessions: 0, people: 0, teams: 0 };
      e.sessions += r.sessions;
      e.people += r.people;
      e.teams += 1;
      byKind.set(r.workType, e);
    }
  }
  const codify = [...byKind.values()].sort((a, b) => b.sessions - a.sessions).slice(0, 4);

  // ── New starters across the organisation ──
  const starters = teams.flatMap(t => t.newStarters);
  const newStarters = {
    people: starters.length,
    deepShare: starters.length === 0 ? null : starters.reduce((a, s) => a + s.deepShare, 0) / starters.length,
    orgDeepShare: org.deepShare,
  };

  // ── Effort against intent: the teams furthest from a target an admin set ──
  const effortTeams: Decisions['effort']['teams'] = [];
  for (const t of teams) {
    if (t.people < MIN_TEAM_PEOPLE) continue;
    for (const w of t.work) {
      if (w.target === null) continue;
      const pp = Math.round(w.share * 100) - w.target;
      if (Math.abs(pp) >= TARGET_PP) effortTeams.push({ department: t.department, label: w.label, share: w.share, target: w.target, pp });
    }
  }
  effortTeams.sort((a, b) => Math.abs(b.pp) - Math.abs(a.pp));

  // ── What to act on, ordered by how many people it touches ──
  const actOn: ActItem[] = [];
  for (const t of teams) {
    if (!comparable(t)) continue;
    if (org.deepShare !== null && t.deepShare! < org.deepShare - BEHIND_PP) {
      actOn.push({
        key: `behind:${t.department}`,
        department: t.department,
        what: `${t.department} gets less out of it than the rest`,
        why: `${pct(t.deepShare!)} of its sessions were ${BEYOND_QUICK}, against ${pct(org.deepShare)} elsewhere.`,
        reach: t.people,
      });
    }
    if (t.hardlyUsedShare !== null && t.hardlyUsedShare > 0.5) {
      actOn.push({
        key: `hardly:${t.department}`,
        department: t.department,
        what: `Most of ${t.department} have hardly used it`,
        why: `${plural(t.hardlyUsed, 'person', 'people')} of ${t.people} had fewer than two sessions in 30 days.`,
        reach: t.hardlyUsed,
      });
    }
    if (t.stuck.length > 0) {
      actOn.push({
        key: `stuck:${t.department}`,
        department: t.department,
        what: `${plural(t.stuck.length, 'person', 'people')} in ${t.department} use it daily and still get single answers`,
        why: 'Engaged, getting little back: an hour beside someone who hands over well usually fixes it.',
        reach: t.stuck.length * 2,
      });
    }
    for (const r of t.repeated.slice(0, 1)) {
      actOn.push({
        key: `codify:${t.department}:${r.workType}`,
        department: t.department,
        what: `${t.department} repeats ${lower(r.label)} with no skill behind it`,
        why: `${plural(r.sessions, 'session', 'sessions')} across ${plural(r.people, 'person', 'people')}, none using a skill.`,
        reach: r.people,
      });
    }
  }
  const topGap = effortTeams[0];
  if (topGap) {
    actOn.push({
      key: `effort:${topGap.department}:${topGap.label}`,
      department: topGap.department,
      what: `${topGap.department} is ${Math.abs(topGap.pp)} points ${topGap.pp > 0 ? 'above' : 'below'} the ${topGap.target}% intended for ${lower(topGap.label)}`,
      why: `${pct(topGap.share)} of its sessions went there.`,
      reach: teams.find(t => t.department === topGap.department)?.people ?? 1,
    });
  }
  actOn.sort((a, b) => b.reach - a.reach);

  // ── The four headline figures ──
  const comparableTeams = teams.filter(comparable);
  const behind = comparableTeams.filter(t => org.deepShare !== null && t.deepShare! < org.deepShare - BEHIND_PP).length;
  const delegating = cohorts.counts.multi;
  const anyone = cohorts.counts.hardly + cohorts.counts.single + cohorts.counts.multi;
  const costPerSession = null; // spend lives on FinOps and Spend Review; Decisions never restates it.

  const headlines: Headline[] = [
    {
      key: 'depth',
      question: 'How much of the work goes beyond single answers?',
      value: org.deepShare === null ? null : pct(org.deepShare),
      detail: org.priorDeepShare === null ? null
        : `${Math.round(org.deepShare! * 100) - Math.round(org.priorDeepShare * 100) >= 0 ? 'up' : 'down'} ${Math.abs(Math.round(org.deepShare! * 100) - Math.round(org.priorDeepShare * 100))} points on the 30 days before`,
      status: org.deepShare === null ? 'unknown' : org.deepShare >= 0.5 ? 'good' : org.deepShare >= 0.3 ? 'watch' : 'poor',
    },
    {
      key: 'people',
      question: 'How many people hand over whole pieces of work?',
      value: anyone === 0 ? null : `${delegating} of ${anyone}`,
      detail: cohorts.counts.hardly > 0 ? `${cohorts.counts.hardly} have hardly used it` : 'everyone active uses it regularly',
      status: anyone === 0 ? 'unknown' : delegating / anyone >= 0.5 ? 'good' : delegating / anyone >= 0.25 ? 'watch' : 'poor',
    },
    {
      key: 'teams',
      question: 'How many teams are behind the rest?',
      value: comparableTeams.length === 0 ? null : `${behind} of ${comparableTeams.length}`,
      detail: comparableTeams.length === 0 ? 'no team has enough people to compare' : 'ten points or more below the organisation',
      status: comparableTeams.length === 0 ? 'unknown' : behind === 0 ? 'good' : behind <= comparableTeams.length / 3 ? 'watch' : 'poor',
    },
    {
      key: 'freed',
      question: 'What has it freed?',
      value: freed === null ? null : `${Math.round(freed.byHandHours - freed.aiHours).toLocaleString('en-GB')} hours`,
      detail: freed === null ? 'no sessions carry an estimate yet'
        : `${Math.round(freed.byHandHours).toLocaleString('en-GB')} hours by hand against ${Math.round(freed.aiHours).toLocaleString('en-GB')} measured, over ${plural(freed.sessions, 'session', 'sessions')}`,
      status: freed === null ? 'unknown' : 'good',
    },
  ];
  void costPerSession;

  return {
    tierNames: f.tierNames,
    headlines,
    actOn: actOn.slice(0, ACT_ON),
    effort: { org: org.work, teams: effortTeams.slice(0, 6) },
    cohorts,
    codify,
    newStarters,
    freed,
  };
}

export async function getDecisions(vendor: Vendor, nowS = Math.floor(Date.now() / 1000)): Promise<Decisions> {
  return buildDecisions(await getCoachingFigures(vendor, nowS));
}
