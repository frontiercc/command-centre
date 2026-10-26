// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// isEmailVerified: the first sign-in gate. Most identity providers send
// email_verified; Microsoft Entra ID sends the optional claim xms_edov instead.
import { describe, it, expect } from 'vitest';
import { isEmailVerified } from '@/lib/auth/oidc';

const ENTRA = 'https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/v2.0';

describe('isEmailVerified', () => {
  it('accepts email_verified: true', () => {
    expect(isEmailVerified({ email_verified: true })).toBe(true);
  });

  it('refuses email_verified: false, even with xms_edov', () => {
    expect(isEmailVerified({ email_verified: false })).toBe(false);
    expect(isEmailVerified({ email_verified: false, xms_edov: true, iss: ENTRA })).toBe(false);
  });

  it('refuses an email_verified that is not the boolean true', () => {
    expect(isEmailVerified({ email_verified: 'true' })).toBe(false);
    expect(isEmailVerified({ email_verified: null, xms_edov: true, iss: ENTRA })).toBe(false);
  });

  it('accepts Entra xms_edov when email_verified is absent', () => {
    for (const v of [true, 'true', 1, '1']) {
      expect(isEmailVerified({ xms_edov: v, iss: ENTRA })).toBe(true);
    }
    expect(isEmailVerified({ xms_edov: true, iss: 'https://sts.windows.net/00000000-0000-0000-0000-000000000000/' })).toBe(true);
  });

  it('ignores xms_edov on a token from any other issuer', () => {
    expect(isEmailVerified({ xms_edov: true })).toBe(false);
    expect(isEmailVerified({ xms_edov: true, iss: 'https://accounts.google.com' })).toBe(false);
    expect(isEmailVerified({ xms_edov: true, iss: 'https://login.microsoftonline.com.attacker.example/' })).toBe(false);
  });

  it('refuses when neither claim vouches for the email', () => {
    expect(isEmailVerified({})).toBe(false);
    for (const v of [false, 'false', 0, '0', 'yes']) {
      expect(isEmailVerified({ xms_edov: v, iss: ENTRA })).toBe(false);
    }
  });
});
