// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { SEVERITY_RANK, severityAtLeast } from '@/lib/alerts/severity';

describe('SEVERITY_RANK', () => {
  it('orders critical > high > medium > low', () => {
    expect(SEVERITY_RANK.critical).toBeGreaterThan(SEVERITY_RANK.high);
    expect(SEVERITY_RANK.high).toBeGreaterThan(SEVERITY_RANK.medium);
    expect(SEVERITY_RANK.medium).toBeGreaterThan(SEVERITY_RANK.low);
  });
});

describe('severityAtLeast', () => {
  it('true when severity meets or exceeds the floor', () => {
    expect(severityAtLeast('critical', 'high')).toBe(true);
    expect(severityAtLeast('high', 'high')).toBe(true);
  });

  it('false when severity is below the floor', () => {
    expect(severityAtLeast('medium', 'high')).toBe(false);
    expect(severityAtLeast('low', 'high')).toBe(false);
  });

  it('an unknown severity is treated as below any floor', () => {
    expect(severityAtLeast('made_up', 'low')).toBe(false);
  });
});
