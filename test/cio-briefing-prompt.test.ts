// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Pure tests for the CIO briefing prompt builder's department process
// opportunities section (Department Process Transformation):
// counts render only when supplied; an empty list leaves the prompt without
// any mention of process opportunities (dormant-invisible).
import { describe, it, expect } from 'vitest';
import { buildCioBriefingUserMessage, CIO_BRIEFING_SYSTEM, type CioBriefingContext } from '@/lib/pulse/briefings/prompts/cio';
import { tierLines } from '@/lib/pulse/briefings/described-facts';

const base: CioBriefingContext = {
  period_label: 'September 2026',
  weekly_active_users: 12,
  total_classified_events: 340,
  tier_lines: tierLines(null, { 1: 204, 2: 102, 3: 34 }),
  produced_line: 'Sessions that produced something (a file saved, sent or published, an artifact, or a file listed on a reply): 40 of the 160 sessions where it could be seen (25%).',
  confirmed_capability_creation_count: 2,
  concentration_risk_count: 0,
  deep_work: ['People doing Tier 3 work: 3 (7 sessions)', 'New capabilities detected: 2 (analysis 2)'],
  floor_line: 'Departments below the floor of 33% meaningful or frontier work, 1 of 6: Finance (21%).',
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

describe('buildCioBriefingUserMessage — describes, never scores', () => {
  it('gives the tiers by name with their shares, what was produced and the departments below the floor', () => {
    const msg = buildCioBriefingUserMessage(base);
    expect(msg).toContain('Administrative (quick, single tasks): 204 (60% of tasks)');
    expect(msg).toContain('Frontier (the deepest work): 34 (10% of tasks)');
    expect(msg).toContain('40 of the 160 sessions where it could be seen (25%)');
    expect(msg).toContain('Departments below the floor of 33% meaningful or frontier work, 1 of 6: Finance (21%).');
  });

  it('carries no score, index or ratio, and tells the model never to use one', () => {
    const msg = buildCioBriefingUserMessage(base);
    expect(msg).not.toMatch(/Delegation Depth|Throughput|resilience score|0\.7|\dx\b/i);
    expect(CIO_BRIEFING_SYSTEM).toMatch(/Never use scores, indexes or ratios/);
  });
});
