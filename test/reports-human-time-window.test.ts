// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The human time section covers the whole of the report's end date.
import { describe, it, expect, vi } from 'vitest';

const readOrgHumanTime = vi.fn(async () => null);
vi.mock('@/lib/pulse/human-time-summary', () => ({ readOrgHumanTime }));

describe('buildHumanTimeSection', () => {
  it('reads to the midnight after the end date', async () => {
    const { buildHumanTimeSection } = await import('@/lib/reports/human-time-sections');
    await buildHumanTimeSection('2026-10-01', '2026-10-31');
    expect(readOrgHumanTime).toHaveBeenCalledWith(Date.UTC(2026, 9, 1) / 1000, Date.UTC(2026, 10, 1) / 1000);
  });
});
