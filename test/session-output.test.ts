// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { OUTPUT_TOOLS, outputRate } from '@/lib/pulse/cowork/session-output';

describe('OUTPUT_TOOLS', () => {
  it('is the conservative set — Edit is deliberately excluded', () => {
    expect([...OUTPUT_TOOLS].sort()).toEqual(['Artifact', 'SendUserFile', 'Write']);
    expect(OUTPUT_TOOLS.has('Edit')).toBe(false);
  });

  it('excludes read and search tools', () => {
    for (const t of ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Bash', 'TaskCreate']) {
      expect(OUTPUT_TOOLS.has(t)).toBe(false);
    }
  });
});

describe('outputRate', () => {
  it('returns the share as a 0-1 fraction', () => {
    expect(outputRate(228, 592)).toBeCloseTo(0.3851, 4);
  });

  it('returns null — never 0 — when there are no sessions to divide by', () => {
    expect(outputRate(0, 0)).toBeNull();
  });

  it('returns 0 when there were sessions but none produced anything', () => {
    expect(outputRate(0, 10)).toBe(0);
  });

  it('returns 1 when every session produced something', () => {
    expect(outputRate(10, 10)).toBe(1);
  });
});
