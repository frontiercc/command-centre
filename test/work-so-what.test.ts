// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Work Pulse So What: the two groups, the finds, what each card recommends and the follow-up.
 * Pure functions, so no database.
 */
import { describe, it, expect } from 'vitest';
import { groupFor, groupsFrom, groupsByTeam, peopleFrom, type Person, type PromptRow, type WorkData } from '@/lib/pulse/cowork/work-groups';
import { evenings, keyPeople, outOfHours, rolloutsFrom, standardJobs, timeFreed } from '@/lib/pulse/cowork/so-what-finds';
import {
  backfillCard, buildSoWhat, EVERYONE, eveningsCard, followUpSentence, hireCard, measureSentence, timeFreedCard,
  refusalFor, standardJobCard, workDecisions, DECISION_PREFIX, MAX_FOUND,
} from '@/lib/pulse/cowork/so-what';
import type { DecisionRecord } from '@/lib/pulse/code/decision-log';
import type { WorkSession } from '@/lib/pulse/cowork/work-sessions';

const NOW = 1_700_000_000;
const DAY = 86400;

let seq = 0;
const someone = (over: Partial<Person>): Person => ({
  userId: `u${++seq}`, department: 'Finance', prompts: 20, deepPrompts: 15, sessions: 6, measured: 6, produced: 3, ...over,
});

/** A team where the first group's sessions produce something far more often than the second's. */
function team(over: { deep?: number; shallow?: number; deepProduced?: number; shallowProduced?: number; light?: number; hardly?: number } = {}) {
  const { deep = 4, shallow = 4, deepProduced = 4, shallowProduced = 1, light = 0, hardly = 0 } = over;
  return groupsFrom('Finance', [
    ...Array.from({ length: deep }, () => someone({ deepPrompts: 15, produced: deepProduced })),
    ...Array.from({ length: shallow }, () => someone({ deepPrompts: 5, produced: shallowProduced })),
    ...Array.from({ length: light }, () => someone({ prompts: 6, deepPrompts: 3 })),
    ...Array.from({ length: hardly }, () => someone({ sessions: 1 })),
  ]);
}

describe('who goes in which group (Team coaching\'s rule)', () => {
  it('leaves out someone with fewer than two sessions, and someone with too few prompts to judge', () => {
    expect(groupFor(30, 30, 1)).toBe('hardly');
    expect(groupFor(9, 9, 5)).toBe('light');
  });
  it('needs more than half of at least ten prompts to be meaningful work', () => {
    expect(groupFor(10, 6, 2)).toBe('deep');
    expect(groupFor(10, 5, 2)).toBe('shallow');
  });
});

describe('the comparison', () => {
  it('compares the share of measured sessions that produced something', () => {
    const g = team();
    expect(g.verdict).toBe('ok');
    expect(g.deep.share).toBeCloseTo(4 / 6);
    expect(g.shallow.share).toBeCloseTo(1 / 6);
    expect(g.gap).toBeCloseTo(0.5);
  });
  it('is too few to tell under three people a group, and says so', () => {
    const g = team({ shallow: 2 });
    expect(g.verdict).toBe('too_few');
    expect(g.gap).toBeNull();
    expect(refusalFor(g)).toMatch(/Too few people to tell/);
  });
  it('cannot compare when too little was measured, never treating unmeasured as producing nothing', () => {
    const g = groupsFrom('Finance', [
      ...Array.from({ length: 3 }, () => someone({ deepPrompts: 15, measured: 1, produced: 1 })),
      ...Array.from({ length: 3 }, () => someone({ deepPrompts: 2, measured: 1, produced: 0 })),
    ]);
    expect(g.verdict).toBe('not_measured');
    expect(g.deep.share).toBeNull();
    expect(refusalFor(g)).toMatch(/Too little was measured/);
  });
  it('counts people in neither group', () => {
    const g = team({ light: 2, hardly: 3 });
    expect(g.light).toBe(2);
    expect(g.hardly).toBe(3);
    expect(g.deep.people + g.shallow.people).toBe(8);
  });
});

