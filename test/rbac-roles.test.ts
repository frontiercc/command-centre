// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import {
  canAccessPulseAdmin,
  isDeptScoped,
  canAccessCorePlatform,
} from '@/lib/auth/admin-auth';

describe('role helpers', () => {
  it('canAccessPulseAdmin — admin and manager only', () => {
    expect(canAccessPulseAdmin('admin')).toBe(true);
    expect(canAccessPulseAdmin('manager')).toBe(true);
    expect(canAccessPulseAdmin('viewer')).toBe(false);
    expect(canAccessPulseAdmin('cowork')).toBe(false);
    expect(canAccessPulseAdmin(undefined)).toBe(false);
  });

  it('isDeptScoped — cowork only', () => {
    expect(isDeptScoped('cowork')).toBe(true);
    expect(isDeptScoped('manager')).toBe(false);
    expect(isDeptScoped('viewer')).toBe(false);
    expect(isDeptScoped('admin')).toBe(false);
    expect(isDeptScoped(undefined)).toBe(false);
  });

  it('canAccessCorePlatform — admin, viewer and manager', () => {
    expect(canAccessCorePlatform('admin')).toBe(true);
    expect(canAccessCorePlatform('viewer')).toBe(true);
    expect(canAccessCorePlatform('manager')).toBe(true);
    expect(canAccessCorePlatform('cowork')).toBe(false);
    expect(canAccessCorePlatform('pulse')).toBe(false);
    expect(canAccessCorePlatform('code')).toBe(false);
    expect(canAccessCorePlatform(undefined)).toBe(false);
  });
});

describe('canAccessAuditLog — prompt text is admin and manager only', () => {
  it('allows admin and manager, refuses viewer and every contributor role', async () => {
    const { canAccessAuditLog } = await import('@/lib/auth/admin-auth');
    expect(canAccessAuditLog('admin')).toBe(true);
    expect(canAccessAuditLog('manager')).toBe(true);
    for (const role of ['viewer', 'pulse', 'cowork', 'code'] as const) {
      expect(canAccessAuditLog(role)).toBe(false);
    }
    expect(canAccessAuditLog(undefined)).toBe(false);
  });
});
