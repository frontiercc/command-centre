// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';

let cleanup: () => Promise<void>;

let store: typeof import('@/lib/usecases/suggestion-store');
let queries: typeof import('@/lib/usecases/queries');

beforeAll(async () => {
  const testDb = await createTestDatabase();
  cleanup = testDb.cleanup;

  store = await import('@/lib/usecases/suggestion-store');
  queries = await import('@/lib/usecases/queries');
});

afterAll(async () => cleanup());

const CANVAS = {
  story: 'Month-end commentary appears hand-assembled from pasted spreadsheet rows.',
  valueHypothesis: 'Feeding the pack template directly would turn assembly into review.',
  people: 4, sessions: 23, occasions: 9, windowDays: 28,
  rhythm: { label: 'monthly' as const, display: 'Monthly, month-end spike' },
  systems: ['anthropic-skills:xlsx', 'salesforce'], activeHours: 9.2, tierNote: 'Mostly tier 2',
};

describe('dept process suggestion storage (migration 077/0018)', () => {
  it('round-trips department and canvas; org rows stay null', async () => {
    await store.upsertOpenSuggestion({
      signalKey: 'k-dept-1', title: 'Month-end variance commentary', description: null,
      matchingRule: { skills: [], connectors: ['salesforce'], taskTypes: [], departments: ['Finance'] },
      evidence: { distinctUsers: 4, sessionCount: 23, departments: ['Finance'] },
      nowS: 1000, department: 'Finance', canvas: CANVAS,
    });
    await store.upsertOpenSuggestion({
      signalKey: 'k-org-1', title: 'Org cluster', description: null,
      matchingRule: { skills: ['x'], connectors: [], taskTypes: [], departments: [] },
      evidence: { distinctUsers: 3, sessionCount: 5, departments: [] }, nowS: 1000,
    });
    const all = await store.listOpenSuggestions();
    const dept = all.find(s => s.signalKey === 'k-dept-1')!;
    expect(dept.department).toBe('Finance');
    expect(dept.canvas?.rhythm.display).toBe('Monthly, month-end spike');
    expect(all.find(s => s.signalKey === 'k-org-1')!.department).toBeNull();
    expect(await store.countOpenByDepartment('Finance')).toBe(1);
    const boxes = await store.listOpenDeptBoxes();
    expect(boxes).toEqual([expect.objectContaining({ department: 'Finance', count: 1 })]);
  });

  it('round-trips use_cases canvas fields', async () => {
    const uc = await queries.createUseCase({ title: 'T', painPoint: 'p', valueHypothesis: 'v', baselineNote: 'b', kpiNote: 'k' });
    const back = (await queries.getUseCase(uc.id))!;
    expect([back.painPoint, back.valueHypothesis, back.baselineNote, back.kpiNote]).toEqual(['p', 'v', 'b', 'k']);
  });
});
