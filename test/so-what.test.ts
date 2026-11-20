// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * So what: the two-group comparison, what each card recommends, and the follow-up. Pure functions,
 * so no database.
 */
import { describe, it, expect } from 'vitest';
import { groupFor, groupsFrom, MIN_GROUP, type OutputGroups } from '@/lib/pulse/code/output-groups';
import {
  hireCard, backfillCard, buildSoWhat, followUpSentence, refusalFor,
  standardJobCard, expandCard, rarelyUsedCard, keyPeopleCard, measureSentence, type CardFigures,
} from '@/lib/pulse/code/so-what';
import type { DecisionRecord } from '@/lib/pulse/code/decision-log';

const NOW = 1_700_000_000;
const DAY = 86400;

type Person = Parameters<typeof groupsFrom>[1][number];
const person = (group: 'deep' | 'shallow' | 'hardly', commits: number): Person =>
  ({ userId: `u${Math.random()}`, department: 'Engineering', group, commits });

/** A team where the first group ships twice as much as the second. */
function team(over: { deep?: number; shallow?: number; deepEach?: number; shallowEach?: number; hardly?: number } = {}): OutputGroups {
  const { deep = 4, shallow = 6, deepEach = 20, shallowEach = 10, hardly = 0 } = over;
  return groupsFrom('Engineering', [
    ...Array.from({ length: deep }, () => person('deep', deepEach)),
    ...Array.from({ length: shallow }, () => person('shallow', shallowEach)),
    ...Array.from({ length: hardly }, () => person('hardly', 0)),
  ]);
}

describe('who goes in which group', () => {
  it('leaves someone who hardly uses it out of both', () => {
    expect(groupFor(1, 1)).toBe('hardly');
    expect(groupFor(0, 0)).toBe('hardly');
  });

  it('needs more than half a person\'s sessions to be multi-step', () => {
    expect(groupFor(10, 6)).toBe('deep');
    expect(groupFor(10, 5)).toBe('shallow');
    expect(groupFor(10, 0)).toBe('shallow');
  });
});

describe('the comparison', () => {
  it('prices the gap as people working the first group\'s way', () => {
    const g = team();
    expect(g.deep.perPerson).toBe(20);
    expect(g.shallow.perPerson).toBe(10);
    expect(g.gapPerPerson).toBe(10);
    // Six people, ten commits each behind, against twenty each: three people's worth.
    expect(g.peopleWorth).toBe(3);
    expect(g.verdict).toBe('ok');
  });

  it('counts nobody who hardly uses it, and counts everyone else whether or not they committed', () => {
    const g = groupsFrom('Engineering', [
      ...Array.from({ length: 4 }, () => person('deep', 20)),
      ...Array.from({ length: 6 }, () => person('shallow', 10)),
      ...Array.from({ length: 3 }, () => person('shallow', 0)),
      ...Array.from({ length: 2 }, () => person('hardly', 0)),
    ]);
    expect(g.hardly).toBe(2);
    expect(g.shallow.people).toBe(9);
    expect(g.dots).toHaveLength(13);
  });

  it('refuses rather than guesses when a group is too small', () => {
    const g = team({ deep: MIN_GROUP - 1 });
    expect(g.verdict).toBe('too_few');
    expect(g.peopleWorth).toBeNull();
    expect(refusalFor(g)).toContain('Too few people to tell');
  });

  it('refuses when nobody in the team made any commits, pull requests or accepted edits', () => {
    const g = groupsFrom('Engineering', [
      ...Array.from({ length: 4 }, () => person('deep', 0)),
      ...Array.from({ length: 4 }, () => person('shallow', 0)),
    ]);
    expect(g.verdict).toBe('no_output');
    expect(refusalFor(g)).toContain('We cannot answer this');
  });

  it('prices nothing when the second group already ships as much', () => {
    const g = team({ deepEach: 10, shallowEach: 12 });
    expect(g.peopleWorth).toBeNull();
  });
});

