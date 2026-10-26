// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import type { SuggestionDraft, DeptProcessBox } from '@/lib/usecases/suggestion-store';
import type { ModelEfficiencyReport, ActivityRow, OpportunityFlag } from '@/lib/finance/model-efficiency';
import { createTestDatabase } from './helpers/db';

const cfg = { useCasesEnabled: true, useCasesSuggestUseContent: 'true', financeModelEfficiencyEnabled: false };
let getAllConfigImpl: () => typeof cfg = () => cfg;
vi.mock('@/lib/config', () => ({
  getAllConfig: () => getAllConfigImpl(),
}));

const getCoachingCountsByDeptMock = vi.fn<() => Promise<Array<{ dept: string; count: number }>>>(async () => []);
vi.mock('@/lib/usecases/spread', () => ({
  getCoachingCountsByDept: getCoachingCountsByDeptMock,
}));

const listOpenDeptBoxesMock = vi.fn<() => Promise<DeptProcessBox[]>>(async () => []);
vi.mock('@/lib/usecases/suggestion-store', () => ({
  listOpenDeptBoxes: listOpenDeptBoxesMock,
}));

function emptyReport(surface: 'code' | 'cowork'): ModelEfficiencyReport {
  return {
    surface,
    enabled: true,
    hasData: false,
    period: { start: 0, end: 0 },
    totals: { spendUsd: 0, tokens: 0 },
    activities: [],
    unpricedModels: [],
    belowVolume: [],
    modelOrder: [],
    cacheEfficiency: { ratio: null, cacheReadTokens: 0, inputSideTokens: 0 },
    spendByModel: [],
    costByType: { inputUsd: 0, outputUsd: 0, cacheWriteUsd: 0, cacheReadUsd: 0, unclassifiedUsd: 0 },
  };
}

const buildModelEfficiencyMock = vi.fn<
  (surface: 'code' | 'cowork', period: string, nowS?: number) => Promise<ModelEfficiencyReport>
>(async (surface) => emptyReport(surface));
vi.mock('@/lib/finance/model-efficiency', () => ({
  buildModelEfficiency: buildModelEfficiencyMock,
}));

function flaggedActivity(model: string, overrides: Partial<OpportunityFlag> = {}): ActivityRow {
  return {
    key: `act-${model}`,
    label: model,
    judged: true,
    totalSpendUsd: 10,
    tokens: 1000,
    byModel: [],
    measuredBreakdown: [],
    friction: null,
    flag: { premiumModel: model, premiumShare: 0.9, targetModel: null, estCeilingUsd: null, ...overrides },
  };
}

function makeSuggestion(overrides: Partial<SuggestionDraft> = {}): SuggestionDraft {
  return {
    id: 'sugg-1',
    signalKey: 'key-1',
    title: 'Automated expense triage',
    description: null,
    matchingRule: { skills: [], connectors: [], taskTypes: [], departments: [] },
    evidence: { distinctUsers: 5, sessionCount: 10, departments: ['Finance'] },
    status: 'open',
    generatedAt: 1,
    department: null,
    canvas: null,
    surface: null,
    ...overrides,
  };
}

const NOW_S = 1_756_000_000; // fixed reference instant

// The buildActNext tests seed use_cases/users rows directly, so the file needs
// its own migrated test database.
let cleanup: () => Promise<void>;
beforeAll(async () => {
  ({ cleanup } = await createTestDatabase());
});
afterAll(async () => cleanup());

