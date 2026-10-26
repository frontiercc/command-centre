// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Cross-normaliser lock test. Two independent
// normalisers exist in this feature: the admin identity route's
// normaliseIdentity() (app/api/pulse/code/github/identity/route.ts) and the
// sync's identityCandidates() (lib/pulse/code/github-identity.ts). If they
// ever drifted apart, a mapping an admin creates could silently never match
// a real commit author. This test POSTs each admin input form through the
// REAL route, reads back what was actually stored, and asserts
// identityCandidates() for the corresponding commit author includes that
// exact stored string — locking the two normalisers together. Harness
// mirrors test/github-identity-route.test.ts (auth-mock + direct handler
// invocation against a real getTypedClient()).
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';
import { identityCandidates, type CommitAuthor } from '@/lib/pulse/code/github-identity';

let sessionResult: { authenticated: boolean; role?: string; userId?: string; email?: string; department?: string | null };
vi.mock('@/lib/auth/admin-auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/admin-auth')>();
  return {
    ...actual,
    getAdminSession: vi.fn(() => sessionResult),
  };
});

let sql: TestSql;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
});

afterAll(async () => cleanup());

beforeEach(async () => {
  sessionResult = { authenticated: true, role: 'admin', userId: 'admin-1', email: 'admin@example.com', department: null };
  await sql.exec(`DELETE FROM github_identity_map;
           DELETE FROM users;`);
  await sql.run(
    `INSERT INTO users (id, email, display_name) VALUES ('u1', 'u1@test.com', 'Ada')`
  );
});

function makeRequest(url: string, init?: { method?: string; body?: string }): NextRequest {
  return new NextRequest(`http://localhost${url}`, init);
}

async function postIdentity(identity: string) {
  const route = await import('../app/api/pulse/code/github/identity/route');
  const res = await route.POST(makeRequest('/api/pulse/code/github/identity', {
    method: 'POST', body: JSON.stringify({ identity, userId: 'u1' }),
  }));
  expect(res.status).toBe(200);
}

async function storedIdentities(): Promise<string[]> {
  const rows = await sql.all(`SELECT identity FROM github_identity_map`) as { identity: string }[];
  return rows.map((r) => r.identity);
}

const CASES: Array<{ adminInput: string; author: CommitAuthor }> = [
  { adminInput: 'Sam@X.com', author: { email: 'sam@x.com', login: null } },
  { adminInput: 'SamDev', author: { email: null, login: 'samdev' } },
  { adminInput: 'login:Ghost', author: { email: null, login: 'Ghost' } },
  { adminInput: '7+cat@users.noreply.github.com', author: { email: '7+cat@users.noreply.github.com', login: null } },
];

describe('cross-normaliser lock: admin identity route vs sync identityCandidates()', () => {
  for (const { adminInput, author } of CASES) {
    it(`'${adminInput}' stores an identity that identityCandidates() resolves for its commit author`, async () => {
      await postIdentity(adminInput);

      const stored = await storedIdentities();
      expect(stored).toHaveLength(1);

      const candidates = identityCandidates(author);
      expect(candidates).toContain(stored[0]);
    });
  }
});
