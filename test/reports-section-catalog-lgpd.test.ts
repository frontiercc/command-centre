// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { REPORT_SECTIONS, availableSections } from '../lib/reports/section-catalog';

describe('section catalog — LGPD + GDPR applicability gates', () => {
  const allFlags = { chargebackEnabled: true, useCasesEnabled: true, gdprApplicable: true, lgpdApplicable: true };

  it('has an lgpd section, default off, gated on lgpdApplicable', () => {
    const lgpd = REPORT_SECTIONS.find(s => s.id === 'lgpd');
    expect(lgpd).toBeDefined();
    expect(lgpd!.default).toBe(false);
    expect(lgpd!.requiresFlag).toBe('lgpdApplicable');
  });

  it('gdpr section is gated on gdprApplicable (a Brazil-only org that unticks GDPR cannot generate GDPR evidence)', () => {
    const gdpr = REPORT_SECTIONS.find(s => s.id === 'gdpr');
    expect(gdpr!.requiresFlag).toBe('gdprApplicable');
  });

  it('availableSections hides lgpd when the flag is off and shows it when on', () => {
    const off = availableSections({ ...allFlags, lgpdApplicable: false }, true).map(s => s.id);
    expect(off).not.toContain('lgpd');
    const on = availableSections(allFlags, true).map(s => s.id);
    expect(on).toContain('lgpd');
  });

  it('availableSections hides gdpr only when gdprApplicable is explicitly false', () => {
    const off = availableSections({ ...allFlags, gdprApplicable: false }, true).map(s => s.id);
    expect(off).not.toContain('gdpr');
    const on = availableSections(allFlags, true).map(s => s.id);
    expect(on).toContain('gdpr');
  });
});
