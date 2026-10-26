// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// One password-length rule: 12 characters, enforced server-side by
// every route that sets a password, and none of them may carry its own number.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { MIN_PASSWORD_LENGTH } from '@/lib/auth/password-policy';

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name === 'route.ts') out.push(p);
  }
  return out;
}

describe('password policy', () => {
  it('the minimum is 12', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(12);
  });

  it('every route that hashes a new password checks the shared minimum', () => {
    const root = process.cwd();
    const setters = walk(path.join(root, 'app', 'api'))
      .filter(f => !f.includes(`${path.sep}test${path.sep}`)) // dev-only seed route
      .filter(f => /hashPassword\(/.test(fs.readFileSync(f, 'utf8')));
    expect(setters.length).toBeGreaterThanOrEqual(4);
    const missing = setters
      .filter(f => !/length < MIN_PASSWORD_LENGTH/.test(fs.readFileSync(f, 'utf8')))
      .map(f => path.relative(root, f));
    expect(missing).toEqual([]);
  });

  it('no route or page still hard-codes an 8-character rule', () => {
    const root = process.cwd();
    const files = [...walk(path.join(root, 'app', 'api')),
      path.join(root, 'app/admin/setup/page.tsx'),
      path.join(root, 'app/admin/reset-password/[token]/page.tsx'),
      path.join(root, 'app/admin/security/page.tsx')];
    const hits = files.filter(f => /password[\w.]*\.length < 8\b|at least 8 characters/i.test(fs.readFileSync(f, 'utf8')))
      .map(f => path.relative(root, f));
    expect(hits).toEqual([]);
  });
});
