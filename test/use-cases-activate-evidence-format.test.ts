// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { buildActivateEvidenceLine, tierDepthLabel, humaniseMatchedSignals } from '@/lib/usecases/activate-evidence-format';

describe('buildActivateEvidenceLine', () => {
  it('renders the prompts in the matching sessions and the last-seen date', () => {
    expect(buildActivateEvidenceLine({ matchedMessages: 5, windowDays: 30, lastSeenAt: 1735689600 }))
      .toBe('5 prompts in those sessions over the last 30 days · last seen 01/01/2025');
  });
  it('uses singular "prompt" for a count of 1', () => {
    expect(buildActivateEvidenceLine({ matchedMessages: 1, windowDays: 30, lastSeenAt: null }))
      .toBe('1 prompt in those sessions over the last 30 days');
  });
  it('leaves out a zero count (a session matched by its skill alone can have no readable prompt)', () => {
    expect(buildActivateEvidenceLine({ matchedMessages: 0, windowDays: 30, lastSeenAt: 1735689600 })).toBe('last seen 01/01/2025');
  });
  it('returns null when there is nothing to say', () => {
    expect(buildActivateEvidenceLine({ matchedMessages: 0, windowDays: 30, lastSeenAt: null })).toBeNull();
  });
});

describe('tierDepthLabel', () => {
  it('names each tier in plain English, matching the delegation legend', () => {
    expect(tierDepthLabel(1)).toBe('typical depth: quick questions (tier 1)');
    expect(tierDepthLabel(2)).toBe('typical depth: defined tasks (tier 2)');
    expect(tierDepthLabel(3)).toBe('typical depth: delegated work (tier 3)');
  });

  it('falls back to a bare tier number for an out-of-range tier', () => {
    expect(tierDepthLabel(4)).toBe('typical depth: tier 4');
  });
});

describe('humaniseMatchedSignals', () => {
  it('names the two ways a session matches now', () => {
    expect(humaniseMatchedSignals(['work', 'skill'])).toBe('the work itself (judged by reading the session) and running its own skill');
  });
  it('humanises a single signal with no joiner', () => {
    expect(humaniseMatchedSignals(['task_types'])).toBe('task types');
    expect(humaniseMatchedSignals(['connectors'])).toBe('connectors');
  });

  it('joins two signals with "and"', () => {
    expect(humaniseMatchedSignals(['connectors', 'task_types'])).toBe('connectors and task types');
  });

  it('joins three or more signals with commas and a trailing "and"', () => {
    expect(humaniseMatchedSignals(['keywords', 'skills', 'task_types'])).toBe('keywords, skills and task types');
  });

  it('empty input returns an empty string', () => {
    expect(humaniseMatchedSignals([])).toBe('');
  });

  it('an unrecognised signal name passes through unchanged', () => {
    expect(humaniseMatchedSignals(['mystery_signal'])).toBe('mystery_signal');
  });
});
