// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Pure tests for how mining samples a department's prompts:
// spread across the whole window, not the newest afternoon.
import { describe, it, expect } from 'vitest';
import { sampleDeptCorpora, MAX_EXCERPTS_PER_DEPT, MAX_IDENTICAL_PER_DEPT, type DeptRow } from '@/lib/usecases/process-corpus';

const NOW = 1_800_000_000;
const HOUR = 3600;
const DAY = 86400;

function row(dept: string, user: string, at: number, text: string, session = `${user}-${at}`): DeptRow {
  return { dept, user_id: user, session_id: session, content_full: text, occurred_at: at };
}

describe('sampleDeptCorpora', () => {
  it('a busy department is sampled across all four weeks, not just the newest afternoon', () => {
    const rows: DeptRow[] = [];
    // Forty people, three prompts each, all in the last afternoon.
    for (let u = 0; u < 40; u++) for (let k = 0; k < 3; k++) rows.push(row('AppliedAI', `u${u}`, NOW - (k + 1) * HOUR - u * 60, `today's task ${u}-${k}`));
    // The same people a week, two weeks and three weeks ago.
    for (const w of [1, 2, 3]) for (let u = 0; u < 40; u++) rows.push(row('AppliedAI', `u${u}`, NOW - w * 7 * DAY - u * 60, `week ${w} task ${u}`));
    rows.sort((a, b) => Number(b.occurred_at) - Number(a.occurred_at));

    const [c] = sampleDeptCorpora(rows, NOW, 28);
    expect(c.excerpts).toHaveLength(MAX_EXCERPTS_PER_DEPT);
    const days = new Set(c.excerpts.map(e => Math.floor(e.occurredAt / DAY)));
    expect(days.size).toBeGreaterThanOrEqual(4);
    const weeks = new Set(c.excerpts.map(e => Math.floor((NOW - e.occurredAt) / (7 * DAY))));
    expect([...weeks].sort()).toEqual([0, 1, 2, 3]);
  });

  it('spreads a week\'s share over its days, not just its busiest last day', () => {
    const rows: DeptRow[] = [];
    // One week only: a very busy Friday (200 prompts) and a quiet Monday to Thursday (5 each).
    for (let i = 0; i < 200; i++) rows.push(row('Consulting', `f${i % 30}`, NOW - HOUR - i * 60, `friday task ${i}`));
    for (const d of [1, 2, 3, 4]) for (let i = 0; i < 5; i++) rows.push(row('Consulting', `m${d}-${i}`, NOW - d * DAY - i * 60, `day ${d} task ${i}`));
    rows.sort((a, b) => Number(b.occurred_at) - Number(a.occurred_at));
    const [c] = sampleDeptCorpora(rows, NOW, 7);
    const perDay = new Map<number, number>();
    for (const e of c.excerpts) { const d = Math.floor(e.occurredAt / DAY); perDay.set(d, (perDay.get(d) ?? 0) + 1); }
    expect(perDay.size).toBe(5);
    // Every quiet day's prompts are all in the sample.
    expect([...perDay.values()].filter(n => n === 5)).toHaveLength(4);
  });

  it('fills a quiet week\'s share from the other weeks', () => {
    const rows: DeptRow[] = [];
    for (let i = 0; i < 160; i++) rows.push(row('Sales', `p${i % 16}`, NOW - i * 600, `pipeline note ${i}`));
    rows.sort((a, b) => Number(b.occurred_at) - Number(a.occurred_at));
    const [c] = sampleDeptCorpora(rows, NOW, 28);
    // Only week 0 has prompts. Its first-pass share is a quarter of the cap; the
    // second pass fills the empty weeks' room, so the sample reaches the full cap.
    expect(c.excerpts).toHaveLength(MAX_EXCERPTS_PER_DEPT);
  });

  it('keeps at most a few copies of the same prompt, so a repeated scheduled task cannot fill the sample', () => {
    const rows: DeptRow[] = [];
    for (let i = 0; i < 20; i++) rows.push(row('Delivery', `bot${i}`, NOW - i * DAY, 'Check pending timesheet approvals and refresh the artifact.'));
    const [c] = sampleDeptCorpora(rows, NOW, 28);
    expect(c.excerpts).toHaveLength(MAX_IDENTICAL_PER_DEPT);
  });

  it('lets one person\'s weekly task show enough sessions to reach the single-owner bar when the job asks for more copies', () => {
    const rows: DeptRow[] = [];
    for (let w = 0; w < 4; w++) rows.push(row('Delivery', 'owner', NOW - w * 7 * DAY, 'Scheduled task: weekly-margin-update. Update the margin tab.'));
    expect(sampleDeptCorpora(rows, NOW, 28)[0].excerpts).toHaveLength(MAX_IDENTICAL_PER_DEPT);
    expect(sampleDeptCorpora(rows, NOW, 28, 4)[0].excerpts).toHaveLength(4);
  });

  it('reads the person\'s words: wrapper-only and redacted prompts are skipped, system text is removed', () => {
    const rows: DeptRow[] = [
      row('Finance', 'a', NOW - 1 * DAY, '<system-reminder>device text</system-reminder> draft the variance commentary'),
      row('Finance', 'b', NOW - 2 * DAY, '<REDACTED>'),
      row('Finance', 'c', NOW - 3 * DAY, '<system-reminder>only system text</system-reminder>'),
    ];
    const [c] = sampleDeptCorpora(rows, NOW, 28);
    expect(c.excerpts.map(e => e.text)).toEqual(['draft the variance commentary']);
  });

  it('indexes excerpts oldest first', () => {
    const rows = [row('HR', 'a', NOW - DAY, 'newer'), row('HR', 'b', NOW - 9 * DAY, 'older')];
    const [c] = sampleDeptCorpora(rows, NOW, 28);
    expect(c.excerpts.map(e => [e.index, e.text])).toEqual([[0, 'older'], [1, 'newer']]);
  });
});

