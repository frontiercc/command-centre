// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { severityForPiiType } from '../lib/alerts/pii-alerts';
import { PII_PATTERNS } from '../lib/pii/detect';

describe('severityForPiiType — Brazilian types', () => {
  it('cpf is HIGH — the direct nino/us_ssn analogue (spec §4.4: unlisted would fall through to low)', () => {
    expect(severityForPiiType('cpf')).toBe('high');
  });
  it('rg is MEDIUM', () => {
    expect(severityForPiiType('rg')).toBe('medium');
  });
  it('br_phone is LOW, consistent with uk_phone/us_phone', () => {
    expect(severityForPiiType('br_phone')).toBe('low');
    expect(severityForPiiType('uk_phone')).toBe('low');
  });
  it('existing high types are unchanged', () => {
    expect(severityForPiiType('nino')).toBe('high');
    expect(severityForPiiType('us_ssn')).toBe('high');
  });
});

describe('TITLES coverage — no raw type name may surface as an alert headline', () => {
  it('every PII pattern type has a TITLES entry', async () => {
    // Import the map via the module under test. TITLES is exported for this check.
    const mod = await import('../lib/alerts/pii-alerts');
    for (const { name } of PII_PATTERNS) {
      expect(mod.TITLES[name], `missing TITLES entry for '${name}'`).toBeTruthy();
    }
  });
});