describe('the hiring card', () => {
  it('holds the hires when the gap covers them, and prices it', () => {
    const c = hireCard(team(), 3, undefined, NOW);
    expect(c.headline).toBe('Hold the 3 hires. Close the gap first.');
    expect(c.body.join(' ')).toContain('Each of them makes 20 commits, against 10 commits for each of the other 6.');
    expect(c.body.join(' ')).toContain('that is the output of 3 more people');
    expect(c.recommended).toBe('hold');
    expect(c.buttons).toEqual({ hold: 'Hold the hires', go: 'Hire anyway' });
  });

  it('approves them when there is no gap left to close', () => {
    const c = hireCard(team({ deepEach: 10, shallowEach: 12 }), 2, undefined, NOW);
    expect(c.headline).toBe('Approve the 2 hires.');
    expect(c.recommended).toBe('go');
    expect(c.buttons.go).toBe('Approve the hires');
  });

  it('is honest when the gap covers only part of the request', () => {
    // Six behind by ten each, against twenty each, is three people against five asked for.
    const c = hireCard(team(), 5, undefined, NOW);
    expect(c.headline).toBe('Hold 3 of the 5. The gap covers that much.');
    expect(c.body.join(' ')).toContain('short of the 5 asked for');
  });

  it('answers nothing, and offers no decision, when the team cannot be read', () => {
    const c = hireCard(team({ deep: 1 }), 3, undefined, NOW);
    expect(c.refusal).toContain('Too few people to tell');
    expect(c.body.join(' ')).toContain('Too few people to tell');
  });

  it('always says what it cannot see', () => {
    const c = hireCard(team({ hardly: 2 }), 3, undefined, NOW);
    expect(c.cannotSee).toContain('We cannot see output that is not a commit, a pull request or an accepted edit');
    expect(c.cannotSee).toContain('2 people hardly used it');
    expect(c.caption).toContain('commits, pull requests and accepted edits per person');
  });
});

describe('the three counts', () => {
  const withOutput = (deep: [number, number, number], shallow: [number, number, number]) => groupsFrom('Engineering', [
    ...Array.from({ length: 4 }, () => ({ ...person('deep', deep[0]), prs: deep[1], edits: deep[2] })),
    ...Array.from({ length: 6 }, () => ({ ...person('shallow', shallow[0]), prs: shallow[1], edits: shallow[2] })),
  ]);

  it('prices the gap from the count that shows the least of it', () => {
    // Commits say three people's worth, pull requests 1.5, edits two: the smallest is used.
    const g = withOutput([20, 4, 30], [10, 3, 20]);
    expect(g.peopleWorth).toBe(1.5);
    expect(g.deep.prsPerPerson).toBe(4);
    expect(g.shallow.editsPerPerson).toBe(20);
  });

  it('prices nothing when any count shows no gap', () => {
    const g = withOutput([20, 3, 30], [10, 3, 20]);
    expect(g.peopleWorth).toBeNull();
  });

  it('leaves out a count with no output at all', () => {
    const g = withOutput([20, 0, 0], [10, 0, 0]);
    expect(g.peopleWorth).toBe(3);
  });

  it('says what each group produces, per person', () => {
    const c = hireCard(withOutput([20, 4, 30], [10, 3, 20]), 1, undefined, NOW);
    expect(c.body.join(' ')).toContain('Each of them makes 20 commits, 4 pull requests and 30 accepted edits, against 10 commits, 3 pull requests and 20 accepted edits for each of the other 6.');
  });
});

describe('the backfill card', () => {
  it('says do not replace when closing the gap covers the person who left', () => {
    const c = backfillCard(team(), undefined, NOW);
    expect(c.headline).toBe('Do not replace them yet.');
    expect(c.recommended).toBe('hold');
  });

  it('says replace them when nothing in how the team works would make it up', () => {
    const c = backfillCard(team({ deepEach: 10, shallowEach: 12 }), undefined, NOW);
    expect(c.headline).toBe('Replace them.');
    expect(c.recommended).toBe('go');
  });
});

