// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Work Pulse Team coaching's plan: what it says, what it suggests, and how it judges whether an
 * action worked. Pure functions, so no database.
 */
import { describe, it, expect } from 'vitest';
import {
  buildCoworkCoachingPlan, findCoworkAction, teamParts, metricWords, coworkRules,
} from '@/lib/pulse/cowork/team-coaching';
import { coachingResult, compareMetric, COACHING_MIN_PEOPLE, CHECK_AFTER_DAYS } from '@/lib/pulse/coaching-core';
import type { CoworkCoachingFigures, CoworkTeamFigures } from '@/lib/pulse/cowork/coaching-figures';

const NAMES = { t1: 'Administrative', t2: 'Meaningful', t3: 'Frontier' };
const NOW = 1_700_000_000;

function team(over: Partial<CoworkTeamFigures> = {}): CoworkTeamFigures {
  return {
    department: 'Finance',
    people: 10,
    prompts: 200,
    sessions: 60,
    deepShare: 0.4,
    priorDeepShare: 0.3,
    hardlyUsed: 2,
    hardlyUsedShare: 0.2,
    work: [
      { taskType: 'structured_report', label: 'structured report', prompts: 120, share: 0.6 },
      { taskType: 'analysis', label: 'analysis', prompts: 80, share: 0.4 },
    ],
    champions: [{ userId: 'u1', name: 'Ada', prompts: 40, deepShare: 0.8 }],
    stuck: [],
    freed: null,
    producedNothing: null,
    produced: [],
    repeated: [],
    newStarters: [],
    soloWork: [],
    capabilities: 0,
    ...over,
  };
}

function figures(t: CoworkTeamFigures, over: Partial<CoworkCoachingFigures> = {}): CoworkCoachingFigures {
  return {
    tierNames: NAMES,
    org: {
      people: 50, prompts: 1000, deepShare: 0.45, priorDeepShare: 0.4, hardlyUsedShare: 0.1,
      work: [{ taskType: 'structured_report', label: 'structured report', prompts: 400, share: 0.4 }],
    },
    teams: [t],
    depthFloor: 33,
    ...over,
  };
}