describe('sampleAcrossDepartments', () => {
  it('departments take turns so a big one cannot fill it; each excerpt keeps its department, oldest first', async () => {
    const { sampleAcrossDepartments } = await import('@/lib/usecases/process-corpus');
    const mk = (dept: string, n: number) => ({
      department: dept,
      excerpts: Array.from({ length: n }, (_, i) => ({ index: i, text: `${dept} ${i}`, userId: `${dept}-u${i % 5}`, sessionId: `${dept}-s${i}`, occurredAt: NOW - (n - i) * HOUR })),
      clues: { [`${dept}-s0`]: { made: [`${dept}.md`], uploaded: [], actions: [] } },
    });
    const c = sampleAcrossDepartments([mk('Big', 100), mk('Small', 4), mk('Mid', 20)], 30);
    const per = new Map<string, number>();
    for (const e of c.excerpts) per.set(e.department!, (per.get(e.department!) ?? 0) + 1);
    expect(c.excerpts).toHaveLength(30);
    expect(per.get('Small')).toBe(4);
    expect(per.get('Mid')).toBe(13);
    expect(per.get('Big')).toBe(13);
    // Picks run evenly through each department's sample, not just its oldest prompts.
    const bigIdx = c.excerpts.filter(e => e.department === 'Big').map(e => Number(e.text.split(' ')[1]));
    expect(Math.min(...bigIdx)).toBe(0);
    expect(Math.max(...bigIdx)).toBeGreaterThanOrEqual(90);
    expect(c.excerpts.map(e => e.index)).toEqual(Array.from({ length: 30 }, (_, i) => i));
    expect([...c.excerpts].sort((a, b) => a.occurredAt - b.occurredAt).map(e => e.text)).toEqual(c.excerpts.map(e => e.text));
    expect(Object.keys(c.clues ?? {}).sort()).toEqual(['Big-s0', 'Mid-s0', 'Small-s0']);
  });
});
