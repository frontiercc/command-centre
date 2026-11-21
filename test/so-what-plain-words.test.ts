// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * So What speaks to leaders, so its cards must read plainly and never contradict their own picture.
 * Every card both pages can show, in every state, is built here from fixtures and checked for:
 *  - none of the product's own jargon (what the classifier does, what the page cannot count);
 *  - no sentence longer than MAX_WORDS;
 *  - no verdict the figures under it do not support.
 */
import { describe, it, expect } from 'vitest';
import { groupsFrom as codeGroupsFrom } from '@/lib/pulse/code/output-groups';
import { groupsFrom as workGroupsFrom } from '@/lib/pulse/cowork/work-groups';
import * as Code from '@/lib/pulse/code/so-what';
import * as Work from '@/lib/pulse/cowork/so-what';

const NOW = 1_700_000_000;
const MAX_WORDS = 30;

/** Phrases that explain the product rather than help a leader decide. */
const BANNED = [
  'meaningful work', 'multi-step work', 'produced something', 'produce something', 'cannot count', 'we cannot see',
  'classifier', 'ai-judged', 'judgement', 'a floor', 'close the gap first', 'hand whole work over',
  'tier 1', 'tier 2', 'tier 3', '—',
];

interface AnyCard { headline: string; body: string[]; caption: string; cannotSee: string; refusal: string | null; buttons: { go: string; hold: string } }

const textOf = (c: AnyCard) => [c.headline, ...c.body, c.caption, c.cannotSee, c.refusal ?? '', c.buttons.go, c.buttons.hold];

function checkPlain(c: AnyCard) {
  for (const t of textOf(c)) {
    for (const b of BANNED) expect(t.toLowerCase(), `"${b}" in: ${t}`).not.toContain(b);
    for (const sentence of t.split(/(?<=[.!?])\s+/)) {
      const words = sentence.split(/\s+/).filter(Boolean).length;
      expect(words, `too long (${words} words): ${sentence}`).toBeLessThanOrEqual(MAX_WORDS);
    }
  }
}

// ── Developer Pulse ─────────────────────────────────────────────────────────

type CodePerson = Parameters<typeof codeGroupsFrom>[1][number];
let n = 0;
const coder = (group: 'deep' | 'shallow' | 'hardly', commits: number, prs = 0, edits = 0): CodePerson =>
  ({ userId: `c${++n}`, department: 'Engineering', group, commits, prs, edits });
const codeTeam = (deep: number, shallow: number, d: [number, number, number], s: [number, number, number], hardly = 0) =>
  codeGroupsFrom('Engineering', [
    ...Array.from({ length: deep }, () => coder('deep', ...d)),
    ...Array.from({ length: shallow }, () => coder('shallow', ...s)),
    ...Array.from({ length: hardly }, () => coder('hardly', 0)),
  ]);

const CODE_TEAMS = {
  // First group ahead on every count, by enough to cover the request.
  ahead: codeTeam(5, 10, [20, 5, 90], [6, 1, 40], 2),
  // Ahead on every count, but by less than the request.
  partial: codeTeam(10, 3, [10, 2, 30], [8, 1.5, 25]),
  // Ahead on commits and pull requests, behind on accepted edits: the counts disagree.
  mixed: codeTeam(5, 38, [16.2, 4.6, 84.6], [7.7, 1.8, 112.4]),
  // No better on any count.
  none: codeTeam(5, 10, [5, 1, 20], [6, 1, 25]),
  tooFew: codeTeam(2, 10, [20, 5, 90], [6, 1, 40]),
  noOutput: codeTeam(5, 10, [0, 0, 0], [0, 0, 0]),
};

describe('Developer Pulse So What reads plainly', () => {
  for (const [name, g] of Object.entries(CODE_TEAMS)) {
    for (const hires of [1, 2, 5]) {
      it(`hire ${hires}, ${name} team`, () => checkPlain(Code.hireCard(g, hires, undefined, NOW)));
    }
    it(`backfill, ${name} team`, () => checkPlain(Code.backfillCard(g, undefined, NOW)));
  }

  it('found cards', () => {
    const page = Code.buildSoWhat({
      groups: [], decisions: [], asked: null, nowS: NOW,
      finds: {
        jobs: [{ workType: 'feature', label: 'New functionality', people: 40, deepPeople: 12, deepMinutes: 40, shallowPeople: 28, shallowSessions: 200, shallowMinutes: 180, hoursAMonth: 466.7 }],
        waves: [{ month: '2026-09', people: 40, reached: 22, weeksToHalf: 3 }, { month: '2026-08', people: 30, reached: 30, weeksToHalf: 5 }],
        rarelyUsed: { people: 12, costAMonth: 360, days: 30 },
        keyPeople: [{ department: 'Legal', people: 6, holders: 2, share: 0.82 }],
      },
    });
    expect(page.cards.length).toBeGreaterThan(0);
    for (const c of page.cards) checkPlain(c);
  });
});

