// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The Audit Log's severity badge had no test. That is how an earlier change silently
// downgraded a confirmed National Insurance number to "low" in the compliance
// record: appending "(confirmed)" to the type name broke the lookup, every
// checked type fell through to low, and nothing failed. It surfaced only
// because someone asked how alerts render.
import { describe, it, expect } from 'vitest';
import {
  flagSeverity,
  isFullyDismissed,
  HIGH_SEVERITY_TYPES,
  MEDIUM_SEVERITY_TYPES,
} from '../lib/pii/flag-severity';
import { severityForPiiType } from '../lib/alerts/pii-alerts';
import { PII_PATTERNS } from '../lib/pii/detect';

describe('flagSeverity', () => {
  it('reads a bare type, as written before the confirmation check existed', () => {
    expect(flagSeverity('PII detected: nino')).toBe('high');
    expect(flagSeverity('PII detected: iban')).toBe('medium');
    expect(flagSeverity('PII detected: email')).toBe('low');
  });

  // The regression. Each of these was 'low' until the fix.
  it('reads a type carrying a confirmation verdict', () => {
    expect(flagSeverity('PII detected: nino (confirmed)')).toBe('high');
    expect(flagSeverity('PII detected: us_ssn (confirmed)')).toBe('high');
    expect(flagSeverity('PII detected: iban (confirmed)')).toBe('medium');
    expect(flagSeverity('PII detected: uk_phone (confirmed)')).toBe('low');
  });

  it('reads a type carrying a dismissal verdict at its real severity', () => {
    // The pattern is no less serious because this instance was not genuine —
    // the row is de-emphasised visually (isFullyDismissed), not downgraded.
    expect(flagSeverity('PII detected: nino (dismissed)')).toBe('high');
  });

  it('takes the highest severity across several types', () => {
    expect(flagSeverity('PII detected: email, nino (confirmed)')).toBe('high');
    expect(flagSeverity('PII detected: uk_phone (dismissed), iban (confirmed)')).toBe('medium');
  });

  it('takes the higher of PII and intent', () => {
    expect(flagSeverity('PII detected: email | Intent detected: data_exfiltration (critical)')).toBe('critical');
    expect(flagSeverity('PII detected: nino (confirmed) | Intent detected: x (low)')).toBe('high');
  });

  it('reads an intent-only reason', () => {
    expect(flagSeverity('Intent detected: credential_harvesting (high)')).toBe('high');
  });

  it('is low for no reason at all, and medium for one it cannot parse', () => {
    expect(flagSeverity(null)).toBe('low');
    expect(flagSeverity('')).toBe('low');
    // Unknown shape must not read as low — an unrecognised flag is not a safe flag.
    expect(flagSeverity('Something else entirely')).toBe('medium');
  });
});

describe('isFullyDismissed', () => {
  it('is true only when every type was dismissed and no intent is present', () => {
    expect(isFullyDismissed('PII detected: nino (dismissed)')).toBe(true);
    expect(isFullyDismissed('PII detected: nino (dismissed), iban (dismissed)')).toBe(true);
  });

  it('is false when anything was confirmed, unchecked, or intent-flagged', () => {
    expect(isFullyDismissed('PII detected: nino (confirmed)')).toBe(false);
    expect(isFullyDismissed('PII detected: nino (dismissed), iban (confirmed)')).toBe(false);
    expect(isFullyDismissed('PII detected: credit_card')).toBe(false);
    expect(isFullyDismissed('PII detected: nino (dismissed) | Intent detected: x (high)')).toBe(false);
    expect(isFullyDismissed(null)).toBe(false);
    expect(isFullyDismissed('Intent detected: x (high)')).toBe(false);
  });
});

// The audit page is a client component and cannot import lib/alerts/pii-alerts
// (it opens a database client), so its severity sets are unavoidably a second
// copy. They drifted once already — cpf and rg were missing, so Brazilian
// identifiers badged low in the Audit Log while alerting correctly. This is
// the lock that stops that happening again silently.
describe('the audit page severity sets match the alert generator', () => {
  it('agrees with severityForPiiType for every pattern in the detector', () => {
    const mismatches: string[] = [];
    for (const { name } of PII_PATTERNS) {
      const authoritative = severityForPiiType(name);
      const audit = HIGH_SEVERITY_TYPES.has(name)
        ? 'high'
        : MEDIUM_SEVERITY_TYPES.has(name)
          ? 'medium'
          : 'low';
      if (authoritative !== audit) mismatches.push(`${name}: alerts=${authoritative} audit=${audit}`);
    }
    expect(mismatches).toEqual([]);
  });

  it('names no type the detector does not have', () => {
    const known = new Set(PII_PATTERNS.map(p => p.name));
    for (const t of [...HIGH_SEVERITY_TYPES, ...MEDIUM_SEVERITY_TYPES]) {
      expect(known.has(t)).toBe(true);
    }
  });
});
