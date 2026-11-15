// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Team coaching's plan: what it says, what it suggests, and how it judges whether an action
 * worked. Pure functions, so no database.
 */
import { describe, it, expect } from 'vitest';
import {
  buildCoachingPlan, coachingResult, compareMetric, metricWords, teamParts,
  COACHING_MIN_PEOPLE, CHECK_AFTER_DAYS,
} from '@/lib/pulse/code/team-coaching';
import type { CoachingFigures, TeamFigures } from '@/lib/pulse/code/coaching-figures';

const NAMES = { t1: 'Single-step', t2: 'Delegated work', t3: 'Frontier delegation' };

function team(over: Partial<TeamFigures> = {}): TeamFigures {
  return {
    department: 'Engineering',
    people: 10,
    sessions: 100,
    deepShare: 0.4,
    priorDeepShare: 0.3,
    hardlyUsed: 2,
    hardlyUsedShare: 0.2,
    work: [
      { workType: 'feature', label: 'Feature build', sessions: 60, share: 0.6, target: 40 },
      { workType: 'bugfix', label: 'Bug fixing', sessions: 40, share: 0.4, target: null },
    ],
    champions: [{ userId: 'u1', name: 'Ada', sessions: 20, deepShare: 0.8 }],
    stuck: [],
    freed: null,
    repeated: [],
    newStarters: [],
    longNothing: null,
    editAcceptance: null,
    costlyOnSimple: null,
    ...over,
  };
}

function figures(t: TeamFigures, orgDeep = 0.45): CoachingFigures {
  return {
    tierNames: NAMES,
    org: {
      people: 50, sessions: 500, deepShare: orgDeep, priorDeepShare: 0.4, hardlyUsedShare: 0.1,
      work: [{ workType: 'feature', label: 'Feature build', sessions: 200, share: 0.4, target: 40 }],
    },
    teams: [t],
    targets: { feature: 40 },
  };
}

describe('what the plan says', () => {
  it('names the team\'s depth against the organisation, and the people to learn from', () => {
    const f = figures(team());
    const p = buildCoachingPlan('Engineering', f, [], 1_700_000_000)!;
    expect(p.where[0]).toContain('40% of them were multi-step work');
    expect(p.where[0]).toContain('against 45% across the organisation');
    expect(p.learnFrom[0].name).toBe('Ada');
    expect(p.actions.some(a => a.key === 'learn_from')).toBe(true);
  });

  it('suggests acting when a kind of work is far from what was intended', () => {
    const { actions, workOn } = teamParts(team(), figures(team()));
    const gap = actions.find(a => a.key === 'work_target:feature');
    expect(gap).toBeTruthy();
    expect(gap!.because).toContain('20 points above');
    expect(workOn.join(' ')).toContain('Feature build took 60%');
  });

  it('says nothing about targets when every kind is within five points', () => {
    const t = team({ work: [{ workType: 'feature', label: 'Feature build', sessions: 42, share: 0.42, target: 40 }] });
    const { actions, workOn } = teamParts(t, figures(t));
    expect(actions.some(a => a.key.startsWith('work_target:'))).toBe(false);
    expect(workOn.join(' ')).toContain('within five points');
  });

  it('names every kind of work that ties for the top', () => {
    const t = team({ work: [
      { workType: 'feature', label: 'Feature build', sessions: 50, share: 0.5, target: null },
      { workType: 'bugfix', label: 'Bug fixing', sessions: 50, share: 0.5, target: null },
    ] });
    const { workOn } = teamParts(t, figures(t));
    expect(workOn[0]).toBe('Most sessions went on feature build and bug fixing: 50% of them each.');
  });

  it('names the model of single-answer sessions as the Model mix does, not its raw id', () => {
    const t = team({ costlyOnSimple: { model: 'claude-opus-4-1-20250805', sessions: 12 } });
    const { workOn } = teamParts(t, figures(t));
    expect(workOn.join(' ')).toContain('Most single-answer sessions ran on Claude Opus 4.1: 12 sessions.');
  });

  it('puts finding out what stopped people first when most have hardly used it', () => {
    const t = team({ hardlyUsed: 7, hardlyUsedShare: 0.7 });
    const { actions } = teamParts(t, figures(t));
    expect(actions.some(a => a.key === 'hardly_used')).toBe(true);
  });

  it('is honest when there are too few sessions to read a share', () => {
    const t = team({ deepShare: null, priorDeepShare: null, sessions: 4, people: 2, hardlyUsedShare: null });
    const p = buildCoachingPlan('Engineering', figures(t), [], 1_700_000_000)!;
    expect(p.where[0]).toContain('too few to read a share from');
  });
});