describe('Developer Pulse So What never contradicts its chart', () => {
  it('says how many people closing the gap is worth whenever the first group is ahead on every count', () => {
    for (const g of [CODE_TEAMS.ahead, CODE_TEAMS.partial]) {
      for (const hires of [1, 2, 5]) {
        const body = Code.hireCard(g, hires, undefined, NOW).body.join(' ');
        expect(body).toMatch(/the team would get as much done as [\d.]+ more/);
      }
    }
  });

  it('says the counts do not agree, and never that there is no difference, when they disagree', () => {
    const c = Code.hireCard(CODE_TEAMS.mixed, 2, undefined, NOW);
    const body = c.body.join(' ');
    expect(body).toContain('make more commits and pull requests each than the other 38, but no more accepted edits');
    expect(body).toContain('do not agree');
    expect(body).not.toMatch(/no more done|no gap/);
  });

  it('only says coaching would not add much when the first group is ahead on nothing', () => {
    expect(Code.hireCard(CODE_TEAMS.none, 2, undefined, NOW).body.join(' ')).toContain('get no more done than the other 10');
    for (const g of [CODE_TEAMS.ahead, CODE_TEAMS.partial, CODE_TEAMS.mixed]) {
      expect(Code.hireCard(g, 2, undefined, NOW).body.join(' ')).not.toContain('would not add much');
    }
  });
});

// ── Work Pulse ──────────────────────────────────────────────────────────────

type WorkPerson = Parameters<typeof workGroupsFrom>[1][number];
let m = 0;
const worker = (deep: boolean, produced: number, over: Partial<WorkPerson> = {}): WorkPerson => ({
  userId: `w${++m}`, department: 'Finance', prompts: 20, deepPrompts: deep ? 15 : 5, sessions: 6, measured: 6, produced, ...over,
});
const workTeam = (deep: number, shallow: number, deepProduced: number, shallowProduced: number, extra: WorkPerson[] = []) =>
  workGroupsFrom('Finance', [
    ...Array.from({ length: deep }, () => worker(true, deepProduced)),
    ...Array.from({ length: shallow }, () => worker(false, shallowProduced)),
    ...extra,
  ]);

const WORK_TEAMS = {
  gap: workTeam(7, 5, 4, 1, [worker(false, 0, { sessions: 1 }), worker(false, 0, { prompts: 6 })]),
  smallGap: workTeam(4, 4, 2, 2),
  none: workTeam(4, 4, 1, 2),
  allDeep: workTeam(6, 0, 3, 0),
  tooFew: workTeam(2, 6, 4, 1),
  notMeasured: workTeam(4, 4, 0, 0).deep.share === null ? workTeam(4, 4, 0, 0) : workGroupsFrom('Finance', [
    ...Array.from({ length: 4 }, () => worker(true, 0, { measured: 0 })),
    ...Array.from({ length: 4 }, () => worker(false, 0, { measured: 0 })),
  ]),
};

describe('Work Pulse So What reads plainly', () => {
  for (const [name, g] of Object.entries(WORK_TEAMS)) {
    for (const hires of [1, 2]) {
      it(`hire ${hires}, ${name} team`, () => checkPlain(Work.hireCard(g, hires, undefined, NOW)));
    }
    it(`backfill, ${name} team`, () => checkPlain(Work.backfillCard(g, undefined, NOW)));
  }

  it('found cards', () => {
    const page = Work.buildSoWhat({
      groups: [], decisions: [], asked: null, nowS: NOW,
      finds: {
        jobs: [{ department: 'Finance', taskType: 'structured_report', label: 'structured report', people: 5, prompts: 40, sessions: 12, measuredHours: 6, deepMinutes: 20, otherMinutes: 35, skillShare: 0 }],
        waves: [{ month: '2026-09', people: 18, reached: 13, weeksToHalf: 0.6 }, { month: '2026-08', people: 12, reached: 12, weeksToHalf: 7.6 }],
        rarelyUsed: { people: 9, costAMonth: 270, days: 30 },
        keyPeople: [{ department: 'Legal', people: 6, holders: 2, share: 0.82, soloKinds: 1 }],
        rollouts: [{ eventId: 1, title: 'Month-end variance commentary', department: 'Finance', confirmedAt: NOW - 30 * 86400, taskType: 'structured_report', label: 'structured report', teams: 7, people: 57, teamsWithOne: 1 }],
        timeFreed: [{ department: 'HR', taskType: 'summarisation', label: 'summarisation', people: 8, beforeMinutes: 16, nowMinutes: 9, beforeFrom: NOW - 90 * 86400, sessions: 38, hoursAMonth: 4.4 }],
        evenings: [{ department: 'Sales', people: 12, peopleOutOfHours: 7, share: 0.31, orgShare: 0.12, timezone: 'Europe/London' }],
      },
    });
    expect(page.cards.length).toBeGreaterThan(0);
    for (const c of page.cards) checkPlain(c);
  });
});

describe('Work Pulse So What never contradicts its chart', () => {
  it('says coach first whenever the gap is wide enough to act on', () => {
    expect(Work.hireCard(WORK_TEAMS.gap, 2, undefined, NOW).headline).toContain('Coach the');
    expect(Work.backfillCard(WORK_TEAMS.gap, undefined, NOW).headline).toContain('Coach the');
  });

  it('never says "no more often" when the first group does make something more often', () => {
    for (const g of [WORK_TEAMS.gap, WORK_TEAMS.smallGap]) {
      if (g.gap !== null && g.gap > 0) expect(Work.hireCard(g, 1, undefined, NOW).body.join(' ')).not.toContain('no more often');
    }
  });
});
