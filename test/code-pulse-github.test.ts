// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { bucketByUtcDate, isValidGithubRepo } from '@/lib/pulse/code/github-sync';

describe('bucketByUtcDate', () => {
  it('buckets timestamps into UTC days', () => {
    const buckets = bucketByUtcDate([
      '2026-06-10T23:59:00Z',
      '2026-06-11T00:01:00Z',
      '2026-06-11T14:30:00Z',
      '2026-06-11T18:00:00+02:00', // 16:00 UTC → same day
    ]);
    expect(buckets.get('2026-06-10')).toBe(1);
    expect(buckets.get('2026-06-11')).toBe(3);
  });

  it('ignores invalid timestamps', () => {
    const buckets = bucketByUtcDate(['not-a-date', '2026-06-11T10:00:00Z']);
    expect([...buckets.keys()]).toEqual(['2026-06-11']);
  });

  it('handles empty input', () => {
    expect(bucketByUtcDate([]).size).toBe(0);
  });
});

describe('isValidGithubRepo', () => {
  it('accepts owner/repo forms', () => {
    expect(isValidGithubRepo('example-org/example-repo')).toBe(true);
    expect(isValidGithubRepo('my-org/my.repo-name')).toBe(true);
  });

  it('rejects malformed values', () => {
    expect(isValidGithubRepo('justaname')).toBe(false);
    expect(isValidGithubRepo('a/b/c')).toBe(false);
    expect(isValidGithubRepo('https://github.com/a/b')).toBe(false);
    expect(isValidGithubRepo('')).toBe(false);
  });
});
