// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { safeReturnPath, getSafeRedirect, isAuthPage, DEFAULT_AFTER_SIGN_IN } from '@/lib/auth/safe-redirect';

describe('safe return path after signing in', () => {
  it('returns people to any page in the app, with its query', () => {
    expect(safeReturnPath('/')).toBe('/');
    expect(safeReturnPath('/pulse/cio')).toBe('/pulse/cio');
    expect(safeReturnPath('/audit?surface=cowork')).toBe('/audit?surface=cowork');
    expect(safeReturnPath('/admin/system')).toBe('/admin/system');
  });

  it('refuses anything that could leave the site', () => {
    for (const bad of ['//evil.example.com', 'https://evil.example.com', '/\\evil.example.com', '\\\\evil', 'javascript:alert(1)',
      '/x?next=https://evil.example.com', 'evil.example.com', '/a\nb', '']) {
      expect(safeReturnPath(bad)).toBeNull();
    }
    expect(safeReturnPath(null)).toBeNull();
    expect(safeReturnPath(undefined)).toBeNull();
  });

  it('never sends someone back to a sign-in page (no loops)', () => {
    expect(safeReturnPath('/admin/login')).toBeNull();
    expect(safeReturnPath('/admin/login?expired=1')).toBeNull();
    expect(safeReturnPath('/admin/reset-password/abc')).toBeNull();
    expect(getSafeRedirect('/admin/login')).toBe(DEFAULT_AFTER_SIGN_IN);
  });

  it('falls back to the default page', () => {
    expect(getSafeRedirect(null)).toBe(DEFAULT_AFTER_SIGN_IN);
    expect(getSafeRedirect('//evil.example.com')).toBe(DEFAULT_AFTER_SIGN_IN);
  });

  it('knows the sign-in pages', () => {
    expect(isAuthPage('/admin/login')).toBe(true);
    expect(isAuthPage('/admin/setup')).toBe(true);
    expect(isAuthPage('/admin/reset-password/token')).toBe(true);
    expect(isAuthPage('/admin/system')).toBe(false);
    expect(isAuthPage('/')).toBe(false);
  });
});
