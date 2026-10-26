// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Pure tests for the CIO briefing prompt builder's department process
// opportunities section (Department Process Transformation):
// counts render only when supplied; an empty list leaves the prompt without
// any mention of process opportunities (dormant-invisible).
import { describe, it, expect } from 'vitest';
import { buildCioBriefingUserMessage, type CioBriefingContext } from '@/lib/pulse/briefings/prompts/cio';

const base: CioBriefingContext = {
  period_label: 'September 2026',
  weekly_active_users: 12,
  total_classified_events: 340,
  tier_1_pct: 60, tier_2_pct: 30, tier_3_pct: 10,
  avg_dds: 1.4, avg_oti: 1.1,
  confirmed_capability_creation_count: 2,
  concentration_risk_count: 0,
  deep_work: ['People doing Tier 3 work: 3 (7 sessions)', 'New capabilities detected: 2 (analysis 2)'],
  teams_with_ors_below_threshold: [],
  departments_with_ors_count: 0,
  dept_process_opportunities: [],
};

describe('buildCioBriefingUserMessage — dept process opportunities', () => {
  it('renders measured counts per department when supplied', () => {
    const msg = buildCioBriefingUserMessage({
      ...base,
      dept_process_opportunities: [
        { department: 'Finance', count: 5 },
        { department: 'HR', count: 1 },
      ],
    });
    expect(msg).toContain('PROCESS OPPORTUNITIES');
    expect(msg).toContain('Finance: 5 open');
    expect(msg).toContain('HR: 1 open');
    expect(msg).toContain('awaiting human review on the Use Cases register');
  });

  it('omits the section entirely when the list is empty', () => {
    const msg = buildCioBriefingUserMessage(base);
    expect(msg).not.toContain('PROCESS OPPORTUNITIES');
    expect(msg).not.toContain('open');
  });
});

describe('buildCioBriefingUserMessage — resilience', () => {
  it('says no department has a score yet when none was measured, never an all-clear', () => {
    const msg = buildCioBriefingUserMessage({ ...base, departments_with_ors_count: 0 });
    expect(msg).toContain('No department has a resilience score yet.');
    expect(msg).not.toContain('is below 0.7');
  });

  it('says none is below 0.7 only when departments have scores', () => {
    const msg = buildCioBriefingUserMessage({ ...base, departments_with_ors_count: 3 });
    expect(msg).toContain('No department with a resilience score is below 0.7.');
  });

  it('names the departments below 0.7', () => {
    const msg = buildCioBriefingUserMessage({ ...base, departments_with_ors_count: 3, teams_with_ors_below_threshold: ['Finance'] });
    expect(msg).toContain('Departments with a resilience score below 0.7, 1 in total: Finance.');
  });
});
