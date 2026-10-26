// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { SHAPE_ONLY_TYPES, needsConfirmation } from '../lib/pii/confirm-scope';
import { PII_PATTERNS } from '../lib/pii/detect';

describe('SHAPE_ONLY_TYPES', () => {
  it('is exactly the seven shape-only patterns', () => {
    expect([...SHAPE_ONLY_TYPES].sort()).toEqual(
      ['br_phone', 'iban', 'ip_address', 'nino', 'uk_phone', 'us_phone', 'us_ssn'],
    );
  });

  it('names only patterns that actually exist', () => {
    const known = new Set(PII_PATTERNS.map(p => p.name));
    for (const t of SHAPE_ONLY_TYPES) expect(known.has(t)).toBe(true);
  });

  // Drift lock: a new pattern must be a deliberate decision, not a default.
  it('accounts for every pattern in the detector', () => {
    expect(PII_PATTERNS.length).toBe(20);
  });

  it('never includes a pattern that validates itself with a checksum', () => {
    const validated = PII_PATTERNS.filter(p => p.validate).map(p => p.name);
    expect(validated.sort()).toEqual(['cpf', 'credit_card']);
    for (const name of validated) expect(SHAPE_ONLY_TYPES.has(name)).toBe(false);
  });
});

describe('needsConfirmation', () => {
  it('is true for a shape-only type', () => {
    expect(needsConfirmation('nino')).toBe(true);
    expect(needsConfirmation('ip_address')).toBe(true);
  });
  it('is false for a self-proving type', () => {
    expect(needsConfirmation('credit_card')).toBe(false);
    expect(needsConfirmation('aws_key')).toBe(false);
    expect(needsConfirmation('email')).toBe(false);
  });
  it('is false for an unknown type', () => {
    expect(needsConfirmation('not_a_real_type')).toBe(false);
  });
});
