// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Team coaching (Work Pulse, admin and manager): a plan for one team, written in code from the
 * figures in lib/pulse/cowork/coaching-figures.ts. No model call, and every sentence traces to a
 * stored figure. The before-and-after rules are shared with Developer Pulse in
 * lib/pulse/coaching-core.ts, so both surfaces judge an action the same way.
 *
 *  - Where the team is: how much of its work is meaningful, how that compares with the organisation
 *    and with the floor an admin set, and how many people have hardly used it.
 *  - What to work on: what the sessions produced, the work it repeats with nothing shared behind
 *    it, and the kinds of work only one person does.
 *  - Who to learn from: the people getting the most out of it, named.
 *  - What to try: the actions those suggest, each tied to the figure it should move.
 */
import type { CoworkCoachingFigures, CoworkTeamFigures } from '@/lib/pulse/cowork/coaching-figures';
import { BEHIND_ORG, PRODUCED_NOTHING_SHARE } from '@/lib/pulse/cowork/coaching-figures';
import { MEANINGFUL_WORK, kindLabel } from '@/lib/pulse/cowork/coaching-words';
import {
  planAction as corePlanAction, pastActions as corePastActions,
  type DoneRecord, type PlanAction, type Suggested, type MetricRules,
} from '@/lib/pulse/coaching-core';
import type { TierNames } from '@/lib/pulse/tier-names';

/** The figure an action is meant to move. */
export type CoworkMetric = 'deep_share' | 'hardly_used_share' | 'produced_nothing_share';

