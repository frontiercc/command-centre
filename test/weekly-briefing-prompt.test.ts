// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// 12 personal weekly briefings on a production deployment and the demo deployment were
// refused by the number check because the model counted the task-type list it
// was given ("You used seven task types: ..."). The count is now in the data.
import { describe, it, expect } from 'vitest';
import { buildWeeklyBriefingUserMessage } from '@/lib/pulse/briefings/prompts/weekly';
import { allowedNumbersFrom, numberWordsIn } from '@/lib/anthropic/grounded-json';

const ctx = {
  user_id: 'u1', display_name: 'Ana', period_start_label: '21 Sep', period_end_label: '27 Sep',
  tier_1_count: 3, tier_2_count: 20, tier_3_count: 15, dds: 2.2, oti: null, deep_work: [],
  task_types_used: ['analysis', 'autonomous_workflow', 'basic_drafting', 'connector_assisted', 'connector_orchestration', 'skill_assisted', 'skill_invocation'],
};

describe('weekly briefing prompt', () => {
  it('states how many task types were used, so "seven task types" is grounded', () => {
    const msg = buildWeeklyBriefingUserMessage(ctx as never);
    expect(msg).toContain('Task types used this week: 7 in total: ');
    const allowed = allowedNumbersFrom(msg);
    expect(numberWordsIn('You used seven task types').every(w => allowed.has(w))).toBe(true);
  });
});