describe('a decided card', () => {
  const decision = (over: Partial<DecisionRecord> = {}): DecisionRecord => ({
    card: 'hire',
    department: 'Engineering',
    recommended: 'hold',
    chosen: 'hold',
    headline: 'Hold the 3 hires. Close the gap first.',
    figures: { deepPeople: 4, shallowPeople: 6, deepPerPerson: 20, shallowPerPerson: 10, peopleWorth: 3, commits: 140 } as unknown as Record<string, unknown>,
    note: null,
    decidedBy: 'lead@example.test',
    decidedAt: NOW - 40 * DAY,
    lookAgainAt: NOW - 10 * DAY,
    ...over,
  });

  it('holds the follow-up back until the look-again date', () => {
    const c = hireCard(team(), 3, decision({ decidedAt: NOW - 2 * DAY, lookAgainAt: NOW + 28 * DAY }), NOW);
    expect(c.decided!.followUp).toBeNull();
    expect(c.decided!.by).toBe('lead@example.test');
  });

  it('compares the figures as they stood with the figures now', () => {
    const c = hireCard(team({ deep: 7, shallow: 3 }), 3, decision(), NOW);
    expect(c.decided!.followUp!.sentence).toContain('Since then, 7 of 10 do mostly multi-step work. It was 4 of 10 when you decided.');
  });

  it('answers only the question that was asked', () => {
    const page = buildSoWhat({
      groups: [team()],
      decisions: [],
      asked: { department: 'Engineering', question: 'hire', hires: 3 },
      nowS: NOW,
    });
    expect(page.cards.map(c => c.kind)).toEqual(['hire']);
  });

  it('shows the asked card once it has been decided', () => {
    const page = buildSoWhat({
      groups: [team()],
      decisions: [decision({ card: 'backfill' })],
      asked: { department: 'Engineering', question: 'backfill', hires: 3 },
      nowS: NOW,
    });
    expect(page.cards[0].kind).toBe('backfill');
  });
});

describe('the follow-up sentence', () => {
  const figures = (over: Partial<CardFigures> = {}): CardFigures =>
    ({ deepPeople: 4, shallowPeople: 6, deepPerPerson: 20, shallowPerPerson: 10, peopleWorth: 3, commits: 140, ...over });

  it('says plainly when nobody has moved', () => {
    const s = followUpSentence(figures(), figures());
    expect(s).toContain('4 of 10 do mostly multi-step work, the same as then.');
    expect(s).toContain('ships the same as it did then');
  });

  it('never claims the decision caused the change', () => {
    const s = followUpSentence(figures(), figures({ deepPeople: 7, shallowPeople: 3, commits: 178 }));
    expect(s.toLowerCase()).toContain('since then');
    expect(s).not.toContain('because');
    expect(s).toContain('ships 38 more commits');
  });

  it('says when there is no gap left and the question should be asked again', () => {
    const s = followUpSentence(figures(), figures({ peopleWorth: 0 }));
    expect(s).toContain('There is no gap left to close. Ask again.');
  });
});