export interface CoworkCoachingPlan {
  department: string;
  people: number;
  prompts: number;
  figures: CoworkTeamFigures;
  org: CoworkCoachingFigures['org'];
  tierNames: TierNames;
  depthFloor: number;
  where: string[];
  workOn: string[];
  learnFrom: Array<{ name: string; prompts: number; deepShare: number }>;
  actions: PlanAction<CoworkMetric>[];
  /** Done actions the plan no longer suggests: the figure that raised them has moved. */
  pastActions: PlanAction<CoworkMetric>[];
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const plural = (c: number, one: string, many: string) => `${c} ${c === 1 ? one : many}`;
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** The figure in words, for the "did it work" line. */
export function metricWords(metric: string | null): string | null {
  if (metric === 'deep_share') return `Work the classifier judged ${MEANINGFUL_WORK} or better`;
  if (metric === 'hardly_used_share') return 'People who have hardly used it';
  if (metric === 'produced_nothing_share') return 'Sessions that produced nothing';
  return null;
}

/**
 * How Work Pulse reads its own figures. Every figure here is read against the organisation's own
 * movement, never against a fixed target: the depth floor says whether a team needs coaching, not
 * whether coaching worked, since a floor cannot tell a team's own progress from a general rise.
 */
export function coworkRules(): MetricRules {
  return {
    higherIsBetter: (metric: string) => metric === 'deep_share',
    targetFor: () => null,
    words: metricWords,
  };
}

/** The team's figure for each metric, null where there is none. */
export function teamMetrics(t: CoworkTeamFigures): Record<string, number | null> {
  return {
    deep_share: t.deepShare,
    hardly_used_share: t.hardlyUsedShare,
    produced_nothing_share: t.producedNothing?.share ?? null,
  };
}

/** The organisation's figure for each metric: the line the team is read against. */
export function orgMetrics(o: CoworkCoachingFigures['org']): Record<string, number | null> {
  return {
    deep_share: o.deepShare,
    hardly_used_share: o.hardlyUsedShare,
    // No organisation-wide output figure is kept, so this one is read on its own movement.
    produced_nothing_share: null,
  };
}

/** What the plan says and suggests for one team. */
export function teamParts(t: CoworkTeamFigures, f: CoworkCoachingFigures): { where: string[]; workOn: string[]; actions: Suggested<CoworkMetric>[] } {
  const where: string[] = [];
  const workOn: string[] = [];
  const actions: Suggested<CoworkMetric>[] = [];
  const org = f.org;
  const floor = f.depthFloor / 100;

  if (t.deepShare !== null) {
    let s = `${pct(t.deepShare)} of what the team handed over was ${MEANINGFUL_WORK} or better`;
    if (t.priorDeepShare !== null) {
      const pp = Math.round(t.deepShare * 100) - Math.round(t.priorDeepShare * 100);
      s += pp === 0 ? ', the same as the 30 days before' : `, ${pp > 0 ? 'up' : 'down'} ${Math.abs(pp)} ${Math.abs(pp) === 1 ? 'point' : 'points'} on the 30 days before`;
    }
    if (org.deepShare !== null) s += `, against ${pct(org.deepShare)} across the organisation`;
    where.push(`${s}.`);

    if (f.depthFloor > 0 && t.deepShare < floor) {
      where.push(`That is below the ${f.depthFloor}% an admin set as the floor for a department.`);
      actions.push({
        key: 'below_floor',
        text: 'Pick one job the team still does by hand every week and hand the whole of it over once, together.',
        because: `The team is under the ${f.depthFloor}% floor, at ${pct(t.deepShare)}.`,
        metric: 'deep_share',
      });
    } else if (org.deepShare !== null && t.deepShare < org.deepShare - BEHIND_ORG) {
      actions.push({
        key: 'behind_org',
        text: 'Pick one job the team still does by hand every week and hand the whole of it over once, together.',
        because: `The team gets less out of it than the organisation does: ${pct(t.deepShare)} against ${pct(org.deepShare)}.`,
        metric: 'deep_share',
      });
    }
  } else {
    where.push(`${plural(t.prompts, 'prompt', 'prompts')} from ${plural(t.people, 'person', 'people')} in the last 30 days: too few to read a share from.`);
  }

  const regular = t.people - t.hardlyUsed;
  let people = t.hardlyUsed === 0 && t.people > 0
    ? (t.people === 1 ? 'The one person uses it regularly' : `All ${t.people} people use it regularly`)
    : `Of ${plural(t.people, 'person', 'people')}, ${regular === 0 ? 'none' : regular} ${regular === 1 ? 'uses' : 'use'} it regularly`;
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

  // People who are in it every week and still only get single answers back.
  if (t.stuck.length > 0) {
    const names = list(t.stuck.map(s => s.name));
    where.push(`${names} ${t.stuck.length === 1 ? 'uses' : 'use'} it a lot but ${t.stuck.length === 1 ? 'is' : 'are'} still getting single answers rather than ${MEANINGFUL_WORK}.`);
    actions.push({
      key: 'stuck',
      text: `Sit with ${names} once and hand over one whole piece of work together, start to finish.`,
      because: `${plural(t.stuck[0].prompts, 'prompt', 'prompts')} from ${t.stuck.length === 1 ? 'them' : 'the first of them'}, and only ${pct(t.stuck[0].deepShare)} went beyond a single answer.`,
      metric: 'deep_share',
    });
  }

  // Someone new, before habits set.
  if (t.newStarters.length > 0) {
    const s = t.newStarters[0];
    where.push(`${t.newStarters.length === 1 ? `${s.name} started` : `${t.newStarters.length} people started`} in the last six weeks${t.newStarters.length === 1 ? `, and ${pct(s.deepShare)} of their work so far was ${MEANINGFUL_WORK} or better` : ''}.`);
    // Pairing is for those still finding their feet: not someone the team learns from, not
    // someone the stuck action already names, and not someone at or above the team's own share.
    const named = new Set([...t.champions, ...t.stuck].map(x => x.userId));
    const toPair = t.newStarters.filter(x => !named.has(x.userId) && (t.deepShare === null || x.deepShare < t.deepShare));
    if (toPair.length > 0) {
      actions.push({
        key: 'new_starters',
        text: `Pair ${list(toPair.map(x => x.name))} with someone who hands over well, in their first weeks.`,
        because: 'They are new, and habits set early.',
        metric: 'deep_share',
      });
    }
  }

  const top = t.work[0];
  if (top) workOn.push(`The commonest kind of work was ${kindLabel(top.taskType)}: ${pct(top.share)} of it.`);

  // Sessions that ended with nothing saved, sent or published.
  if (t.producedNothing && t.producedNothing.share >= PRODUCED_NOTHING_SHARE) {
    workOn.push(`${t.producedNothing.sessions} of ${t.producedNothing.measured} sessions ended with nothing saved, sent or published.`);
    actions.push({
      key: 'produced_nothing',
      text: 'Take a session that ended with nothing saved, and ask for the finished document, not the answer to a question.',
      because: `${pct(t.producedNothing.share)} of the team's sessions produced nothing.`,
      metric: 'produced_nothing_share',
    });
  }

  // The same work, by several people, with nothing shared behind it.
  for (const r of t.repeated.slice(0, 1)) {
    workOn.push(`${r.people} people did ${kindLabel(r.taskType)} ${plural(r.prompts, 'time', 'times')} with no shared skill behind any of it.`);
    actions.push({
      key: `codify:${r.taskType}`,
      text: `Turn ${kindLabel(r.taskType)} into a skill and put it on the board, so the team stops starting from scratch.`,
      because: `${plural(r.prompts, 'prompt', 'prompts')} of it across ${r.people} people, none in a session that used a skill.`,
      metric: null,
    });
  }

  // Work the team would lose with one person.
  for (const s of t.soloWork.slice(0, 1)) {
    workOn.push(`${s.name} is the only person in the team doing ${kindLabel(s.taskType)}.`);
    actions.push({
      key: `solo:${s.taskType}`,
      text: `Have ${s.name} walk one other person through ${kindLabel(s.taskType)}.`,
      because: `${plural(s.prompts, 'prompt', 'prompts')} of it, all from one person.`,
      metric: null,
    });
  }

  if (t.capabilities > 0) {
    workOn.push(`${plural(t.capabilities, 'new way of working', 'new ways of working')} came up in the team in the last 30 days.`);
  }

  if (t.champions.length > 0) {
    actions.push({
      key: 'learn_from',
      text: `Ask ${list(t.champions.map(c => c.name))} to show the team how they work.`,
      because: t.champions.length === 1
        ? `They get the most out of it: ${pct(t.champions[0].deepShare)} of their work is ${MEANINGFUL_WORK} or better.`
        : `They get the most out of it: ${t.champions[0].name} leads, with ${pct(t.champions[0].deepShare)} of their work ${MEANINGFUL_WORK} or better.`,
      metric: 'deep_share',
    });
  }

  return { where, workOn, actions };
}

/**
 * One team's plan, with whatever has already been marked done. `checkOn` is the figures a done
 * action is judged on: every platform, whatever the switch shows, since that is what was saved
 * when it was marked done. Left out, the plan's own figures are used.
 */
export function buildCoworkCoachingPlan(department: string, f: CoworkCoachingFigures, done: DoneRecord[], nowS: number, checkOn?: CoworkCoachingFigures): CoworkCoachingPlan | null {
  const t = f.teams.find(x => x.department === department);
  if (!t) return null;
  const { where, workOn, actions } = teamParts(t, f);
  const base = checkOn ?? f;
  const bt = base.teams.find(x => x.department === department);
  const ctx = {
    metrics: bt ? teamMetrics(bt) : { deep_share: null, hardly_used_share: null, produced_nothing_share: null },
    org: orgMetrics(base.org), people: bt?.people ?? 0,
    nowS, done, rules: coworkRules(),
  };
  const byKey = new Map(done.map(d => [d.actionKey, d]));
  const current = new Set(actions.map(a => a.key));
  return {
    department,
    people: t.people,
    prompts: t.prompts,
    figures: t,
    org: f.org,
    tierNames: f.tierNames,
    depthFloor: f.depthFloor,
    where,
    workOn,
    learnFrom: t.champions.map(c => ({ name: c.name, prompts: c.prompts, deepShare: c.deepShare })),
    actions: actions.map(a => corePlanAction(a, byKey.get(a.key), ctx)),
    pastActions: corePastActions(done, current, ctx) as PlanAction<CoworkMetric>[],
  };
}

/** The action a team lead may mark done, with the figures as they stand today. */
export function findCoworkAction(department: string, key: string, f: CoworkCoachingFigures): { action: Suggested<CoworkMetric>; baseline: number | null; orgBaseline: number | null } | null {
  const t = f.teams.find(x => x.department === department);
  if (!t) return null;
  const action = teamParts(t, f).actions.find(a => a.key === key);
  if (!action) return null;
  const baseline = action.metric ? (teamMetrics(t)[action.metric] ?? null) : null;
  const orgBaseline = action.metric ? (orgMetrics(f.org)[action.metric] ?? null) : null;
  return { action, baseline, orgBaseline };
}