describe('buildActNext', () => {
  beforeEach(async () => {
    cfg.useCasesEnabled = true;
    cfg.financeModelEfficiencyEnabled = false;
    getAllConfigImpl = () => cfg;
    getCoachingCountsByDeptMock.mockReset().mockResolvedValue([]);
    buildModelEfficiencyMock.mockReset().mockImplementation(async (surface) => emptyReport(surface));

    // Clean slate for the confirmed-use-case row this file seeds directly.
    const client = await getTypedClient();
    const { inArray } = await import('drizzle-orm');
    await client.delete(schema.useCases).where(inArray(schema.useCases.id, ['an-quiet-1']));
  });

  it('flag off: no rows at all, even with coaching data available', async () => {
    cfg.useCasesEnabled = false;
    getCoachingCountsByDeptMock.mockResolvedValue([{ dept: 'Finance', count: 2 }]);

    const { buildActNext } = await import('@/lib/pulse/act-next');
    const rows = await buildActNext('admin', NOW_S);
    expect(rows).toEqual([]);
  });

  it('the still-retired sources (new-workflow suggestion, at_risk use case) contribute no row — only coaching rows remain when model review is off', async () => {
    // An at_risk confirmed use case used to produce a workflow_quiet row.
    // It no longer does — buildActNext doesn't query use_cases at all now.
    const client = await getTypedClient();
    await client.insert(schema.useCases).values({
      id: 'an-quiet-1', title: 'AN Quiet UC', status: 'confirmed', lifecycle: 'at_risk',
      lifecycle_changed_at: NOW_S - 3 * 7 * 86400,
    } as never);
    getCoachingCountsByDeptMock.mockResolvedValue([{ dept: 'Finance', count: 2 }]);

    const { buildActNext } = await import('@/lib/pulse/act-next');
    const rows = await buildActNext('admin', NOW_S);
    expect(rows).toHaveLength(1);
    expect(rows.every(r => r.type === 'coaching')).toBe(true);
  });

  it('viewer role never gets model_review rows even when model-efficiency returns flags', async () => {
    cfg.financeModelEfficiencyEnabled = true;
    buildModelEfficiencyMock.mockImplementation(async (surface) => ({
      ...emptyReport(surface),
      activities: surface === 'code' ? [flaggedActivity('claude-opus-4-6-20260101')] : [],
    }));

    const { buildActNext } = await import('@/lib/pulse/act-next');
    const rows = await buildActNext('viewer', NOW_S);
    expect(rows.some(r => r.type === 'model_review')).toBe(false);
  });

  it('admin role with the flag off never gets model_review rows', async () => {
    cfg.financeModelEfficiencyEnabled = false;
    buildModelEfficiencyMock.mockImplementation(async (surface) => ({
      ...emptyReport(surface),
      activities: surface === 'code' ? [flaggedActivity('claude-opus-4-6-20260101')] : [],
    }));

    const { buildActNext } = await import('@/lib/pulse/act-next');
    const rows = await buildActNext('admin', NOW_S);
    expect(rows.some(r => r.type === 'model_review')).toBe(false);
  });

  it('admin role with the flag on gets model_review rows, capped at 3, never a dollar figure', async () => {
    cfg.financeModelEfficiencyEnabled = true;
    buildModelEfficiencyMock.mockImplementation(async (surface) => ({
      ...emptyReport(surface),
      activities: surface === 'code'
        ? [
            // Distinct models: rows are titled by display name, so dated ids of one model collapse.
            flaggedActivity('claude-opus-4-1', { targetModel: 'claude-sonnet-4-6' }),
            flaggedActivity('claude-opus-4-5'),
            flaggedActivity('claude-opus-4-6', { suppressedReason: 'high_friction' }),
          ]
        : [flaggedActivity('claude-opus-4-8'), flaggedActivity('claude-fable-5-1')],
    }));

    const { buildActNext } = await import('@/lib/pulse/act-next');
    const rows = await buildActNext('manager', NOW_S);
    const modelRows = rows.filter(r => r.type === 'model_review');
    expect(modelRows).toHaveLength(3);
    for (const r of modelRows) expect(r.detail).not.toMatch(/\$/);
    // Display names, never raw API ids.
    expect(modelRows.some(r => r.detail === 'Cheaper model available: Claude Sonnet 4.6')).toBe(true);
    for (const r of modelRows) expect(r.title).not.toMatch(/claude-/);
  });

  it('coaching rows always sort above model_review rows, regardless of reach', async () => {
    cfg.financeModelEfficiencyEnabled = true;
    getCoachingCountsByDeptMock.mockResolvedValue([{ dept: 'Finance', count: 1 }]);
    buildModelEfficiencyMock.mockImplementation(async (surface) => ({
      ...emptyReport(surface),
      // A single coaching opportunity (reach 1) still must sort above a
      // model-review row, even though model_review rows carry reach 0.
      activities: surface === 'code' ? [flaggedActivity('claude-opus-4-6-20260101')] : [],
    }));

    const { buildActNext } = await import('@/lib/pulse/act-next');
    const rows = await buildActNext('admin', NOW_S);
    expect(rows.map(r => r.type)).toEqual(['coaching', 'model_review']);
  });

  it('coaching counts produce one row, reach = count, no user names anywhere in the row', async () => {
    const client = await getTypedClient();
    const marker = `AN-Coach-Zorro-${Date.now()}`;
    await client.insert(schema.users).values({
      id: `an-coach-user-${Date.now()}`, email: `${marker}@test.local`, display_name: marker,
    } as never);
    getCoachingCountsByDeptMock.mockResolvedValue([{ dept: 'Finance', count: 2 }]);

    const { buildActNext } = await import('@/lib/pulse/act-next');
    const rows = await buildActNext('admin', NOW_S);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'coaching', reach: 2, href: '/pulse/dept?dept=Finance', title: '2 coaching opportunities in Finance',
    });
    expect(JSON.stringify(rows)).not.toContain(marker);
  });

  it('dedupes coaching rows sharing a title case-insensitively, keeping the higher-reach one', async () => {
    getCoachingCountsByDeptMock.mockResolvedValue([
      { dept: 'Finance', count: 3 },
      { dept: 'FINANCE', count: 3 },
    ]);

    const { buildActNext } = await import('@/lib/pulse/act-next');
    const rows = await buildActNext('admin', NOW_S);
    expect(rows).toHaveLength(1);
    expect(rows[0].reach).toBe(3);
  });

  it('sorts rows by reach desc, and a single type never fills the merged list beyond its per-type cap of 4', async () => {
    getCoachingCountsByDeptMock.mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => ({ dept: `Dept${i}`, count: i + 1 })),
    );

    const { buildActNext } = await import('@/lib/pulse/act-next');
    const rows = await buildActNext('admin', NOW_S);
    expect(rows).toHaveLength(4);
    for (let i = 0; i < rows.length - 1; i++) {
      expect(rows[i].reach).toBeGreaterThanOrEqual(rows[i + 1].reach);
    }
    expect(rows[0].reach).toBe(12);
  });

  it('a failing source contributes nothing rather than throwing', async () => {
    getCoachingCountsByDeptMock.mockRejectedValue(new Error('db down'));

    const { buildActNext } = await import('@/lib/pulse/act-next');
    const rows = await buildActNext('admin', NOW_S);
    expect(rows).toEqual([]);
  });

  it('a failing config read disables coaching rather than throwing', async () => {
    getAllConfigImpl = () => { throw new Error('config down'); };
    getCoachingCountsByDeptMock.mockResolvedValue([{ dept: 'Finance', count: 2 }]);

    const { buildActNext } = await import('@/lib/pulse/act-next');
    const rows = await buildActNext('admin', NOW_S);
    expect(rows).toEqual([]);
  });
});

