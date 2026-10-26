// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { extractNoreplyLogin, identityCandidates, bestUnmatchedIdentity } from '@/lib/pulse/code/github-identity';

describe('extractNoreplyLogin', () => {
  it('extracts login from the id-prefixed noreply form', () => {
    expect(extractNoreplyLogin('12345+octo-cat@users.noreply.github.com')).toBe('octo-cat');
  });
  it('extracts login from the legacy un-prefixed noreply form', () => {
    expect(extractNoreplyLogin('OctoCat@users.noreply.github.com')).toBe('octocat');
  });
  it('returns null for ordinary emails', () => {
    expect(extractNoreplyLogin('sam@example.com')).toBeNull();
  });
});

describe('identityCandidates', () => {
  it('lowercased email first, then login form', () => {
    expect(identityCandidates({ email: 'Sam.Taylor@Example.com', login: 'SamT' }))
      .toEqual(['sam.taylor@example.com', 'login:samt']);
  });
  it('derives the login candidate from a noreply email when no top-level login', () => {
    expect(identityCandidates({ email: '99+ghost@users.noreply.github.com', login: null }))
      .toEqual(['99+ghost@users.noreply.github.com', 'login:ghost']);
  });
  it('dedupes when top-level login equals the noreply-derived login', () => {
    expect(identityCandidates({ email: '99+ghost@users.noreply.github.com', login: 'Ghost' }))
      .toEqual(['99+ghost@users.noreply.github.com', 'login:ghost']);
  });
  it('handles null email and null login', () => {
    expect(identityCandidates({ email: null, login: 'x' })).toEqual(['login:x']);
    expect(identityCandidates({ email: null, login: null })).toEqual([]);
  });
});

describe('bestUnmatchedIdentity', () => {
  it('prefers the login form', () => {
    expect(bestUnmatchedIdentity({ email: 'a@example.com', login: 'Zed' })).toBe('login:zed');
  });
  it('falls back to the lowercased email', () => {
    expect(bestUnmatchedIdentity({ email: 'A@Example.com', login: null })).toBe('a@example.com');
  });
  it('derives login from a noreply email', () => {
    expect(bestUnmatchedIdentity({ email: '7+cat@users.noreply.github.com', login: null })).toBe('login:cat');
  });
  it('returns null when nothing usable', () => {
    expect(bestUnmatchedIdentity({ email: null, login: null })).toBeNull();
  });
});
