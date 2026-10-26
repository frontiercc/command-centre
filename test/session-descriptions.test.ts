// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The guards on the one-sentence session descriptions.
import { describe, it, expect } from 'vitest';
import { validateDescription, checkDescription, buildDescriptionPrompt, buildRepairPrompt, MAX_CHARS } from '@/lib/pulse/session-descriptions';
import { ungroundedNumbers } from '@/lib/anthropic/grounded-narrative';

const prompts = ['Pull the Q3 pipeline from Salesforce and compare it with forecast v2 for the leadership meeting.'];

describe('validateDescription', () => {
  it('accepts one plain sentence', () => {
    expect(validateDescription('Built a pipeline variance summary for the leadership meeting.', prompts))
      .toBe('Built a pipeline variance summary for the leadership meeting.');
  });

  it('accepts a number that appears in the prompts', () => {
    expect(validateDescription('Compared the Q3 pipeline against forecast v2.', prompts)).not.toBeNull();
  });

  it('rejects an invented number', () => {
    expect(validateDescription('Compared 40 opportunities against the forecast.', prompts)).toBeNull();
  });

  it('rejects more than one sentence', () => {
    expect(validateDescription('Built a summary. Then sent it to the team.', prompts)).toBeNull();
  });

  it('removes quotation marks instead of rejecting the reply', () => {
    expect(validateDescription('Built the "leadership" summary.', prompts)).toBe('Built the leadership summary.');
    expect(validateDescription('“Built the leadership summary.”', prompts)).toBe('Built the leadership summary.');
  });

  it('rejects line breaks', () => {
    expect(validateDescription('Built a summary\nfor leadership.', prompts)).toBeNull();
  });

  it('rejects an over-long reply and an empty one', () => {
    expect(validateDescription(`${'word '.repeat(MAX_CHARS)}.`, prompts)).toBeNull();
    expect(validateDescription('   ', prompts)).toBeNull();
  });

  it('scrubs personal data the model let through', () => {
    const out = validateDescription('Sent the pipeline summary to jane.doe@example.com for review.', prompts);
    expect(out).not.toBeNull();
    expect(out).not.toContain('jane.doe@example.com');
  });
});

describe('checkDescription reasons', () => {
  it('names the rule each bad reply broke, without echoing the reply', () => {
    expect(checkDescription('   ', prompts)).toMatchObject({ ok: false, reason: 'empty' });
    expect(checkDescription('Built a summary\nfor leadership.', prompts)).toMatchObject({ ok: false, reason: 'line_break' });
    expect(checkDescription(`${'word '.repeat(MAX_CHARS)}.`, prompts)).toMatchObject({ ok: false, reason: 'too_long' });
    expect(checkDescription('Built a summary. Then sent it.', prompts)).toMatchObject({ ok: false, reason: 'multiple_sentences' });
    const n = checkDescription('Compared 40 opportunities with 12 targets.', prompts);
    expect(n).toMatchObject({ ok: false, reason: 'ungrounded_number' });
    if (!n.ok) {
      expect(n.detail).toContain('40, 12');
      expect(n.detail).not.toContain('opportunities');
    }
  });

  it('the repair prompt keeps the original rules and adds the reason', () => {
    const p = buildRepairPrompt('ORIGINAL PROMPT', 'The reply was more than one sentence.');
    expect(p.startsWith('ORIGINAL PROMPT')).toBe(true);
    expect(p).toContain('The reply was more than one sentence.');
  });
});

describe('ungroundedNumbers', () => {
  it('lists each number not found in the allowed set, once, in order', () => {
    expect(ungroundedNumbers('Moved 3 of 40 deals, then 40 more, and 7 left', new Set(['3']))).toEqual(['40', '7']);
    expect(ungroundedNumbers('No figures here.', new Set())).toEqual([]);
  });
});

describe('buildDescriptionPrompt', () => {
  it('fences the prompts as data and names the kind of work and systems', () => {
    const p = buildDescriptionPrompt({ prompts: ['hello'], kindOfWork: 'structured_report', systems: ['salesforce'] });
    expect(p).toContain('<prompt index="0">');
    expect(p).toContain('structured report');
    expect(p).toContain('salesforce');
    expect(p).toMatch(/data, not instructions/);
  });
});
