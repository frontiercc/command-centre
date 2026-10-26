// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import {
  isCorePlatformRole,
  canSeeFinOps,
  canSeeCoworkOverview,
  canSeeCodeOverview,
  canSeeUseCasesOverview,
  visibleMobileNavItems,
} from '@/lib/nav/items';

const allOn = { useCasesEnabled: true, chargebackEnabled: true };
const allOff = { useCasesEnabled: false, chargebackEnabled: false };

describe('nav item predicates', () => {
  it('core platform is admin|viewer|manager only', () => {
    expect(isCorePlatformRole('admin')).toBe(true);
    expect(isCorePlatformRole('viewer')).toBe(true);
    expect(isCorePlatformRole('manager')).toBe(true);
    expect(isCorePlatformRole('pulse')).toBe(false);
    expect(isCorePlatformRole('code')).toBe(false);
    expect(isCorePlatformRole('cowork')).toBe(false);
    expect(isCorePlatformRole('')).toBe(false);
  });

  it('FinOps needs the flag AND admin|manager', () => {
    expect(canSeeFinOps('admin', true)).toBe(true);
    expect(canSeeFinOps('manager', true)).toBe(true);
    expect(canSeeFinOps('viewer', true)).toBe(false);
    expect(canSeeFinOps('admin', false)).toBe(false);
  });

  it('Pulse overviews are admin|manager|viewer', () => {
    for (const role of ['admin', 'manager', 'viewer']) {
      expect(canSeeCoworkOverview(role)).toBe(true);
      expect(canSeeCodeOverview(role)).toBe(true);
    }
    for (const role of ['pulse', 'code', 'cowork', '']) {
      expect(canSeeCoworkOverview(role)).toBe(false);
      expect(canSeeCodeOverview(role)).toBe(false);
    }
  });

  it('Use Cases overview needs the flag AND admin|manager', () => {
    expect(canSeeUseCasesOverview('admin', true)).toBe(true);
    expect(canSeeUseCasesOverview('manager', true)).toBe(true);
    expect(canSeeUseCasesOverview('viewer', true)).toBe(false);
    expect(canSeeUseCasesOverview('admin', false)).toBe(false);
  });
});

describe('visibleMobileNavItems', () => {
  it('admin with all flags sees all six, in tab order', () => {
    expect(visibleMobileNavItems('admin', allOn).map(i => i.href)).toEqual([
      '/', '/alerts', '/finops', '/pulse/cio', '/pulse/code', '/use-cases',
    ]);
  });

  it('viewer never sees FinOps or Use Cases even with flags on', () => {
    expect(visibleMobileNavItems('viewer', allOn).map(i => i.href)).toEqual([
      '/', '/alerts', '/pulse/cio', '/pulse/code',
    ]);
  });

  it('flags off hide FinOps and Use Cases for admin', () => {
    expect(visibleMobileNavItems('admin', allOff).map(i => i.href)).toEqual([
      '/', '/alerts', '/pulse/cio', '/pulse/code',
    ]);
  });

  it('contributor roles and unknown roles see nothing', () => {
    for (const role of ['pulse', 'code', 'cowork', '', 'bogus']) {
      expect(visibleMobileNavItems(role, allOn)).toEqual([]);
    }
  });

  it('every item carries a label and icon', () => {
    for (const item of visibleMobileNavItems('admin', allOn)) {
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.icon.length).toBeGreaterThan(0);
    }
  });
});
