// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * The part of Team coaching that is the same on both surfaces: what a done action records, when it
 * is checked, and whether the figure it aimed at actually moved. Client-safe, no DB, no model call.
 *
 * A team lead marks an action done and the figure it aims at is saved as it stood that day, for the
 * team and for the organisation. From CHECK_AFTER_DAYS on, both are compared with today's: the
 * team's change less the organisation's, so a team carried up by a general rise does not read as
 * better. A team under COACHING_MIN_PEOPLE reads "too few to tell", and actions done close together
 * aiming at the same figure say so, since the change cannot be put down to one of them.
 *
 * Each surface supplies its own vocabulary: which figures exist, which way is better, and which
 * figures are read against a target rather than against the organisation.
 */

export type CoachingSurface = 'code' | 'cowork';

export const DAY_S = 86400;
export const CHECK_AFTER_DAYS = 30;
/** A change under one point reads as no change. */
export const SAME_WITHIN = 0.01;
/** Under this many people, a team's change is too small a sample to read. */
export const COACHING_MIN_PEOPLE = 5;

export type CoachingResult = 'better' | 'worse' | 'same' | 'too_few';

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

export interface Suggested<M extends string = string> {
  key: string;
  text: string;
  /** Why the plan suggests it, in one line. */
  because: string;
  metric: M | null;
}

export interface PlanAction<M extends string = string> {
  key: string;
  text: string;
  because: string;
  metric: M | null;
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

/**
 * How a surface reads its own figures.
 *  - higherIsBetter: which way the figure should move for the action to have worked.
 *  - targetFor: a figure read against a fixed target (a share of work, a floor) rather than
 *    against the organisation's own movement. Null means read it against the organisation.
 */
export interface MetricRules {
  higherIsBetter(metric: string): boolean;
  targetFor(metric: string): number | null;
  /** The figure in words, for the "did it work" line. */
  words(metric: string | null): string | null;
}

/** Whether the figure moved the way the action meant it to. */
export function compareMetric(metric: string, before: number, now: number, rules: MetricRules): 'better' | 'worse' | 'same' {
  const target = rules.targetFor(metric);
  if (target !== null) {
    const gapBefore = Math.abs(before - target);
    const gapNow = Math.abs(now - target);
    if (Math.abs(gapBefore - gapNow) < SAME_WITHIN) return 'same';
    return gapNow < gapBefore ? 'better' : 'worse';
  }
  if (Math.abs(now - before) < SAME_WITHIN) return 'same';
  return (now > before) === rules.higherIsBetter(metric) ? 'better' : 'worse';
}

/**
 * The result once the check date has passed: the team's change less the organisation's over the
 * same time, where the organisation has the figure both times. A figure with a target of its own is
 * read against that instead, since there is no general rise to allow for.
 */
export function coachingResult(
  metric: string,
  team: { before: number; now: number },
  org: { before: number | null; now: number | null },
  rules: MetricRules,
): 'better' | 'worse' | 'same' {
  if (rules.targetFor(metric) !== null || org.before === null || org.now === null) {
    return compareMetric(metric, team.before, team.now, rules);
  }
  const relative = (team.now - team.before) - (org.now - org.before);
  return compareMetric(metric, team.before, team.before + relative, rules);
}

export interface PlanContext {
  /** The team's figure for each metric today. */
  metrics: Record<string, number | null>;
  /** The organisation's figure for each metric today: the line the team is read against. */
  org: Record<string, number | null>;
  people: number;
  nowS: number;
  done: DoneRecord[];
  rules: MetricRules;
}

/** One suggested action, with whatever was recorded when it was marked done. */
export function planAction<M extends string>(a: Suggested<M>, done: DoneRecord | undefined, ctx: PlanContext): PlanAction<M> {
  if (!done) return { key: a.key, text: a.text, because: a.because, metric: a.metric, done: null };
  const checkFrom = done.doneAt + CHECK_AFTER_DAYS * DAY_S;
  const now = done.metric ? (ctx.metrics[done.metric] ?? null) : null;
  const orgNow = done.metric ? (ctx.org[done.metric] ?? null) : null;
  let result: CoachingResult | null = null;
  if (ctx.nowS >= checkFrom && done.metric && done.baseline !== null && now !== null) {
    result = ctx.people < COACHING_MIN_PEOPLE
      ? 'too_few'
      : coachingResult(done.metric, { before: done.baseline, now }, { before: done.orgBaseline, now: orgNow }, ctx.rules);
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
      measure: ctx.rules.words(done.metric),
      before: done.baseline, now, orgBefore: done.orgBaseline, orgNow, result, sharedWith,
    },
  };
}

/** Done actions the plan no longer suggests: the figure that raised them has moved. */
export function pastActions(done: DoneRecord[], current: Set<string>, ctx: PlanContext): PlanAction[] {
  return done
    .filter(d => !current.has(d.actionKey))
    .sort((a, b) => b.doneAt - a.doneAt)
    .map(d => planAction({ key: d.actionKey, text: d.actionText, because: '', metric: null }, d, ctx));
}
