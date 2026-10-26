// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Pure rules: reads per department, kinds of work never suggested,
// dismissed work not coming back reworded, and two boxes for a department
// found in both Cowork and Claude Code prompts.
import { describe, it, expect } from 'vitest';
import { excludedKind, overlapsResolved } from '@/lib/usecases/process-validate';
import { groupDeptBoxes } from '@/lib/usecases/dept-boxes';
import { readsForPrompts, sampleDeptCorpora, MAX_EXCERPTS_PER_DEPT, type DeptRow } from '@/lib/usecases/process-corpus';

describe('readsForPrompts', () => {
  it('is one read per 120 usable prompts, from 1 to 6', () => {
    expect([0, 1, 120, 121, 240, 241, 720, 1959, 4577].map(readsForPrompts)).toEqual([1, 1, 1, 2, 2, 3, 6, 6, 6]);
  });

  it('counts usable prompts, not sessions: many sessions with few prompts get one read', () => {
    const now = 1_800_000_000;
    const rows: DeptRow[] = [];
    // 500 sessions, but the same scheduled prompt in nearly all of them: 3 copies usable plus 60 real prompts.
    for (let i = 0; i < 500; i++) rows.push({ dept: 'Sales', user_id: `u${i % 4}`, session_id: `s${i}`, content_full: i < 60 ? `real prompt ${i}` : 'run the nightly sync', occurred_at: now - (i % 27) * 86400 - 60 });
    expect(sampleDeptCorpora(rows, now, 28, undefined, readsForPrompts)[0].reads).toBe(1);
  });

  it('a big department gets a sample one read in size per read; a small one is unchanged', () => {
    const now = 1_800_000_000;
    const rows: DeptRow[] = [];
    for (let i = 0; i < 400; i++) {
      rows.push({ dept: 'Big', user_id: `u${i % 40}`, session_id: `s${i}`, content_full: `job number ${i}`, occurred_at: now - (i % 27) * 86400 - 60 });
    }
    for (let i = 0; i < 30; i++) {
      rows.push({ dept: 'Small', user_id: `v${i % 3}`, session_id: `t${i}`, content_full: `small job ${i}`, occurred_at: now - (i % 27) * 86400 - 60 });
    }
    const [big, small] = sampleDeptCorpora(rows, now, 28, undefined, readsForPrompts);
    expect(big.reads).toBe(4); // 400 usable prompts -> 4 reads, covering all of them
    expect(big.excerpts.length).toBe(400);
    expect(small.reads).toBe(1);
    expect(small.excerpts.length).toBe(30);
    // Without readsFor, today's single read.
    expect(sampleDeptCorpora(rows, now, 28)[0].excerpts.length).toBe(MAX_EXCERPTS_PER_DEPT);
  });
});

describe('excludedKind (titles from the 2026-10-06 a production deployment measurements)', () => {
  it('drops personal study and jobs about running Claude everywhere', () => {
    for (const t of ['Mock certification exam generation', 'Certification exam preparation and practice testing', 'Promotion justification write-up']) {
      expect([t, excludedKind(t, false)]).toEqual([t, 'personal study']);
    }
    for (const t of ['Long-running agent session monitoring', 'Autonomous build session monitoring', 'Subagent delegation report review',
      'Agentic PR review and implementation runs', 'Scheduled background agent progress checks', 'Turn-by-turn session note capture',
      'Headless issue/PR agent dispatch']) {
      expect([t, excludedKind(t, false)]).toEqual([t, 'about running Claude']);
    }
  });

  it('drops slide work from department suggestions only', () => {
    expect(excludedKind('Slide template rebranding', true)).toBe('slide work');
    expect(excludedKind('Solution architecture deck build', true)).toBe('slide work');
    expect(excludedKind('Client proposal decks', false)).toBeNull();
  });

  it('keeps real work that shares a word', () => {
    for (const t of ['Pull request review and merge', 'CI pipeline failure triage', 'AI model availability and cost check',
      'Promotional video content localization', 'Insurance agent commission statements', 'Architecture diagram maintenance',
      'Engineer skill assessment reporting', 'Board-Pack Prep', 'Month-end variance commentary']) {
      expect([t, excludedKind(t, true)]).toEqual([t, null]);
    }
  });
});

describe('overlapsResolved', () => {
  it('is true when at least three-quarters of the new suggestion\'s sessions were behind a resolved one', () => {
    expect(overlapsResolved(['a', 'b', 'c', 'd'], [['a', 'b', 'c', 'x']])).toBe(true);
    // Two of three shared, as CI failure diagnosis inside infrastructure deployments: a different job.
    expect(overlapsResolved(['a', 'b', 'c'], [['a', 'b', 'x']])).toBe(false);
    expect(overlapsResolved(['a', 'b', 'c', 'd'], [['a', 'x'], ['b', 'y']])).toBe(false);
    expect(overlapsResolved([], [['a']])).toBe(false);
    expect(overlapsResolved(['a'], [])).toBe(false);
  });
});

describe('groupDeptBoxes', () => {
  const s = (id: string, department: string | null, surface: 'cowork' | 'code' | null, people = 0, sessions = 0) =>
    ({ id, department, surface, canvas: { people, sessions } });

  it('one box per department, with Cowork and Claude Code lists inside it', () => {
    const boxes = groupDeptBoxes([s('1', 'Finance', null), s('2', 'Applied Research', 'code'), s('3', 'Applied Research', 'cowork'),
      s('4', 'Applied Research', null), s('5', 'Sales', 'code'), s('6', null, 'cowork')]);
    expect(boxes.map(b => [b.label, b.count, b.groups.map(g => [g.label, g.suggestions.map(x => x.id)])])).toEqual([
      ['Applied Research', 3, [['Cowork', ['3', '4']], ['Claude Code', ['2']]]],
      ['Finance', 1, [['Cowork', ['1']]]],
      ['Sales', 1, [['Claude Code', ['5']]]],
    ]);
  });

  it('ranks each list by people, then sessions, and Review walks Cowork then Claude Code', () => {
    const [box] = groupDeptBoxes([
      s('a', 'Ops', 'cowork', 2, 9), s('b', 'Ops', 'cowork', 4, 3), s('c', 'Ops', 'cowork', 2, 12),
      s('d', 'Ops', 'code', 3, 5), s('e', 'Ops', 'code', 3, 8), s('f', 'Ops', 'cowork', 2, 12),
    ]);
    expect(box.groups.map(g => g.suggestions.map(x => x.id))).toEqual([['b', 'c', 'f', 'a'], ['e', 'd']]);
    expect(box.suggestions.map(x => x.id)).toEqual(['b', 'c', 'f', 'a', 'e', 'd']);
  });
});