describe('reading people from the window', () => {
  it('counts prompts, meaningful prompts and measured sessions per person, by team', () => {
    const rows: PromptRow[] = [
      { user_id: 'a', department: 'Legal', tier: 2, task_type: 'analysis', session_id: 's1', occurred_at: NOW },
      { user_id: 'a', department: 'Legal', tier: 1, task_type: 'analysis', session_id: 's1', occurred_at: NOW },
      { user_id: 'b', department: null, tier: 3, task_type: 'analysis', session_id: 's2', occurred_at: NOW },
    ];
    const sessions: WorkSession[] = [
      { sessionId: 's1', userId: 'a', department: 'Legal', platform: 'claude_work', activeSecs: 60, humanMinutes: null, produced: true, lastAt: null, outputs: null, product: null },
      { sessionId: 's2', userId: 'b', department: null, platform: 'chatgpt', activeSecs: 60, humanMinutes: null, produced: null, lastAt: null, outputs: null, product: null },
    ];
    const data: WorkData = { rows, sessions, sessionsByUser: new Map([['a', 3], ['b', 1]]) };
    const people = peopleFrom(data);
    const a = people.find(p => p.userId === 'a')!;
    expect(a).toMatchObject({ prompts: 2, deepPrompts: 1, sessions: 3, measured: 1, produced: 1, department: 'Legal' });
    const b = people.find(p => p.userId === 'b')!;
    expect(b).toMatchObject({ department: 'No department', measured: 0, produced: 0 });
    expect(groupsByTeam(people).map(g => g.department)).toEqual(['Legal', 'No department']);
  });
});

describe('the hire and replace cards', () => {
  it('holds the hires while there is a gap, and says it cannot size it', () => {
    const c = hireCard(team(), 2, undefined, NOW);
    expect(c.recommended).toBe('hold');
    expect(c.headline).toBe('Hold the 2 hires. Close the gap first.');
    expect(c.body.join(' ')).toMatch(/cannot say how many hires/);
    expect(c.body.join(' ')).not.toMatch(/—/);
  });
  it('approves when there is no gap to close', () => {
    const c = hireCard(team({ deepProduced: 2, shallowProduced: 2 }), 1, undefined, NOW);
    expect(c.recommended).toBe('go');
    expect(c.headline).toBe('Approve the 1 hire.');
    expect(c.body[0]).toMatch(/no more often than the 4 who do not \(33% against 33%\)/);
  });
  it('never says "no more often" when the first group does produce more, just under the gap', () => {
    // 60 sessions a group: 9 and 6 produced something, 15% against 10%.
    const g = groupsFrom('Finance', [
      ...Array.from({ length: 3 }, () => someone({ deepPrompts: 15, measured: 20, produced: 3 })),
      ...Array.from({ length: 3 }, () => someone({ deepPrompts: 2, measured: 20, produced: 2 })),
    ]);
    const c = hireCard(g, 1, undefined, NOW);
    expect(c.recommended).toBe('go');
    expect(c.body[0]).toBe('The 3 who do mostly meaningful work produce something a little more often than the 3 who do not (15% against 10%), a difference under 10 points.');
  });
  it('refuses rather than guesses on a small team', () => {
    const c = hireCard(team({ deep: 1 }), 2, undefined, NOW);
    expect(c.refusal).not.toBeNull();
  });
  it('says replace them when nothing in the team makes up the difference', () => {
    expect(backfillCard(team({ deepProduced: 2, shallowProduced: 2 }), undefined, NOW).headline).toBe('Replace them.');
    expect(backfillCard(team(), undefined, NOW).recommended).toBe('hold');
  });
});

describe('the follow-up', () => {
  it('says since then, never because of', () => {
    const s = followUpSentence(
      { deepPeople: 3, shallowPeople: 5, deepShare: 0.6, shallowShare: 0.2 },
      { deepPeople: 5, shallowPeople: 3, deepShare: 0.6, shallowShare: 0.35 },
    );
    expect(s).toMatch(/^Since then, 5 of 8/);
    expect(s).toMatch(/35% of the time, against 20% then/);
    expect(s).not.toMatch(/because/i);
  });
  it('says plainly when the figure is about where it was', () => {
    const m = { label: 'People who have hardly used it', value: 5, unit: '', lowerIsBetter: true };
    expect(measureSentence(m, { ...m, value: 5.1 })).toMatch(/about where it was/);
    expect(measureSentence({ label: 'Weeks for half a wave to get there', value: 6.8, unit: ' weeks', lowerIsBetter: true },
      { label: 'Weeks for half a wave to get there', value: 0, unit: ' weeks', lowerIsBetter: true })).toMatch(/to under a week, which is the way you wanted/);
  });
});