describe('buildDeptProcessBoxes', () => {
  beforeEach(() => {
    cfg.useCasesEnabled = true;
    cfg.useCasesSuggestUseContent = 'true';
    getAllConfigImpl = () => cfg;
    listOpenDeptBoxesMock.mockReset().mockResolvedValue([]);
  });

  it('flag off: returns []', async () => {
    cfg.useCasesEnabled = false;
    listOpenDeptBoxesMock.mockResolvedValue([
      { key: 'Finance', department: 'Finance', label: 'Finance', count: 1, suggestions: [makeSuggestion({ department: 'Finance' })], groups: [] },
    ]);

    const { buildDeptProcessBoxes } = await import('@/lib/pulse/act-next');
    expect(await buildDeptProcessBoxes()).toEqual([]);
  });

  it('flag on: returns the grouped dept boxes from the store', async () => {
    const boxes: DeptProcessBox[] = [
      { key: 'Finance', department: 'Finance', label: 'Finance', count: 1, suggestions: [makeSuggestion({ department: 'Finance' })], groups: [] },
    ];
    listOpenDeptBoxesMock.mockResolvedValue(boxes);

    const { buildDeptProcessBoxes } = await import('@/lib/pulse/act-next');
    expect(await buildDeptProcessBoxes()).toEqual(boxes);
  });

  it('a failing store call contributes nothing', async () => {
    listOpenDeptBoxesMock.mockRejectedValue(new Error('db down'));

    const { buildDeptProcessBoxes } = await import('@/lib/pulse/act-next');
    expect(await buildDeptProcessBoxes()).toEqual([]);
  });

  it('useCasesSuggestUseContent=false returns [] even with open dept rows and useCasesEnabled on', async () => {
    cfg.useCasesSuggestUseContent = 'false';
    listOpenDeptBoxesMock.mockResolvedValue([
      { key: 'Finance', department: 'Finance', label: 'Finance', count: 1, suggestions: [makeSuggestion({ department: 'Finance' })], groups: [] },
    ]);

    const { buildDeptProcessBoxes } = await import('@/lib/pulse/act-next');
    expect(await buildDeptProcessBoxes()).toEqual([]);
  });
});
