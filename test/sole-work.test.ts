// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Departments' "Work only one person does" uses Team Coaching's rule: any depth,
// one member only, at least the repeat threshold of prompts, mechanism labels out.
import { describe, it, expect } from 'vitest';
import { soleWorkByPerson } from '@/lib/pulse/sole-work';

const opts = { minPrompts: 8, skip: new Set(['tool_use']), label: (t: string) => t.replace(/_/g, ' ') };

describe('soleWorkByPerson', () => {
  it('names a kind of work only one member does, at any depth, with enough prompts', () => {
    const out = soleWorkByPerson([
      { user_id: 'mei', task_type: 'multi_file_operation', prompts: 10 },
      { user_id: 'mei', task_type: 'analysis', prompts: 5 },
      { user_id: 'felix', task_type: 'analysis', prompts: 9 },
    ], opts);
    expect([...out]).toEqual([['mei', ['multi file operation']]]);
  });

  it('leaves out work done by two people, under the threshold, or a mechanism label', () => {
    const out = soleWorkByPerson([
      { user_id: 'a', task_type: 'research_brief', prompts: 7 },
      { user_id: 'b', task_type: 'tool_use', prompts: 20 },
      { user_id: 'c', task_type: 'summarisation', prompts: 12 },
      { user_id: 'd', task_type: 'summarisation', prompts: 1 },
    ], opts);
    expect(out.size).toBe(0);
  });
});
