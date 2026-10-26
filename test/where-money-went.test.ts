// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Where the money went: the split rules, no database.
import { describe, it, expect } from 'vitest';
import { SpendSplitAcc, hasBreakdown } from '@/lib/finance/where-money-went';

describe('SpendSplitAcc', () => {
  it('splits main conversation, subagents and unrecorded calls', () => {
    const a = new SpendSplitAcc();
    a.add({ model: 'opus', subagent: null, skill: null, sourceRecorded: true, usd: 1, calls: 2 });
    a.add({ model: 'opus', subagent: 'general-purpose', skill: 'xlsx', sourceRecorded: true, usd: 3, calls: 5 });
    a.add({ model: 'sonnet', subagent: 'explore', skill: null, sourceRecorded: false, usd: 0.5, calls: 1 });
    a.add({ model: 'haiku', subagent: null, skill: null, sourceRecorded: false, usd: 0.25, calls: 1 });
    const s = a.result();
    expect(s.totalUsd).toBeCloseTo(4.75, 9);
    expect(s.mainUsd).toBeCloseTo(1, 9);
    // A subagent name is enough on its own to place a call.
    expect(s.subagentUsd).toBeCloseTo(3.5, 9);
    expect(s.notRecordedUsd).toBeCloseTo(0.25, 9);
    expect(s.mainUsd + s.subagentUsd + s.notRecordedUsd).toBeCloseTo(s.totalUsd!, 9);
    expect(s.calls).toBe(9);
    expect(s.bySubagent.map(x => [x.name, x.usd, x.calls])).toEqual([['general-purpose', 3, 5], ['explore', 0.5, 1]]);
    expect(s.bySkill).toEqual([{ name: 'xlsx', usd: 3, calls: 5 }]);
    expect(s.byModel[0]).toEqual({ name: 'opus', usd: 4, calls: 7 });
  });

  it('never counts an unpriced call as $0', () => {
    const a = new SpendSplitAcc();
    a.add({ model: 'mystery', subagent: 'reviewer', skill: null, sourceRecorded: true, usd: null, calls: 3 });
    const s = a.result();
    expect(s.totalUsd).toBeNull();
    expect(s.subagentUsd).toBe(0);
    expect(s.unpricedModels).toEqual(['mystery']);
    expect(s.bySubagent).toEqual([{ name: 'reviewer', usd: 0, calls: 3 }]);
  });

  it('merges', () => {
    const a = new SpendSplitAcc();
    a.add({ model: 'opus', subagent: 'explore', skill: null, sourceRecorded: true, usd: 1, calls: 1 });
    const b = new SpendSplitAcc();
    b.add({ model: 'opus', subagent: 'explore', skill: 'pdf', sourceRecorded: true, usd: 2, calls: 1 });
    a.merge(b);
    const s = a.result();
    expect(s.subagentUsd).toBeCloseTo(3, 9);
    expect(s.bySubagent).toEqual([{ name: 'explore', usd: 3, calls: 2 }]);
    expect(s.bySkill).toEqual([{ name: 'pdf', usd: 2, calls: 1 }]);
  });

  it('hasBreakdown is false for main-conversation-only spend', () => {
    const a = new SpendSplitAcc();
    a.add({ model: 'opus', subagent: null, skill: null, sourceRecorded: true, usd: 1, calls: 1 });
    expect(hasBreakdown(a.result())).toBe(false);
    expect(hasBreakdown(null)).toBe(false);
  });
});