describe('what the plan says', () => {
  it('names the team against the organisation, and the people to learn from', () => {
    const p = buildCoworkCoachingPlan('Finance', figures(team()), [], NOW)!;
    expect(p.where[0]).toContain('40% of what the team handed over was meaningful work or better');
    expect(p.where[0]).toContain('against 45% across the organisation');
    expect(p.learnFrom[0].name).toBe('Ada');
    expect(p.actions.some(a => a.key === 'learn_from')).toBe(true);
  });

  it('says so, and suggests handing a job over, when the team is under the floor', () => {
    const t = team({ deepShare: 0.2 });
    const { where, actions } = teamParts(t, figures(t));
    expect(where.join(' ')).toContain('below the 33% an admin set');
    expect(actions.some(a => a.key === 'below_floor')).toBe(true);
    // The floor is the reason, so the organisation comparison does not raise a second action.
    expect(actions.some(a => a.key === 'behind_org')).toBe(false);
  });

  it('falls back to the organisation when no floor is set', () => {
    const t = team({ deepShare: 0.2 });
    const { where, actions } = teamParts(t, figures(t, { depthFloor: 0 }));
    expect(where.join(' ')).not.toContain('floor');
    expect(actions.some(a => a.key === 'behind_org')).toBe(true);
  });

  it('raises nothing about depth when the team is over the floor and near the organisation', () => {
    const { actions } = teamParts(team(), figures(team()));
    expect(actions.some(a => a.key === 'below_floor' || a.key === 'behind_org')).toBe(false);
  });

  it('puts finding out what stopped people first when most have hardly used it', () => {
    const t = team({ hardlyUsed: 7, hardlyUsedShare: 0.7 });
    const { actions } = teamParts(t, figures(t));
    expect(actions.some(a => a.key === 'hardly_used')).toBe(true);
  });

  it('asks for the finished document when most sessions produced nothing', () => {
    const t = team({ producedNothing: { sessions: 18, measured: 20, share: 0.9 } });
    const { workOn, actions } = teamParts(t, figures(t));
    expect(workOn.join(' ')).toContain('18 of 20 sessions ended with nothing saved');
    expect(actions.find(a => a.key === 'produced_nothing')!.metric).toBe('produced_nothing_share');
  });

  it('leaves output alone when most sessions do produce something', () => {
    const t = team({ producedNothing: { sessions: 2, measured: 20, share: 0.1 } });
    const { actions } = teamParts(t, figures(t));
    expect(actions.some(a => a.key === 'produced_nothing')).toBe(false);
  });

  it('suggests a skill for work several people repeat with nothing behind it', () => {
    const t = team({ repeated: [{ taskType: 'structured_report', label: 'structured report', prompts: 24, people: 4 }] });
    const { workOn, actions } = teamParts(t, figures(t));
    expect(workOn.join(' ')).toContain('4 people did structured report 24 times');
    expect(actions.some(a => a.key === 'codify:structured_report')).toBe(true);
  });

  it('names the one person a kind of work rests on', () => {
    const t = team({ soloWork: [{ taskType: 'forecasting', label: 'forecasting', name: 'Ben', prompts: 30 }] });
    const { workOn, actions } = teamParts(t, figures(t));
    expect(workOn.join(' ')).toContain('Ben is the only person in the team doing forecasting');
    expect(actions.some(a => a.key === 'solo:forecasting')).toBe(true);
  });

  it('is honest when there is too little judged work to read a share', () => {
    const t = team({ deepShare: null, priorDeepShare: null, prompts: 4, people: 2, hardlyUsedShare: null });
    const p = buildCoworkCoachingPlan('Finance', figures(t), [], NOW)!;
    expect(p.where[0]).toContain('too few to read a share from');
  });

  it('returns nothing for a team with no figures at all', () => {
    expect(buildCoworkCoachingPlan('Nowhere', figures(team()), [], NOW)).toBeNull();
  });
});

describe('whether an action worked', () => {
  const rules = coworkRules();

  it('reads a rise in meaningful work as better and a fall as worse', () => {
    expect(compareMetric('deep_share', 0.3, 0.4, rules)).toBe('better');
    expect(compareMetric('deep_share', 0.4, 0.3, rules)).toBe('worse');
    expect(compareMetric('deep_share', 0.4, 0.404, rules)).toBe('same');
  });

  it('reads fewer people who have hardly used it, and fewer empty sessions, as better', () => {
    expect(compareMetric('hardly_used_share', 0.5, 0.3, rules)).toBe('better');
    expect(compareMetric('produced_nothing_share', 0.8, 0.5, rules)).toBe('better');
    expect(compareMetric('produced_nothing_share', 0.5, 0.8, rules)).toBe('worse');
  });

  it('takes the organisation\'s own movement off the team\'s', () => {
    // Everyone rose by the same amount, so the team did not gain on anyone.
    expect(coachingResult('deep_share', { before: 0.3, now: 0.4 }, { before: 0.3, now: 0.4 }, rules)).toBe('same');
    expect(coachingResult('deep_share', { before: 0.3, now: 0.5 }, { before: 0.3, now: 0.35 }, rules)).toBe('better');
    // The team fell, but by less than everyone else, so it gained ground.
    expect(coachingResult('deep_share', { before: 0.4, now: 0.35 }, { before: 0.4, now: 0.2 }, rules)).toBe('better');
  });

  it('reads the team on its own when the organisation has no figure', () => {
    expect(coachingResult('deep_share', { before: 0.3, now: 0.4 }, { before: null, now: null }, rules)).toBe('better');
  });

  it('puts the figure in plain words', () => {
    expect(metricWords('deep_share')).toBe('Work the classifier judged meaningful work or better');
    expect(metricWords('hardly_used_share')).toBe('People who have hardly used it');
    expect(metricWords('produced_nothing_share')).toBe('Sessions that produced nothing');
    expect(metricWords(null)).toBeNull();
  });
});

