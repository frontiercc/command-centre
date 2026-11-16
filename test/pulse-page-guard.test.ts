// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Someone who types the address of a Pulse page outside their menu lands on their own page,
// not on one that cannot load. The menu is the list of what each role may open.
import { describe, it, expect } from 'vitest';
import { pulsePageRedirect } from '@/lib/nav/pulse-pages';

describe('Pulse pages outside the menu', () => {
  it('sends the code role from Work Pulse to My Developer Pulse', () => {
    for (const p of ['/pulse/me', '/pulse/cio', '/pulse/dept', '/pulse/users', '/pulse/so-what', '/pulse/coaching', '/pulse/people']) {
      expect(pulsePageRedirect('code', p)).toBe('/pulse/code/me');
    }
  });

  it('sends the cowork role from Developer Pulse to My Pulse', () => {
    for (const p of ['/pulse/code', '/pulse/code/me', '/pulse/code/users', '/pulse/code/dept', '/pulse/code/value']) {
      expect(pulsePageRedirect('cowork', p)).toBe('/pulse/me');
    }
  });

  it('sends contributors from an Overview to their own page in that product', () => {
    for (const r of ['pulse', 'cowork']) expect(pulsePageRedirect(r, '/pulse/cio')).toBe('/pulse/me');
    for (const r of ['pulse', 'code']) {
      for (const p of ['/pulse/code', '/pulse/code/cio', '/pulse/code/framework', '/pulse/code/value']) {
        expect(pulsePageRedirect(r, p)).toBe('/pulse/code/me');
      }
    }
  });

  it('lets each role open the pages its menu gives it', () => {
    for (const r of ['admin', 'manager', 'viewer']) {
      for (const p of ['/pulse/cio', '/pulse/me', '/pulse/dept', '/pulse/code', '/pulse/code/me', '/pulse/code/dept', '/pulse/code/value', '/pulse/code/framework']) {
        expect(pulsePageRedirect(r, p)).toBeNull();
      }
    }
    for (const p of ['/pulse/me', '/pulse/users', '/pulse/dept', '/pulse/code/me', '/pulse/code/users', '/pulse/code/dept']) {
      expect(pulsePageRedirect('pulse', p)).toBeNull();
    }
    for (const p of ['/pulse/me', '/pulse/users', '/pulse/dept']) expect(pulsePageRedirect('cowork', p)).toBeNull();
    for (const p of ['/pulse/code/me', '/pulse/code/users', '/pulse/code/dept']) expect(pulsePageRedirect('code', p)).toBeNull();
  });

  it('leaves alone the index, Use Cases, other pages and a role not known yet', () => {
    expect(pulsePageRedirect('code', '/pulse')).toBeNull();
    expect(pulsePageRedirect('code', '/pulse/use-cases')).toBeNull();
    expect(pulsePageRedirect('code', '/library')).toBeNull();
    expect(pulsePageRedirect('', '/pulse/cio')).toBeNull();
  });
});
