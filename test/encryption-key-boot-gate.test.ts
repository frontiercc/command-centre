// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Boot gate: production must refuse a missing or known-default CCC_ENCRYPTION_KEY.
import { describe, it, expect } from 'vitest';
import { checkEncryptionKey } from '../instrumentation';

describe('checkEncryptionKey (boot gate)', () => {
  it('production: rejects a missing key', () => {
    expect(checkEncryptionKey(undefined, 'production').ok).toBe(false);
    expect(checkEncryptionKey('', 'production').ok).toBe(false);
  });

  it('production: rejects known default/placeholder keys', () => {
    for (const k of [
      'dev-fallback-key-not-for-production',
      'change-me',
    ]) {
      expect(checkEncryptionKey(k, 'production').ok).toBe(false);
    }
  });

  it('production: accepts a real custom key', () => {
    expect(checkEncryptionKey('S0me-l0ng-random-secret-48-bytes-worth-xyz', 'production').ok).toBe(true);
  });

  it('non-production: tolerates missing/default (dev fallback)', () => {
    expect(checkEncryptionKey(undefined, 'development').ok).toBe(true);
    expect(checkEncryptionKey('change-me', 'test').ok).toBe(true);
  });
});

describe('checkCookiePolicy (boot gate)', () => {
  it('production with insecure cookies alone refuses to start', async () => {
    const { checkCookiePolicy } = await import('../instrumentation');
    expect(checkCookiePolicy('true', undefined, 'production').ok).toBe(false);
    expect(checkCookiePolicy('true', 'false', 'production').ok).toBe(false);
  });
  it('production with both flags starts, with a loud warning', async () => {
    const { checkCookiePolicy } = await import('../instrumentation');
    const r = checkCookiePolicy('true', 'true', 'production');
    expect(r.ok).toBe(true);
    expect(r.warning).toMatch(/NOT Secure/);
  });
  it('secure cookies, or non-production, are always fine', async () => {
    const { checkCookiePolicy } = await import('../instrumentation');
    for (const v of [undefined, '', 'false', 'TRUE']) expect(checkCookiePolicy(v, undefined, 'production')).toEqual({ ok: true });
    expect(checkCookiePolicy('true', undefined, 'development')).toEqual({ ok: true });
  });
});