describe('a done action', () => {
  const done = (over: Record<string, unknown> = {}) => ([{
    actionKey: 'learn_from',
    actionText: 'Ask Ada to show the team how they work.',
    metric: 'deep_share',
    baseline: 0.3,
    orgBaseline: 0.45,
    note: 'Ran a session on Tuesday',
    doneBy: 'manager@example.test',
    doneAt: NOW - 40 * 86400,
    ...over,
  }]);

  it('waits until the check date before saying anything', () => {
    const p = buildCoworkCoachingPlan('Finance', figures(team()), done({ doneAt: NOW - 2 * 86400 }), NOW)!;
    const a = p.actions.find(x => x.key === 'learn_from')!;
    expect(a.done).toBeTruthy();
    expect(a.done!.result).toBeNull();
    expect(a.done!.checkFrom).toBe(NOW - 2 * 86400 + CHECK_AFTER_DAYS * 86400);
  });

  it('judges it once the check date has passed, keeping the note and who marked it', () => {
    const p = buildCoworkCoachingPlan('Finance', figures(team()), done(), NOW)!;
    const a = p.actions.find(x => x.key === 'learn_from')!;
    expect(a.done!.result).toBe('better');
    expect(a.done!.before).toBe(0.3);
    expect(a.done!.now).toBe(0.4);
    expect(a.done!.note).toBe('Ran a session on Tuesday');
    expect(a.done!.by).toBe('manager@example.test');
  });

  it('says a small team is too few to tell', () => {
    const t = team({ people: COACHING_MIN_PEOPLE - 1 });
    const p = buildCoworkCoachingPlan('Finance', figures(t), done(), NOW)!;
    expect(p.actions.find(x => x.key === 'learn_from')!.done!.result).toBe('too_few');
  });

  it('says when another action aimed at the same figure around the same time', () => {
    const two = [
      ...done(),
      { ...done()[0], actionKey: 'hardly_used', actionText: 'Ask the people who have hardly used it.', metric: 'deep_share' },
    ];
    const p = buildCoworkCoachingPlan('Finance', figures(team()), two, NOW)!;
    expect(p.actions.find(x => x.key === 'learn_from')!.done!.sharedWith).toHaveLength(1);
  });

  it('judges it on the figures it was saved on, whatever view the plan is showing', () => {
    // The plan shows one platform (0.9), but the action was saved across every platform (0.3 then, 0.4 now).
    const view = figures(team({ deepShare: 0.9 }));
    const everyPlatform = figures(team({ deepShare: 0.4 }));
    const p = buildCoworkCoachingPlan('Finance', view, done(), NOW, everyPlatform)!;
    const a = p.actions.find(x => x.key === 'learn_from')!;
    expect(a.done!.now).toBe(0.4);
    expect(a.done!.result).toBe('better');
  });

  it('moves an action the plan no longer suggests into what was done before', () => {
    const p = buildCoworkCoachingPlan('Finance', figures(team()), done({ actionKey: 'gone_now' }), NOW)!;
    expect(p.pastActions.map(a => a.key)).toContain('gone_now');
    expect(p.actions.some(a => a.key === 'gone_now')).toBe(false);
  });
});

describe('marking an action done', () => {
  it('takes the wording and the figures from the plan, never from the caller', () => {
    const f = figures(team());
    const found = findCoworkAction('Finance', 'learn_from', f)!;
    expect(found.action.text).toContain('Ada');
    expect(found.baseline).toBe(0.4);
    expect(found.orgBaseline).toBe(0.45);
  });

  it('refuses an action the plan does not suggest', () => {
    expect(findCoworkAction('Finance', 'made_up', figures(team()))).toBeNull();
  });
});
