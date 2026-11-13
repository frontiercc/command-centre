// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Team coaching (Developer Pulse, admin and manager): a plan for one team, written in code from
 * the figures in lib/pulse/code/coaching-figures.ts. No model call, and every sentence traces to
 * a stored figure.
 *
 *  - Where the team is: how much of its work goes beyond a quick question, how many people have
 *    hardly used it, how that compares with the organisation.
 *  - What to work on: the kind of work furthest from the share an admin intended.
 *  - Who to learn from: the people delegating deepest, named.
 *  - What to try: the actions those three suggest, each tied to the figure it should move.
 *
 * A team lead marks an action done and the figure it aims at is saved as it stood that day, for
 * the team and for the organisation. From CHECK_AFTER_DAYS on, the page compares both with
 * today's: the team's change less the organisation's, so a team carried up by a general rise does
 * not read as better. A team under COACHING_MIN_PEOPLE reads "too few to tell", and actions done
 * close together aiming at the same figure say so, since the change cannot be put down to one.
 */
import type { CoachingFigures, TeamFigures, WorkShare } from '@/lib/pulse/code/coaching-figures';
import { TARGET_GAP_PP } from '@/lib/pulse/code/coaching-figures';
import type { TierNames } from '@/lib/pulse/tier-names';
import { BEYOND_QUICK } from '@/lib/pulse/code/coaching-words';

export { BEYOND_QUICK } from '@/lib/pulse/code/coaching-words';

export const CHECK_AFTER_DAYS = 30;
/** A change under one point reads as no change. */
export const SAME_WITHIN = 0.01;
/** Under this many people, a team's change is too small a sample to read. */
export const COACHING_MIN_PEOPLE = 5;

export type CoachingResult = 'better' | 'worse' | 'same' | 'too_few';

/** The figure an action is meant to move. */
export type CoachingMetric = 'deep_share' | 'hardly_used_share' | `work_share:${string}`;

export interface DoneRecord {
  actionKey: string;
  actionText: string;
  metric: string | null;
  baseline: number | null;
  orgBaseline: number | null;
  note: string | null;
  doneBy: string;
  doneAt: number;
}

export interface PlanAction {
  key: string;
  text: string;
  /** Why the plan suggests it, in one line. */
  because: string;
  metric: CoachingMetric | null;
  done: null | {
    at: number;
    by: string;
    note: string | null;
    checkFrom: number;
    measure: string | null;
    before: number | null;
    now: number | null;
    orgBefore: number | null;
    orgNow: number | null;
    result: CoachingResult | null;
    sharedWith: string[];
  };
}

