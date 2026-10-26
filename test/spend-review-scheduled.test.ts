// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Spend Review: scheduled tasks on a costly model, and long sessions shown as the
// stretch of work they were. Pure functions, no database.
import { describe, it, expect } from 'vitest';
import { scheduledTaskName, cheaperFamiliesFor, summariseScheduledTask } from '@/lib/finance/spend-review';
import { sessionsFact, spansDays, workTime } from '@/lib/finance/spend-review-format';

const rates = {
  'claude-opus-5-5': { in: 5, out: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-sonnet-5': { in: 3, out: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-haiku-4-5-20251001': { in: 1, out: 5, cacheWrite: 1.25, cacheRead: 0.1 },
} as never;

describe('scheduled tasks', () => {
  it('reads the task name only from a prompt that opens a scheduled task', () => {
    expect(scheduledTaskName('<scheduled-task name="obsidian-vault-daily-analysis" file="/x/SKILL.md"> This is an automated run')).toBe('obsidian-vault-daily-analysis');
    expect(scheduledTaskName('Please look at <scheduled-task name="x">')).toBeNull();
    expect(scheduledTaskName(null)).toBeNull();
  });

  it('only calls Opus-class models costly, and offers Sonnet and Haiku for them', () => {
    expect(cheaperFamiliesFor('claude-opus-5-5', rates)).toEqual(['Sonnet', 'Haiku']);
    expect(cheaperFamiliesFor('claude-sonnet-5', rates)).toEqual([]);
    expect(cheaperFamiliesFor('claude-haiku-4-5-20251001', rates)).toEqual([]);
    expect(cheaperFamiliesFor('no-such-model', rates)).toEqual([]);
  });

  it('suggests a cheaper model when most of the cost ran on a costly one, with the real share', () => {
    const run = (at: number, opus: number, haiku: number) => ({ startedAt: at, spendByModel: new Map([['claude-opus-5-5', opus], ['claude-haiku-4-5-20251001', haiku]]) });
    const t = summariseScheduledTask('nightly', 'code', [run(1_759_000_000, 6, 4), run(1_759_090_000, 6, 4)], rates);
    expect(t).toMatchObject({ name: 'nightly', runs: 2, days: 2, spendUsd: 20, mainModel: 'claude-opus-5-5', costlyModel: 'claude-opus-5-5', cheaperFamilies: ['Sonnet', 'Haiku'] });
    expect(t.costlyShare).toBeCloseTo(0.6, 6);
  });

  it('stays quiet for a mostly cheap task, a single run, or pennies', () => {
    const mostlyHaiku = summariseScheduledTask('a', 'cowork', [1, 2].map(i => ({ startedAt: i, spendByModel: new Map([['claude-opus-5-5', 1], ['claude-haiku-4-5-20251001', 3]]) })), rates);
    expect(mostlyHaiku.cheaperFamilies).toEqual([]);
    const once = summariseScheduledTask('b', 'cowork', [{ startedAt: 1, spendByModel: new Map([['claude-opus-5-5', 30]]) }], rates);
    expect(once.cheaperFamilies).toEqual([]);
    const pennies = summariseScheduledTask('c', 'cowork', [1, 2].map(i => ({ startedAt: i, spendByModel: new Map([['claude-opus-5-5', 0.2]]) })), rates);
    expect(pennies.cheaperFamilies).toEqual([]);
  });
});

describe('long sessions read as the work they were', () => {
  const day = 86400;
  const start = Date.UTC(2026, 8, 24, 12) / 1000;

  it('names the dates and hours for one session open for days', () => {
    expect(sessionsFact({ sessions: 1, activeSecs: 1081 * 60, firstAt: start, lastAt: start + 7 * day })).toBe('1 session running 24 Sept to 1 Oct, 18 hours of work');
  });

  it('adds hours of work to several sessions, and keeps short work plain', () => {
    expect(sessionsFact({ sessions: 3, activeSecs: 4 * 3600, firstAt: start, lastAt: start + 2 * day })).toBe('3 sessions, 4 hours of work');
    expect(sessionsFact({ sessions: 2, activeSecs: 20 * 60, firstAt: start, lastAt: start + 600 })).toBe('2 sessions');
    expect(sessionsFact({ sessions: 1, activeSecs: null, firstAt: start, lastAt: start + 600 })).toBe('1 session');
  });

  it('formats time and day spans plainly', () => {
    expect(workTime(45 * 60)).toBe('45 minutes');
    expect(workTime(3600)).toBe('1 hour');
    expect(spansDays(start, start + 600)).toBe(false);
    expect(spansDays(start, start + day)).toBe(true);
    expect(spansDays(start, null)).toBe(false);
  });
});