describe('whether an action worked', () => {
  const targets = { feature: 40 };

  it('reads a rise in depth as better and a fall as worse', () => {
    expect(compareMetric('deep_share', 0.3, 0.4, targets)).toBe('better');
    expect(compareMetric('deep_share', 0.4, 0.3, targets)).toBe('worse');
    expect(compareMetric('deep_share', 0.4, 0.404, targets)).toBe('same');
  });

  it('reads fewer people hardly using it as better', () => {
    expect(compareMetric('hardly_used_share', 0.5, 0.3, targets)).toBe('better');
  });

  it('reads a share of work by whether it moved towards its target', () => {
    expect(compareMetric('work_share:feature', 0.6, 0.5, targets)).toBe('better');
    expect(compareMetric('work_share:feature', 0.3, 0.2, targets)).toBe('worse');
  });

  it('takes the organisation\'s own movement off the team\'s', () => {
    // The team rose 10 points, but so did everyone: that is no change.
    expect(coachingResult('deep_share', { before: 0.3, now: 0.4 }, { before: 0.3, now: 0.4 }, targets)).toBe('same');
    // The team rose more than the organisation: better.
    expect(coachingResult('deep_share', { before: 0.3, now: 0.5 }, { before: 0.3, now: 0.35 }, targets)).toBe('better');
  });

  it('falls back to the plain comparison when the organisation has no figure', () => {
    expect(coachingResult('deep_share', { before: 0.3, now: 0.4 }, { before: null, now: null }, targets)).toBe('better');
  });
});

describe('a done action', () => {
  const done = [{
    actionKey: 'learn_from', actionText: 'Ask Ada to show the team how they work.',
    metric: 'deep_share', baseline: 0.3, orgBaseline: 0.4, note: 'Ran a session',
    doneBy: 'lead@example.com', doneAt: 1_700_000_000,
  }];

  it('waits until the check date before saying anything', () => {
    const p = buildCoachingPlan('Engineering', figures(team()), done, 1_700_000_000 + 86_400)!;
    const a = p.actions.find(x => x.key === 'learn_from')!;
    expect(a.done?.result).toBeNull();
    expect(a.done?.checkFrom).toBe(1_700_000_000 + CHECK_AFTER_DAYS * 86_400);
  });

  it('judges it once the check date passes', () => {
    const after = 1_700_000_000 + (CHECK_AFTER_DAYS + 1) * 86_400;
    const p = buildCoachingPlan('Engineering', figures(team()), done, after)!;
    const a = p.actions.find(x => x.key === 'learn_from')!;
    // The team went 30% to 40%; the organisation 40% to 45%. Five points better than the trend.
    expect(a.done?.result).toBe('better');
    expect(a.done?.measure).toBe('Sessions that were multi-step work');
  });

  it('says too few to tell for a small team', () => {
    const after = 1_700_000_000 + (CHECK_AFTER_DAYS + 1) * 86_400;
    const small = team({ people: COACHING_MIN_PEOPLE - 1 });
    const p = buildCoachingPlan('Engineering', figures(small), done, after)!;
    expect(p.actions.find(x => x.key === 'learn_from')!.done?.result).toBe('too_few');
  });

  it('names the figure in words', () => {
    expect(metricWords('hardly_used_share', NAMES, [])).toBe('People who have hardly used it');
    expect(metricWords('work_share:feature', NAMES, team().work)).toBe('Sessions on feature build');
  });
});