export interface CoachingPlan {
  department: string;
  people: number;
  sessions: number;
  figures: TeamFigures;
  org: CoachingFigures['org'];
  tierNames: TierNames;
  where: string[];
  workOn: string[];
  learnFrom: Array<{ name: string; sessions: number; deepShare: number }>;
  actions: PlanAction[];
  /** Done actions the plan no longer suggests: the figure that raised them has moved. */
  pastActions: PlanAction[];
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const plural = (c: number, one: string, many: string) => `${c} ${c === 1 ? one : many}`;
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** The figure in words, for the "did it work" line. */
export function metricWords(metric: string | null, _names: TierNames, work: WorkShare[]): string | null {
  if (!metric) return null;
  if (metric === 'deep_share') return `Sessions that were ${BEYOND_QUICK}`;
  if (metric === 'hardly_used_share') return 'People who have hardly used it';
  if (metric.startsWith('work_share:')) {
    const id = metric.slice('work_share:'.length);
    const w = work.find(x => x.workType === id);
    return w ? `Sessions on ${lower(w.label)}` : null;
  }
  return null;
}

/** The team's figure for each metric, null where there is none. */
export function teamMetrics(t: TeamFigures): Record<string, number | null> {
  const out: Record<string, number | null> = {
    deep_share: t.deepShare,
    hardly_used_share: t.hardlyUsedShare,
  };
  for (const w of t.work) out[`work_share:${w.workType}`] = w.share;
  return out;
}

/** The organisation's figure for each metric: the line the team is read against. */
export function orgMetrics(o: CoachingFigures['org']): Record<string, number | null> {
  const out: Record<string, number | null> = {
    deep_share: o.deepShare,
    hardly_used_share: o.hardlyUsedShare,
  };
  for (const w of o.work) out[`work_share:${w.workType}`] = w.share;
  return out;
}

/** Whether the figure moved the way the action meant it to. */
export function compareMetric(metric: string, before: number, now: number, targets: Record<string, number>): 'better' | 'worse' | 'same' {
  if (metric.startsWith('work_share:')) {
    const target = targets[metric.slice('work_share:'.length)];
    if (target === undefined) return 'same';
    const gapBefore = Math.abs(before - target / 100);
    const gapNow = Math.abs(now - target / 100);
    if (Math.abs(gapBefore - gapNow) < SAME_WITHIN) return 'same';
    return gapNow < gapBefore ? 'better' : 'worse';
  }
  if (Math.abs(now - before) < SAME_WITHIN) return 'same';
  const higherIsBetter = metric === 'deep_share';
  return (now > before) === higherIsBetter ? 'better' : 'worse';
}

/**
 * The result once the check date has passed: the team's change less the organisation's over the
 * same time, where the organisation has the figure both times. A share of work is read against
 * its target instead, since there is no general rise to allow for.
 */
export function coachingResult(
  metric: string,
  team: { before: number; now: number },
  org: { before: number | null; now: number | null },
  targets: Record<string, number>,
): 'better' | 'worse' | 'same' {
  if (metric.startsWith('work_share:') || org.before === null || org.now === null) {
    return compareMetric(metric, team.before, team.now, targets);
  }
  const relative = (team.now - team.before) - (org.now - org.before);
  return compareMetric(metric, team.before, team.before + relative, targets);
}

interface Suggested { key: string; text: string; because: string; metric: CoachingMetric | null }

/** What the plan says and suggests for one team. */
export function teamParts(t: TeamFigures, f: CoachingFigures): { where: string[]; workOn: string[]; actions: Suggested[] } {
  const where: string[] = [];
  const workOn: string[] = [];
  const actions: Suggested[] = [];
  const org = f.org;

  if (t.deepShare !== null) {
    let s = `${pct(t.deepShare)} of them were ${BEYOND_QUICK}`;
    if (t.priorDeepShare !== null) {
      const pp = Math.round(t.deepShare * 100) - Math.round(t.priorDeepShare * 100);
      s += pp === 0 ? ', the same as the 30 days before' : `, ${pp > 0 ? 'up' : 'down'} ${Math.abs(pp)} ${Math.abs(pp) === 1 ? 'point' : 'points'} on the 30 days before`;
    }
    if (org.deepShare !== null) s += `, against ${pct(org.deepShare)} across the organisation`;
    where.push(`${s}.`);
    if (org.deepShare !== null && t.deepShare < org.deepShare - 0.1) {
      actions.push({
        key: 'deep_below_org',
        text: 'Pick one repeating job the team does by hand and hand the whole of it over once, together.',
        because: `The team hands over less than the organisation does: ${pct(t.deepShare)} against ${pct(org.deepShare)}.`,
        metric: 'deep_share',
      });
    }
  } else {
    where.push(`${plural(t.sessions, 'session', 'sessions')} from ${plural(t.people, 'person', 'people')} in the last 30 days: too few to read a share from.`);
  }

  const regular = t.people - t.hardlyUsed;
  let people = `Of ${plural(t.people, 'person', 'people')}, ${regular === 0 ? 'none' : regular} ${regular === 1 ? 'uses' : 'use'} it regularly`;
  if (t.hardlyUsed > 0) people += ` and ${plural(t.hardlyUsed, 'has', 'have')} hardly used it`;
  where.push(`${people}.`);
  if (t.hardlyUsedShare !== null && t.hardlyUsedShare > 0.5) {
    actions.push({
      key: 'hardly_used',
      text: 'Ask the people who have hardly used it what stopped them, before anything else.',
      because: `${pct(t.hardlyUsedShare)} of the team have hardly used it.`,
      metric: 'hardly_used_share',
    });
  }

  // People using it steadily who still get single-step answers: engaged, getting little back.
  if (t.stuck.length > 0) {
    const names = list(t.stuck.map(s => s.name));
    where.push(`${names} ${t.stuck.length === 1 ? 'uses' : 'use'} it regularly but ${t.stuck.length === 1 ? 'is' : 'are'} still getting single answers rather than ${BEYOND_QUICK}.`);
    actions.push({
      key: 'stuck',
      text: `Sit with ${names} once and hand over one whole task together, start to finish.`,
      because: `${t.stuck.length === 1 ? 'They have' : 'They have'} ${t.stuck[0].sessions} sessions but only ${pct(t.stuck[0].deepShare)} went beyond a single answer.`,
      metric: 'deep_share',
    });
  }

  // Someone new, before habits set.
  if (t.newStarters.length > 0) {
    const s = t.newStarters[0];
    where.push(`${t.newStarters.length === 1 ? `${s.name} started` : `${t.newStarters.length} people started`} in the last six weeks${t.newStarters.length === 1 ? `, and ${pct(s.deepShare)} of their ${plural(s.sessions, 'session', 'sessions')} so far went beyond a single answer` : ''}.`);
    actions.push({
      key: 'new_starters',
      text: `Pair ${list(t.newStarters.map(x => x.name))} with someone who hands over well, in their first weeks.`,
      because: 'They are new, and habits set early.',
      metric: 'deep_share',
    });
  }

  const top = t.work[0];
  const gaps = t.work
    .filter(w => w.target !== null)
    .map(w => ({ w, pp: Math.round(w.share * 100) - w.target! }))
    .sort((a, b) => Math.abs(b.pp) - Math.abs(a.pp));
  if (top) {
    workOn.push(`Most sessions went on ${lower(top.label)}: ${pct(top.share)} of them.`);
  }
  if (gaps.length > 0 && Math.abs(gaps[0].pp) >= TARGET_GAP_PP) {
    const g = gaps[0];
    workOn.push(`${g.w.label} took ${pct(g.w.share)} against the ${g.w.target}% intended, ${g.pp > 0 ? 'above' : 'below'} by ${Math.abs(g.pp)} points.`);
    actions.push({
      key: `work_target:${g.w.workType}`,
      text: g.pp > 0
        ? `Move some ${lower(g.w.label)} work off the team, or agree the target is wrong.`
        : `Point the next few sessions at ${lower(g.w.label)}.`,
      because: `${g.w.label} is ${Math.abs(g.pp)} points ${g.pp > 0 ? 'above' : 'below'} the ${g.w.target}% intended.`,
      metric: `work_share:${g.w.workType}`,
    });
  } else if (gaps.length > 0) {
    workOn.push('Every kind of work is within five points of what was intended.');
  }

  // Long sessions that committed nothing: wrong-shaped task, or missing context.
  if (t.longNothing && t.longNothing.long >= 4 && t.longNothing.share >= 0.25) {
    workOn.push(`${t.longNothing.sessions} of ${t.longNothing.long} sessions over an hour committed nothing.`);
    actions.push({
      key: 'long_nothing',
      text: 'Take one of those long sessions and break the task into pieces the assistant can finish.',
      because: `${pct(t.longNothing.share)} of the team's long sessions ended with no commit.`,
      metric: null,
    });
  }

  // Edits it suggests that the team throws away.
  if (t.editAcceptance && t.editAcceptance.org !== null && t.editAcceptance.team < t.editAcceptance.org - 0.1) {
    workOn.push(`The team keeps ${pct(t.editAcceptance.team)} of the edits it suggests, against ${pct(t.editAcceptance.org)} across the organisation.`);
    actions.push({
      key: 'edit_acceptance',
      text: 'Look at what the assistant is being given to work from: low acceptance is usually missing context, not the model.',
      because: `${pct(t.editAcceptance.team)} of its edits are kept here, against ${pct(t.editAcceptance.org)} elsewhere.`,
      metric: null,
    });
  }

  // The same work, by several people, with nothing shared behind it.
  for (const r of t.repeated.slice(0, 1)) {
    workOn.push(`${r.people} people did ${lower(r.label)} ${plural(r.sessions, 'time', 'times')} with no shared skill behind any of it.`);
    actions.push({
      key: `codify:${r.workType}`,
      text: `Write one skill for ${lower(r.label)} and put it on the board, so the team stops starting from scratch.`,
      because: `${plural(r.sessions, 'session', 'sessions')} of it across ${r.people} people, none using a skill.`,
      metric: null,
    });
  }

  // The dearest habit, pointed at the page that owns money.
  if (t.costlyOnSimple) {
    workOn.push(`Most single-answer sessions ran on ${t.costlyOnSimple.model}: ${plural(t.costlyOnSimple.sessions, 'session', 'sessions')}.`);
  }

  if (t.champions.length > 0) {
    actions.push({
      key: 'learn_from',
      text: `Ask ${list(t.champions.map(c => c.name))} to show the team how they work.`,
      because: `They hand over the most: ${pct(t.champions[0].deepShare)} of their sessions.`,
      metric: 'deep_share',
    });
  }

  return { where, workOn, actions };
}

function planAction(
  a: Suggested,
  done: DoneRecord | undefined,
  ctx: { metrics: Record<string, number | null>; org: Record<string, number | null>; people: number; targets: Record<string, number>; nowS: number; done: DoneRecord[]; names: TierNames; work: WorkShare[] },
): PlanAction {
  if (!done) return { key: a.key, text: a.text, because: a.because, metric: a.metric, done: null };
  const checkFrom = done.doneAt + CHECK_AFTER_DAYS * DAY_S;
  const now = done.metric ? (ctx.metrics[done.metric] ?? null) : null;
  const orgNow = done.metric ? (ctx.org[done.metric] ?? null) : null;
  let result: CoachingResult | null = null;
  if (ctx.nowS >= checkFrom && done.metric && done.baseline !== null && now !== null) {
    result = ctx.people < COACHING_MIN_PEOPLE
      ? 'too_few'
      : coachingResult(done.metric, { before: done.baseline, now }, { before: done.orgBaseline, now: orgNow }, ctx.targets);
  }
  const sharedWith = done.metric
    ? ctx.done
        .filter(d => d.actionKey !== done.actionKey && d.metric === done.metric && Math.abs(d.doneAt - done.doneAt) < CHECK_AFTER_DAYS * DAY_S)
        .map(d => d.actionText)
    : [];
  return {
    key: a.key,
    text: done.actionText,
    because: a.because,
    metric: a.metric,
    done: {
      at: done.doneAt, by: done.doneBy, note: done.note, checkFrom,
      measure: metricWords(done.metric, ctx.names, ctx.work),
      before: done.baseline, now, orgBefore: done.orgBaseline, orgNow, result, sharedWith,
    },
  };
}

const DAY_S = 86400;

/** One team's plan, with whatever has already been marked done. */
export function buildCoachingPlan(department: string, f: CoachingFigures, done: DoneRecord[], nowS: number): CoachingPlan | null {
  const t = f.teams.find(x => x.department === department);
  if (!t) return null;
  const { where, workOn, actions } = teamParts(t, f);
  const ctx = {
    metrics: teamMetrics(t), org: orgMetrics(f.org), people: t.people,
    targets: f.targets, nowS, done, names: f.tierNames, work: t.work,
  };
  const byKey = new Map(done.map(d => [d.actionKey, d]));
  const current = new Set(actions.map(a => a.key));
  return {
    department,
    people: t.people,
    sessions: t.sessions,
    figures: t,
    org: f.org,
    tierNames: f.tierNames,
    where,
    workOn,
    learnFrom: t.champions.map(c => ({ name: c.name, sessions: c.sessions, deepShare: c.deepShare })),
    actions: actions.map(a => planAction(a, byKey.get(a.key), ctx)),
    pastActions: done
      .filter(d => !current.has(d.actionKey))
      .sort((a, b) => b.doneAt - a.doneAt)
      .map(d => planAction({ key: d.actionKey, text: d.actionText, because: '', metric: null }, d, ctx)),
  };
}

/** The action a team lead may mark done, with the figures as they stand today. */
export function findAction(department: string, key: string, f: CoachingFigures): { action: Suggested; baseline: number | null; orgBaseline: number | null } | null {
  const t = f.teams.find(x => x.department === department);
  if (!t) return null;
  const action = teamParts(t, f).actions.find(a => a.key === key);
  if (!action) return null;
  const baseline = action.metric ? (teamMetrics(t)[action.metric] ?? null) : null;
  const orgBaseline = action.metric ? (orgMetrics(f.org)[action.metric] ?? null) : null;
  return { action, baseline, orgBaseline };
}
