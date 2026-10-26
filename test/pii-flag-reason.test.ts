// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { applyPiiVerdicts } from '../lib/pii/flag-reason';
import type { PiiVerdict } from '../lib/pii/confirm';

const v = (o: Record<string, PiiVerdict>) => new Map(Object.entries(o));

describe('applyPiiVerdicts', () => {
  it('annotates a single type', () => {
    expect(applyPiiVerdicts('PII detected: nino', v({ nino: 'dismissed' })))
      .toBe('PII detected: nino (dismissed)');
  });

  it('annotates each type independently', () => {
    expect(applyPiiVerdicts(
      'PII detected: nino, credit_card, iban',
      v({ nino: 'dismissed', iban: 'confirmed' }),
    )).toBe('PII detected: nino (dismissed), credit_card, iban (confirmed)');
  });

  it('leaves an unchecked type untouched', () => {
    expect(applyPiiVerdicts('PII detected: credit_card', v({})))
      .toBe('PII detected: credit_card');
  });

  // The race. Intent may land first or second; both orders must end the same.
  it('preserves an intent segment that landed first', () => {
    expect(applyPiiVerdicts(
      'PII detected: nino | Intent detected: data_exfiltration (high)',
      v({ nino: 'dismissed' }),
    )).toBe('PII detected: nino (dismissed) | Intent detected: data_exfiltration (high)');
  });

  it('is a no-op when there is no PII segment to annotate', () => {
    expect(applyPiiVerdicts('Intent detected: data_exfiltration (high)', v({ nino: 'dismissed' })))
      .toBe('Intent detected: data_exfiltration (high)');
  });

  it('handles null and empty input', () => {
    expect(applyPiiVerdicts(null, v({ nino: 'dismissed' }))).toBeNull();
    expect(applyPiiVerdicts('', v({ nino: 'dismissed' }))).toBe('');
  });

  it('is idempotent — re-applying does not double-annotate', () => {
    const once = applyPiiVerdicts('PII detected: nino', v({ nino: 'dismissed' }));
    expect(applyPiiVerdicts(once, v({ nino: 'dismissed' }))).toBe(once);
  });

  it('does not touch a segment that merely contains the prefix text', () => {
    expect(applyPiiVerdicts(
      'Intent detected: x (low) | note: PII detected: nino',
      v({ nino: 'dismissed' }),
    )).toBe('Intent detected: x (low) | note: PII detected: nino');
  });
});