describe('the finds', () => {
  const row = (user: string, dept: string, kind: string, tier: number, session: string, at = NOW): PromptRow =>
    ({ user_id: user, department: dept, tier, task_type: kind, session_id: session, occurred_at: at });

  it('finds work several people repeat with no skill, and times it only with five sessions a side', () => {
    const rows: PromptRow[] = [];
    const sessions: WorkSession[] = [];
    for (let i = 0; i < 12; i++) {
      const deep = i < 6;
      rows.push(row(`p${i % 4}`, 'Finance', 'research_brief', deep ? 2 : 1, `s${i}`));
      sessions.push({ sessionId: `s${i}`, userId: `p${i % 4}`, department: 'Finance', platform: 'claude_chat', activeSecs: deep ? 600 : 1800, humanMinutes: null, produced: false, lastAt: null, outputs: null, product: null });
    }
    const [job] = standardJobs(rows, sessions, new Set());
    expect(job).toMatchObject({ department: 'Finance', taskType: 'research_brief', people: 4, prompts: 12, sessions: 12 });
    expect(job.deepMinutes).toBe(10);
    expect(job.otherMinutes).toBe(30);
    expect(job.measuredHours).toBeCloseTo(4);
    // One session with a skill and it is no longer work with no skill behind it.
    expect(standardJobs(rows, sessions, new Set(['s3']))).toHaveLength(0);
    // ...unless a leader has decided on it, so its follow-up can still be read.
    expect(standardJobs(rows, sessions, new Set(['s3']), (card, d) => card === 'standard_job:research_brief' && d === 'Finance')[0].skillShare).toBeCloseTo(1 / 12);
    const card = standardJobCard(job, undefined, NOW);
    expect(card.body.join(' ')).toMatch(/a session of it took 10 minutes\. Otherwise it took 30 minutes\./);
  });

  it('finds a team where two people hold most of the meaningful work', () => {
    const rows: PromptRow[] = [];
    // 15 and 12 of 30: neither alone holds 60%, the two together do.
    for (let i = 0; i < 15; i++) rows.push(row('a', 'Legal', 'analysis', 2, `a${i}`));
    for (let i = 0; i < 12; i++) rows.push(row('b', 'Legal', 'analysis', 2, `b${i}`));
    for (const u of ['c', 'd', 'e']) rows.push(row(u, 'Legal', 'analysis', 2, `${u}1`), row(u, 'Legal', 'basic_drafting', 1, `${u}2`));
    const [k] = keyPeople(rows);
    expect(k).toMatchObject({ department: 'Legal', people: 5, holders: 2 });
    expect(k.share).toBeCloseTo(27 / 30);
  });

  it('finds time freed only when a session of the work is clearly quicker than two months ago', () => {
    const window = (prefix: string, mins: number) => {
      const rows: PromptRow[] = [];
      const sessions: WorkSession[] = [];
      for (let i = 0; i < 6; i++) {
        rows.push(row(`p${i % 3}`, 'HR', 'template_population', 1, `${prefix}${i}`));
        sessions.push({ sessionId: `${prefix}${i}`, userId: `p${i % 3}`, department: 'HR', platform: 'claude_chat', activeSecs: mins * 60, humanMinutes: null, produced: null, lastAt: null, outputs: null, product: null });
      }
      return { rows, sessions };
    };
    const before = { ...window('b', 40), from: NOW - 90 * DAY };
    const [t] = timeFreed(window('n', 15), before);
    expect(t).toMatchObject({ department: 'HR', taskType: 'template_population', people: 3, beforeMinutes: 40, nowMinutes: 15, sessions: 6 });
    expect(t.hoursAMonth).toBeCloseTo(2.5);
    const card = timeFreedCard(t, undefined, NOW);
    // The earlier window is named by its end date, not a month.
    expect(card.body[0]).toBe('A session of template population now takes 15 minutes, down from 40 minutes in the 30 days to 15 September.');
    expect(card.body[1]).toBe('At 6 sessions a month, that is about 2.5 hours a month the team has back.');
    // A little quicker is not time freed; too few sessions is not a comparison.
    expect(timeFreed(window('n', 36), before)).toHaveLength(0);
    expect(timeFreed({ rows: window('n', 15).rows.slice(0, 4), sessions: window('n', 15).sessions.slice(0, 4) }, before)).toHaveLength(0);
  });

  it('never counts No department as a team a way of working could go to', () => {
    const confirmed = [{ id: 7, title: 'Contract triage', confirmed_at: NOW - DAY, task_type: 'analysis', department: 'Legal' }];
    const rows = [
      row('a', 'Legal', 'analysis', 2, 's1'),
      row('b', 'Finance', 'analysis', 2, 's2'),
      row('c', '', 'analysis', 2, 's3'),
      row('d', '', 'analysis', 2, 's4'),
    ];
    const [r] = rolloutsFrom(confirmed, rows);
    expect(r).toMatchObject({ department: 'Legal', teams: 1, people: 1, teamsWithOne: 1 });
    // Only people with no department doing it: no rollout.
    expect(rolloutsFrom(confirmed, [rows[0], rows[2], rows[3]])).toHaveLength(0);
  });

  it('reads out of hours in the organisation\'s timezone, weekends included', () => {
    // Tuesday 14 November 2023: 18:30 and 19:30 in London (GMT), and a Saturday afternoon.
    const tue = Date.UTC(2023, 10, 14) / 1000;
    expect(outOfHours(tue + 18.5 * 3600, 'Europe/London')).toBe(false);
    expect(outOfHours(tue + 19.5 * 3600, 'Europe/London')).toBe(true);
    expect(outOfHours(tue + 6.5 * 3600, 'Europe/London')).toBe(true);
    expect(outOfHours(tue + 4 * DAY + 14 * 3600, 'Europe/London')).toBe(true);
    // 18:30 in London is 13:30 in New York: working hours there.
    expect(outOfHours(tue + 23.5 * 3600, 'America/New_York')).toBe(false);
  });

  it('finds a team doing far more of its work out of hours than the organisation, as a count', () => {
    const tue = Date.UTC(2023, 10, 14) / 1000;
    const rows: PromptRow[] = [];
    // Sales: 5 people, 60 prompts, 30 of them at 9pm. Finance: 5 people, 100 prompts, all at 11am.
    for (let i = 0; i < 60; i++) rows.push(row(`s${i % 5}`, 'Sales', 'analysis', 2, `s${i}`, tue + (i < 30 ? 21 : 11) * 3600));
    for (let i = 0; i < 100; i++) rows.push(row(`f${i % 5}`, 'Finance', 'analysis', 2, `f${i}`, tue + 11 * 3600));
    const found = evenings(rows, 'Europe/London');
    expect(found.map(e => e.department)).toEqual(['Sales']);
    expect(found[0]).toMatchObject({ people: 5, peopleOutOfHours: 5, share: 0.5 });
    expect(found[0].orgShare).toBeCloseTo(30 / 160);
    const card = eveningsCard(found[0], undefined, NOW);
    expect(card.headline).toBe('Look at the workload in Sales.');
    expect(card.body[0]).toBe('50% of the AI work in Sales in the last 30 days was in the evening or at the weekend, against 19% across the organisation.');
    expect(card.caption).toMatch(/never about one person/);
    // Too few people in a team: no card, so nobody can be picked out.
    expect(evenings(rows.filter(r => r.department !== 'Sales' || ['s0', 's1'].includes(r.user_id)), 'Europe/London')).toHaveLength(0);
  });
});

