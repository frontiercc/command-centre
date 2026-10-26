// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// test/banner-state.test.ts
import { describe, it, expect } from 'vitest';
import { shouldShowBanner } from '@/lib/health/banner-state';

describe('shouldShowBanner', () => {
  it('shows when the health fetch succeeds and status is degraded', () => {
    expect(shouldShowBanner({ fetchOk: true, status: 'degraded' })).toBe(true);
  });
  it('hides when status is ok', () => {
    expect(shouldShowBanner({ fetchOk: true, status: 'ok' })).toBe(false);
  });
  it('hides when the fetch itself failed (client offline, not a DB outage)', () => {
    expect(shouldShowBanner({ fetchOk: false, status: 'degraded' })).toBe(false);
    expect(shouldShowBanner({ fetchOk: false })).toBe(false);
  });
  it('hides on an unknown status', () => {
    expect(shouldShowBanner({ fetchOk: true, status: undefined })).toBe(false);
  });
});