describe('the cards the page finds on its own', () => {
  const job = {
    workType: 'feature', label: 'New functionality', people: 40, deepPeople: 12, deepMinutes: 40,
    shallowPeople: 28, shallowSessions: 200, shallowMinutes: 180, hoursAMonth: 466.7,
  };
  const wave = { month: '2026-09', people: 400, reached: 220, weeksToHalf: 9 };

  it('prices a standard job in hours a month, from measured time on both sides', () => {
    const c = standardJobCard(job, undefined, NOW);
    expect(c.headline).toBe('Make new functionality a standard skill.');
    expect(c.body.join(' ')).toContain('The 12 who do it as multi-step work spend 40 minutes on it');
    expect(c.body.join(' ')).toContain('The other 28 spend 3 hours');
    expect(c.body.join(' ')).toContain('frees about 467 hours a month');
    // Everyone doing this coding work, in any department: people, not engineers.
    expect(c.body.join(' ')).toContain('40 people do this work.');
    expect(c.body.join(' ')).not.toContain('engineer');
    expect(c.caption).toContain('Not an estimate');
    expect(c.buttons).toEqual({ go: "We'll do this", hold: 'Not now' });
  });

  it('says expand when the last wave got there quickly, and hold when it did not', () => {
    expect(expandCard([wave], undefined, NOW)!.headline).toBe('Give AI coding to the next wave of people.');
    expect(expandCard([{ ...wave, weeksToHalf: 20 }], undefined, NOW)!.headline).toContain('Hold the next wave');
  });

  it('never says a wave took nought weeks', () => {
    const c = expandCard([{ ...wave, weeksToHalf: 0.3 }], undefined, NOW)!;
    expect(c.body.join(' ')).toContain('took under a week');
    expect(c.body.join(' ')).not.toContain('0 weeks');
  });

  it('offers no expand card when no wave ever got half of itself there', () => {
    expect(expandCard([{ ...wave, weeksToHalf: null }], undefined, NOW)).toBeNull();
  });

  it('never shows a cost for people who hardly use it unless a seat price is set', () => {
    const without = rarelyUsedCard({ people: 150, costAMonth: null, days: 90 }, undefined, NOW);
    expect(without.body.join(' ')).toContain('no seat price is set');
    const withPrice = rarelyUsedCard({ people: 150, costAMonth: 6000, days: 90 }, undefined, NOW);
    expect(withPrice.body.join(' ')).toContain('an estimated $6,000 a month');
    // Seats are held for the whole organisation, and the card has to say so.
    expect(withPrice.body.join(' ')).toContain('counts people, not seats');
    expect(withPrice.caption).toContain("No card here recommends anything about a person's job");
  });

  it('names no one on the key-person card', () => {
    const c = keyPeopleCard({ department: 'Engineering', people: 10, holders: 2, share: 0.72 }, undefined, NOW);
    expect(c.headline).toBe('Spread what two people in Engineering know.');
    expect(c.body.join(' ')).toContain('72% of the multi-step work in this team of 10');
    expect(c.caption).toContain('named on the team');
  });

  it('shows at most five found cards, under whatever was asked', () => {
    const page = buildSoWhat({
      groups: [team()],
      decisions: [],
      asked: { department: 'Engineering', question: 'hire', hires: 3 },
      finds: {
        jobs: [job, { ...job, workType: 'bugfix', label: 'Fixing defects' }, { ...job, workType: 'refactor', label: 'Restructuring code' }],
        waves: [wave],
        rarelyUsed: { people: 150, costAMonth: null, days: 90 },
        keyPeople: [{ department: 'Engineering', people: 10, holders: 1, share: 0.8 }],
      },
      nowS: NOW,
    });
    expect(page.cards[0].kind).toBe('hire');
    expect(page.cards.length).toBe(6);
    // Each standard job is its own decision, so they do not collapse into one another.
    expect(page.cards.filter(c => c.kind === 'standard_job').map(c => c.cardId))
      .toEqual(['standard_job:feature', 'standard_job:bugfix', 'standard_job:refactor']);
  });
});

describe('a decided found card keeps its follow-up', () => {
  const job = {
    workType: 'feature', label: 'New functionality', people: 40, deepPeople: 12, deepMinutes: 40,
    shallowPeople: 28, shallowSessions: 200, shallowMinutes: 180, hoursAMonth: 466.7,
  };
  const decided = (card: string, department = 'Everyone'): DecisionRecord => ({
    card, department, recommended: 'go', chosen: 'go', headline: 'x',
    figures: { measure: { label: 'The time the slower side spends on it', value: 200, unit: ' minutes', lowerIsBetter: true } } as unknown as Record<string, unknown>,
    note: null, decidedBy: 'lead@example.test', decidedAt: NOW - 40 * DAY, lookAgainAt: NOW - 10 * DAY,
  });

  it('never drops a decided card to keep to five', () => {
    const jobs = ['a', 'b', 'c', 'd', 'e', 'f'].map(w => ({ ...job, workType: w, label: w }));
    const page = buildSoWhat({
      groups: [team()],
      decisions: [decided('standard_job:f')],
      asked: null,
      finds: { jobs, waves: [], rarelyUsed: null, keyPeople: [] },
      nowS: NOW,
    });
    // Five undecided cards, plus the decided one that came sixth, back at the top for its follow-up.
    expect(page.cards.length).toBe(6);
    expect(page.cards[0].cardId).toBe('standard_job:f');
    expect(page.cards[0].decided?.followUp?.sentence).toContain('Since then');
  });

  it('still reads a decided job and team after they stop meeting the rule', async () => {
    const { standardJobs, keyPeople } = await import('@/lib/pulse/code/so-what-finds');
    // Too few sessions on each side to be a find on its own.
    const rows = [
      { user_id: 'a', department: 'Eng', work_type: 'feature', tier: 3, active_secs: 600, last_at: NOW },
      { user_id: 'b', department: 'Eng', work_type: 'feature', tier: 1, active_secs: 1800, last_at: NOW },
    ];
    const deep = new Set(['a']);
    expect(standardJobs(rows, deep, new Map())).toHaveLength(0);
    const kept = standardJobs(rows, deep, new Map(), card => card === 'standard_job:feature');
    expect(kept.map(j => j.workType)).toEqual(['feature']);
    // A team whose top-tier work is spread out is not a key-person find, unless it was decided.
    const teamRows = ['a', 'b', 'c', 'd', 'e'].map(u => ({ user_id: u, department: 'Eng', work_type: 'feature', tier: 3, active_secs: 60, last_at: NOW }));
    expect(keyPeople(teamRows)).toHaveLength(0);
    expect(keyPeople(teamRows, (card, d) => card === 'key_people' && d === 'Eng')[0]).toMatchObject({ department: 'Eng', holders: 2 });
  });
});

