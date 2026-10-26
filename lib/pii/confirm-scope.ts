// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Which PII patterns get a Claude confirmation call before their alert fires.
 *
 * The rule is whether a pattern can prove itself without help. Three ways it
 * can, and everything left over is guessing from shape:
 *
 *   - a checksum (`credit_card` Luhn, `cpf` mod-11 — the `validate` hook)
 *   - a fixed distinctive start (`AKIA`, `ghp_`, `sk-`, `eyJ`,
 *     `-----BEGIN … PRIVATE KEY-----`, `postgres://`, a literal `password:`)
 *   - a required label beside it (`DOB`, `passport`, `RG`)
 *
 * `email` is shape-only but its shape is reliable: if it matches, it IS an
 * email address. The open question there is whether it matters, which is a
 * different check and deliberately out of scope.
 *
 * Adding a type here is a one-line change. The drift-lock test in
 * test/pii-confirm-scope.test.ts fails when a new pattern appears in
 * PII_PATTERNS, so the decision cannot be skipped by accident.
 */
export const SHAPE_ONLY_TYPES: ReadonlySet<string> = new Set([
  'nino',
  'uk_phone',
  'us_phone',
  'br_phone',
  'iban',
  'ip_address',
  'us_ssn',
]);

export function needsConfirmation(piiType: string): boolean {
  return SHAPE_ONLY_TYPES.has(piiType);
}
