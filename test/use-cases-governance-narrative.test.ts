// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The governance narrative's at-risk sentence counts quiet completed weeks
// (lib/usecases/governance.ts), not the time since the lifecycle changed,
// which read "quiet for 0 weeks" for a bet that had just turned at risk.
import { describe, it, expect } from 'vitest';
import { trailingQuietWeeks, buildGovernanceNarrative, type GovernanceBet } from '@/lib/usecases/governance';

const bet = (over: Partial<GovernanceBet>): GovernanceBet => ({
  id: 'b1', title: 'Recruiting Screener', ownerDisplayName: null, departments: ['HR'],
  lifecycle: 'at_risk', weeksInLifecycle: 0, quietWeeks: 0,
  measured: { distinctUsers: 2, sessions: 3, hours: null, platformSessions: { claude: 3, openai: null }, platformHours: { claude: null, openai: null }, productSessions: { cowork: 3, code: 0, chatgpt: null, codex: null }, productHours: { cowork: null, code: null, chatgpt: null, codex: null }, sessionsThisWeek: 0 }, estimated: { hoursRecovered: 1 },
  series: [], ...over,
});

describe('trailingQuietWeeks', () => {
  it('counts the run of measured zero weeks up to the last week', () => {
    expect(trailingQuietWeeks([3, 2, 0, 0])).toBe(2);
    expect(trailingQuietWeeks([3, 0, 2, 0])).toBe(1);
    expect(trailingQuietWeeks([3, 2, 1])).toBe(0);
  });
  it('stops at an unmeasured (absent) week, which is not quiet', () => {
    expect(trailingQuietWeeks([0, null, 0, 0])).toBe(2);
    expect(trailingQuietWeeks([null, null])).toBe(0);
  });
});

describe('buildGovernanceNarrative at-risk sentence', () => {
  it('names the quiet completed weeks, whatever the lifecycle age', () => {
    const text = buildGovernanceNarrative([bet({ series: [4, 3, 0, 0], quietWeeks: 2, weeksInLifecycle: 0 })]);
    expect(text).toContain('Recruiting Screener has had no matching activity for 2 completed weeks');
    expect(text).not.toContain('0 weeks');
  });
  it('never claims a quiet length it cannot count', () => {
    const text = buildGovernanceNarrative([bet({ series: [4, null], quietWeeks: 0 })]);
    expect(text).toContain('Recruiting Screener is at risk');
  });
});

describe('buildGovernanceNarrative adoption concentration', () => {
  const adopted = (id: string, departments: string[]) => bet({ id, title: id, lifecycle: 'adopted', departments });

  it('says concentrated when the top two strictly lead the next', () => {
    const text = buildGovernanceNarrative([
      adopted('a', ['HR', 'Finance']), adopted('b', ['HR', 'Finance']), adopted('c', ['Legal']),
    ]);
    expect(text).toContain('Adoption is concentrated in Finance and HR.');
  });

  it('names one department when it alone leads', () => {
    const text = buildGovernanceNarrative([adopted('a', ['HR', 'Legal']), adopted('b', ['HR', 'Finance'])]);
    expect(text).toContain('Adoption is concentrated in HR.');
  });

  it('says it spans the departments on a tie at the cut-off', () => {
    const text = buildGovernanceNarrative([adopted('a', ['HR']), adopted('b', ['Finance']), adopted('c', ['Legal'])]);
    expect(text).toContain('Adoption spans 3 departments.');
    expect(text).not.toContain('concentrated');
  });

  it('says it spans two departments that tie', () => {
    const text = buildGovernanceNarrative([adopted('a', ['HR', 'Finance'])]);
    expect(text).toContain('Adoption spans 2 departments.');
  });
});