describe('the wave card names the right wave', () => {
  it('says "latest wave to get there" when the newest wave is not halfway yet', () => {
    const c = expandCard([
      { month: '2026-10', people: 8, reached: 2, weeksToHalf: null },
      { month: '2026-09', people: 20, reached: 15, weeksToHalf: 3 },
    ], undefined, NOW)!;
    expect(c.body[0]).toBe('Your latest wave to get there, of 20, took 3 weeks for half of them to start doing multi-step work.');
  });

  it('never calls two waves that both took under a week longer', () => {
    const c = expandCard([
      { month: '2026-10', people: 8, reached: 6, weeksToHalf: 0.6 },
      { month: '2026-09', people: 20, reached: 15, weeksToHalf: 0.3 },
    ], undefined, NOW)!;
    expect(c.body.join(' ')).toContain('holding or improving');
  });

  it('says "All 15" when the whole wave got there', () => {
    const c = expandCard([{ month: '2026-10', people: 15, reached: 15, weeksToHalf: 0.5 }], undefined, NOW)!;
    expect(c.body[1]).toBe('All 15 have got there so far.');
  });

  it('agrees its verb with one person in the follow-up', () => {
    const f = { deepPeople: 4, shallowPeople: 6, deepPerPerson: 20, shallowPerPerson: 10, peopleWorth: 3, commits: 140 };
    expect(followUpSentence(f, { ...f, deepPeople: 1, shallowPeople: 9 })).toContain('Since then, 1 of 10 does mostly multi-step work.');
  });
});

describe('the follow-up on the wave card', () => {
  it('words weeks plainly and uses the current label, whatever label was saved', () => {
    const then = { label: 'Weeks for half a wave to get there', value: 6.8, unit: ' weeks', lowerIsBetter: true };
    const now = { ...then, label: 'The time for half a wave to get there', value: 0.4 };
    expect(measureSentence(then, now)).toBe('Since then, the time for half a wave to get there has gone from 6.8 weeks to under a week, which is the way this card aimed for.');
  });
});

describe('the follow-up on a found card', () => {
  const measure = { label: 'The time the slower side spends on it', value: 180, unit: ' minutes', lowerIsBetter: true };

  it('says which way the figure went, and never that the decision caused it', () => {
    const s = measureSentence(measure, { ...measure, value: 120 });
    expect(s).toContain('Since then');
    expect(s).toContain('from 180 minutes to 120 minutes');
    expect(s).toContain('the way this card aimed for');
    expect(s).not.toContain('because');
  });

  it('calls a rise the wrong way where lower is better', () => {
    expect(measureSentence(measure, { ...measure, value: 240 })).toContain('the opposite of what this card aimed for');
  });

  it('says plainly when nothing moved', () => {
    expect(measureSentence(measure, { ...measure, value: 182 })).toContain('about where it was');
  });
});

describe('the refusal reads properly', () => {
  it('agrees its verbs when only one person is in a group', () => {
    const g = team({ deep: 1 });
    expect(refusalFor(g)).toContain('1 person does mostly multi-step work');
    expect(refusalFor(g)).not.toContain('person do mostly');
  });

  it('agrees them in the plural too', () => {
    expect(refusalFor(team({ deep: 2 }))).toContain('2 people do mostly multi-step work');
    expect(refusalFor(team({ shallow: 1 }))).toContain('1 person does not');
  });
});
