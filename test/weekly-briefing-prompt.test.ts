// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// 12 personal weekly briefings on a production deployment and the demo deployment were
// refused by the number check because the model counted the task-type list it
// was given ("You used seven task types: ..."). The count is now in the data.
import { describe, it, expect } from 'vitest';
import { buildWeeklyBriefingUserMessage, WEEKLY_BRIEFING_SYSTEM } from '@/lib/pulse/briefings/prompts/weekly';
import { tierLines } from '@/lib/pulse/briefings/described-facts';
import { allowedNumbersFrom, numberWordsIn } from '@/lib/anthropic/grounded-json';

const ctx = {
  user_id: 'u1', display_name: 'Ana', period_start_label: '21 Sep', period_end_label: '27 Sep',
  tier_1_count: 3, tier_2_count: 20, tier_3_count: 15,
  tier_lines: tierLines({ t1: 'Routine', t2: 'Substantial', t3: 'Frontier' }, { 1: 3, 2: 20, 3: 15 }),
  produced_line: 'Sessions that produced something (a file saved, sent or published, an artifact, or a file listed on a reply): 6 of the 9 sessions where it could be seen (67%).',
  deep_work: [],
  task_types_used: ['analysis', 'autonomous_workflow', 'basic_drafting', 'connector_assisted', 'connector_orchestration', 'skill_assisted', 'skill_invocation'],
};

describe('weekly briefing prompt', () => {
  it('states how many task types were used, so "seven task types" is grounded', () => {
    const msg = buildWeeklyBriefingUserMessage(ctx as never);
    expect(msg).toContain('Task types used this week: 7 in total: ');
    const allowed = allowedNumbersFrom(msg);
    expect(numberWordsIn('You used seven task types').every(w => allowed.has(w))).toBe(true);
  });

  it('describes the week with the customer\'s own tier names and what was produced, never a score', () => {
    const msg = buildWeeklyBriefingUserMessage(ctx as never);
    expect(msg).toContain('Substantial (whole pieces of work): 20 (53% of tasks)');
    expect(msg).toContain('6 of the 9 sessions where it could be seen (67%)');
    expect(msg).not.toMatch(/Delegation depth|quality index|scale 1\.0/i);
    expect(WEEKLY_BRIEFING_SYSTEM).toMatch(/Never use scores, indexes or ratios/);
    expect(WEEKLY_BRIEFING_SYSTEM).not.toMatch(/governance score"|"delegation depth"/);
  });

  it('says Claude judged the tasks, and that it judges tasks, never the person', () => {
    const msg = buildWeeklyBriefingUserMessage(ctx as never);
    expect(msg).toMatch(/^Tasks Claude judged: \d+$/m);
    expect(msg).not.toContain('Total tasks judged');
    expect(WEEKLY_BRIEFING_SYSTEM).toContain('Claude judges the tasks, never the person');
  });
});
