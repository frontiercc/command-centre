// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// MFA recovery codes (security review): the stored hash must equal
// the hash sign-in computes for the code the person types. Before the fix,
// generateRecoveryCodes hashed "ABCDE-FGHJK" with its hyphen while sign-in
// (app/api/admin/mfa/verify) hashes it without, so no code ever matched.
import { describe, it, expect } from 'vitest';
import { generateRecoveryCodes, hashRecoveryCode } from '@/lib/auth/totp';

describe('recovery codes', () => {
  it('stores the same hash sign-in computes for the code as shown', () => {
    const { raw, hashed } = generateRecoveryCodes(10);
    expect(raw).toHaveLength(10);
    raw.forEach((code, i) => expect(hashRecoveryCode(code)).toBe(hashed[i]));
  });

  it('matches however the person types it: lower case, spaces, no hyphen', () => {
    const { raw, hashed } = generateRecoveryCodes(1);
    const [code] = raw;
    for (const typed of [code.toLowerCase(), code.replace('-', ''), ` ${code.replace('-', ' ')} `]) {
      expect(hashRecoveryCode(typed)).toBe(hashed[0]);
    }
  });
});