describe('the page', () => {
  const decision = (card: string, department: string, over: Partial<DecisionRecord> = {}): DecisionRecord => ({
    card, department, recommended: 'go', chosen: 'go', headline: 'h', note: null, decidedBy: 'lead@example.com',
    decidedAt: NOW - 35 * DAY, lookAgainAt: NOW - 5 * DAY,
    figures: { measure: { label: 'People who have hardly used it', value: 9, unit: '', lowerIsBetter: true } }, ...over,
  });

  it('keeps only Work Pulse decisions, without their prefix', () => {
    const all = [decision(`${DECISION_PREFIX}rarely_used`, EVERYONE), decision('rarely_used', EVERYONE)];
    expect(workDecisions(all).map(d => d.card)).toEqual(['rarely_used']);
  });

  it('lists found cards biggest first, at most five, and never drops a decided one', () => {
    const finds = {
      jobs: [],
      waves: [],
      rarelyUsed: { people: 4, costAMonth: null, days: 90 },
      keyPeople: Array.from({ length: 7 }, (_, i) => ({ department: `T${i}`, people: 10 + i, holders: 1, share: 0.7, soloKinds: 0 })),
      rollouts: [],
      timeFreed: [],
      evenings: [],
    };
    const page = buildSoWhat({ groups: [], decisions: [decision('rarely_used', EVERYONE)], asked: null, finds, nowS: NOW });
    expect(page.cards.filter(c => !c.decided)).toHaveLength(MAX_FOUND);
    expect(page.cards.filter(c => !c.decided).map(c => c.touches)).toEqual([16, 15, 14, 13, 12]);
    // The decided card, due its follow-up, comes back first even though it touches the fewest.
    expect(page.cards[0].kind).toBe('rarely_used');
    expect(page.cards[0].decided?.followUp?.sentence).toMatch(/gone from 9 to 4, which is the way you wanted/);
  });

  it('answers only the question that was asked', () => {
    const g = team();
    const page = buildSoWhat({ groups: [g], decisions: [], asked: { department: 'Finance', question: 'backfill', hires: 1 }, nowS: NOW });
    expect(page.cards.map(c => c.kind)).toEqual(['backfill']);
  });
});
