// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { canAccessPulseAdmin } from '@/lib/auth/admin-auth';

describe('pulse_start_at — role guards', () => {
  it('canAccessPulseAdmin allows admin and manager to set start date', () => {
    expect(canAccessPulseAdmin('admin')).toBe(true);
    expect(canAccessPulseAdmin('manager')).toBe(true);
    expect(canAccessPulseAdmin('viewer')).toBe(false);
    expect(canAccessPulseAdmin('cowork')).toBe(false);
  });

  it('epoch conversion: ISO date to midnight UTC epoch', () => {
    const isoDate = '2026-05-01';
    const epoch = Math.floor(new Date(`${isoDate}T00:00:00Z`).getTime() / 1000);
    expect(epoch).toBe(1777593600);
  });

  it('epoch conversion: null passes through as null', () => {
    const input: string | null = null;
    const epoch = input ? Math.floor(new Date(`${input}T00:00:00Z`).getTime() / 1000) : null;
    expect(epoch).toBeNull();
  });
});
