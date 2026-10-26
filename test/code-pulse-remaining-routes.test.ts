// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Regression coverage for the six Developer Pulse route
// handlers that had no dedicated route-level test before this conversion:
// classifier, github, dept/[dept], depts, rates, users. (org-summary and me
// — the two heaviest — get their own test, test/code-pulse-org-
// me-routes-pg.test.ts.) These six are lighter (1-4 .prepare( sites each)
// and share the same conversion pattern, so a single file (run on Postgres
// via createTestDatabase) exercises each route's post-conversion behaviour: latest-row-per-scope
// MAX(id) joins (dept/depts/users), the transactional mapping replace
// (github PUT), and plain aggregate reads (classifier, rates).
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sessionResult: { authenticated: boolean; role?: string; userId?: string; email?: string; department?: string | null };
vi.mock('@/lib/auth/admin-auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/admin-auth')>();
  return {
    ...actual,
    getAdminSession: vi.fn(() => sessionResult),
  };
});

// Stateful: first call reports work, every subsequent call reports nothing —
// lets the route's bounded drain (POST run-now) terminate deterministically
// after exactly one pass instead of looping to MAX_DRAIN_PASSES.
let runNowCallCount = 0;
vi.mock('@/lib/pulse/code/classifier', async (orig) => {
  const actual = await orig<typeof import('@/lib/pulse/code/classifier')>();
  return {
    ...actual,
    runCodeClassifierJob: vi.fn(async () => {
      runNowCallCount++;
      return runNowCallCount === 1
        ? { selected: 3, classified: 3, failed: 0 }
        : { selected: 0, classified: 0, failed: 0 };
    }),
  };
});

let sql: TestSql;
let cleanup: () => Promise<void>;

const NOW = Math.floor(Date.now() / 1000);
const DAY = 24 * 60 * 60;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
});

afterAll(async () => cleanup());

beforeEach(async () => {
  sessionResult = { authenticated: true, role: 'admin', userId: 'admin-1', email: 'admin@example.com', department: null };
  runNowCallCount = 0;
  await sql.exec(`DELETE FROM code_session_classifications;
           DELETE FROM code_session_stats;
           DELETE FROM code_assistant_meta;
           DELETE FROM code_metrics;
           DELETE FROM github_repo_map;
           DELETE FROM github_repo_stats;
           DELETE FROM users;
           DELETE FROM config;`);
});

function makeRequest(url: string, init?: { method?: string; body?: string }): NextRequest {
  return new NextRequest(`http://localhost${url}`, init);
}

// ─── classifier route ───────────────────────────────────────────────────────

describe('GET/POST /api/pulse/code/classifier', () => {
  it('reports classified/failed counts and clears failed rows on retry-failed', async () => {
    await sql.run(`INSERT INTO code_session_stats (session_id, first_at, last_at, computed_at) VALUES ('s1', ?, ?, ?), ('s2', ?, ?, ?)`, [NOW - DAY, NOW, NOW, NOW - DAY, NOW, NOW]);
    await sql.run(`INSERT INTO code_session_classifications (session_id, work_type, tier, confidence, classifier_model, status, classified_at)
       VALUES ('s1', 'feature', 2, 0.8, 'haiku', 'classified', ?), ('s2', 'bugfix', 1, 0.5, 'haiku', 'failed', ?)`, [NOW, NOW]);

    const route = await import('../app/api/pulse/code/classifier/route');
    const res = await route.GET(makeRequest('/api/pulse/code/classifier'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.classified).toBe(1);
    expect(data.failed).toBe(1);
    // lastFailure was replaced by the currentFailures list (classifier-health payload).
    expect(data.currentFailures).toHaveLength(1);
    expect(data.currentFailures[0].session_id).toBe('s2');
    expect(data.currentFailures[0].error).toBeNull(); // code_session_classifications has no `error` column set
    expect(data).not.toHaveProperty('promptPreview');
    expect(data.queue).toBeTruthy();
    expect(data.tierDistribution).toBeTruthy();
    expect(data.confidenceHistogram).toBeTruthy();

    const retryRes = await route.POST(makeRequest('/api/pulse/code/classifier', {
      method: 'POST', body: JSON.stringify({ action: 'retry-failed' }),
    }));
    expect(retryRes.status).toBe(200);
    const retryData = await retryRes.json();
    expect(retryData.cleared).toBe(1);

    const remaining = (await sql.get(`SELECT COUNT(*) AS c FROM code_session_classifications`)) as { c: number };
    expect(remaining.c).toBe(1);
  });

  it('run-now delegates to runCodeClassifierJob and drains to a remaining count', async () => {
    const route = await import('../app/api/pulse/code/classifier/route');
    const res = await route.POST(makeRequest('/api/pulse/code/classifier', {
      method: 'POST', body: JSON.stringify({ action: 'run-now' }),
    }));
    const data = await res.json();
    // Mocked runCodeClassifierJob reports work once then nothing — the drain
    // loop stops after 2 passes (1 with work + 1 confirming empty).
    expect(data.ok).toBe(true);
    expect(data.classified).toBe(3);
    expect(data.failed).toBe(0);
    expect(typeof data.remaining).toBe('number');
  });
});

// ─── github route ───────────────────────────────────────────────────────────

describe('GET/PUT/POST /api/pulse/code/github', () => {
  it('lists distinct repos seen and round-trips mappings via a transactional replace', async () => {
    await sql.run(`INSERT INTO code_session_stats (session_id, repo, first_at, last_at, computed_at) VALUES
       ('s1', 'repo-a', ?, ?, ?), ('s2', 'repo-a', ?, ?, ?), ('s3', 'repo-b', ?, ?, ?)`, [NOW - DAY, NOW, NOW, NOW - DAY, NOW, NOW, NOW - DAY, NOW, NOW]);

    const route = await import('../app/api/pulse/code/github/route');
    const getRes = await route.GET(makeRequest('/api/pulse/code/github'));
    const getData = await getRes.json();
    expect(getData.reposSeen).toEqual(['repo-a', 'repo-b']);
    expect(getData.mappings).toEqual([]);

    const putRes = await route.PUT(makeRequest('/api/pulse/code/github', {
      method: 'PUT',
      body: JSON.stringify({ mappings: [{ repo: 'repo-a', github_repo: 'org/repo-a' }] }),
    }));
    expect(putRes.status).toBe(200);
    const putData = await putRes.json();
    expect(putData.mappings).toEqual([{ repo: 'repo-a', github_repo: 'org/repo-a' }]);

    // Replace-all: a second PUT with a different mapping set must fully
    // supersede the first (proves the transactional delete-then-insert).
    const putRes2 = await route.PUT(makeRequest('/api/pulse/code/github', {
      method: 'PUT',
      body: JSON.stringify({ mappings: [{ repo: 'repo-b', github_repo: 'org/repo-b' }] }),
    }));
    const putData2 = await putRes2.json();
    expect(putData2.mappings).toEqual([{ repo: 'repo-b', github_repo: 'org/repo-b' }]);

    const rejectRes = await route.PUT(makeRequest('/api/pulse/code/github', {
      method: 'PUT',
      body: JSON.stringify({ mappings: [{ repo: 'repo-c', github_repo: 'not a valid repo' }] }),
    }));
    expect(rejectRes.status).toBe(400);
  });

  it('blanking or re-submitting the masked token via PUT is a no-op — Remove-only holds on this write path too', async () => {
    const cfg = await import('@/lib/config');
    await cfg.setConfigValue('githubToken', 'github_pat_real');
    const route = await import('../app/api/pulse/code/github/route');

    const blankRes = await route.PUT(makeRequest('/api/pulse/code/github', {
      method: 'PUT', body: JSON.stringify({ token: '' }),
    }));
    expect(blankRes.status).toBe(200);
    expect(await cfg.getConfigValue('githubToken')).toBe('github_pat_real');

    const whitespaceRes = await route.PUT(makeRequest('/api/pulse/code/github', {
      method: 'PUT', body: JSON.stringify({ token: '   ' }),
    }));
    expect(whitespaceRes.status).toBe(200);
    expect(await cfg.getConfigValue('githubToken')).toBe('github_pat_real');

    const maskedRes = await route.PUT(makeRequest('/api/pulse/code/github', {
      method: 'PUT', body: JSON.stringify({ token: 'github_p••••••••' }),
    }));
    expect(maskedRes.status).toBe(200);
    expect(await cfg.getConfigValue('githubToken')).toBe('github_pat_real');
  });

  it('a real new token via PUT still saves', async () => {
    const cfg = await import('@/lib/config');
    const route = await import('../app/api/pulse/code/github/route');
    const res = await route.PUT(makeRequest('/api/pulse/code/github', {
      method: 'PUT', body: JSON.stringify({ token: 'github_pat_newvalue' }),
    }));
    expect(res.status).toBe(200);
    expect(await cfg.getConfigValue('githubToken')).toBe('github_pat_newvalue');
  });

  it('POST triggers a sync via runGithubSync', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async () => ({
      ok: true, status: 200,
      headers: { get: () => null },
      json: async () => [],
    })) as unknown as typeof fetch;
    try {
      await sql.run(`INSERT INTO github_repo_map (repo, github_repo, created_at) VALUES ('repo-a', 'org/repo-a', ?)`, [NOW]);
      const route = await import('../app/api/pulse/code/github/route');
      const res = await route.POST(makeRequest('/api/pulse/code/github', { method: 'POST' }));
      const data = await res.json();
      expect(data).toEqual({ synced: 1, failed: 0, errors: [] });
    } finally {
      global.fetch = originalFetch;
    }
  });
});

// ─── dept/[dept] route ──────────────────────────────────────────────────────

describe('GET /api/pulse/code/dept/[dept]', () => {
  it('returns dept metrics, full-roster members, and the journey grid', async () => {
    await sql.run(`INSERT INTO users (id, email, display_name, department) VALUES ('u1', 'u1@test.com', 'Ada', 'Engineering')`);
    await sql.run(`INSERT INTO code_metrics (scope_type, scope_id, period_start, period_end, spend_usd, session_count, granularity, computed_at)
       VALUES ('function', 'Engineering', ?, ?, 7.5, 3, 'rolling', ?)`, [NOW - 7 * DAY, NOW, NOW]);
    await sql.run(`INSERT INTO code_session_stats (session_id, user_id, first_at, last_at, computed_at) VALUES ('s1', 'u1', ?, ?, ?)`, [NOW - DAY, NOW, NOW]);
    await sql.run(`INSERT INTO code_session_classifications (session_id, user_id, work_type, tier, confidence, classifier_model, status, classified_at)
       VALUES ('s1', 'u1', 'feature', 2, 0.8, 'haiku', 'classified', ?)`, [NOW]);

    const route = await import('../app/api/pulse/code/dept/[dept]/route');
    const res = await route.GET(makeRequest('/api/pulse/code/dept/Engineering'), { params: Promise.resolve({ dept: 'Engineering' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.metrics.spend_usd).toBeCloseTo(7.5, 6);
    expect(data.members.map((m: { user_id: string }) => m.user_id)).toEqual(['u1']);
    expect(data.journeyGrid).toEqual([{ week: 0, tier: 2, count: 1, provisionalCount: 0 }]);
  });

  it('forbids a dept-scoped session viewing another department', async () => {
    sessionResult = { authenticated: true, role: 'pulse', userId: 'u2', email: 'u2@test.com', department: 'Sales' };
    const route = await import('../app/api/pulse/code/dept/[dept]/route');
    const res = await route.GET(makeRequest('/api/pulse/code/dept/Engineering'), { params: Promise.resolve({ dept: 'Engineering' }) });
    expect(res.status).toBe(403);
  });
});

// ─── depts route ────────────────────────────────────────────────────────────

describe('GET /api/pulse/code/depts', () => {
  it('returns the latest function-scope row per department via the MAX(id) join, with member_count', async () => {
    await sql.run(`INSERT INTO users (id, email, department) VALUES ('u1', 'u1@test.com', 'Engineering'), ('u2', 'u2@test.com', 'Engineering')`);
    await sql.run(`INSERT INTO code_metrics (scope_type, scope_id, period_start, period_end, spend_usd, granularity, computed_at)
       VALUES ('function', 'Engineering', ?, ?, 3.0, 'rolling', ?), ('function', 'Engineering', ?, ?, 9.0, 'rolling', ?)`, [NOW - 14 * DAY, NOW - 7 * DAY, NOW - 7 * DAY, NOW - 7 * DAY, NOW, NOW]);

    const route = await import('../app/api/pulse/code/depts/route');
    const res = await route.GET(makeRequest('/api/pulse/code/depts'));
    const data = await res.json();
    expect(data.depts).toHaveLength(1);
    // MAX(id) picks the LATER-inserted (higher id) row — spend_usd 9.0, not the stale 3.0.
    expect(data.depts[0].spend_usd).toBeCloseTo(9.0, 6);
    expect(data.depts[0].member_count).toBe(2);
  });
});

// ─── rates route ────────────────────────────────────────────────────────────

describe('GET/PUT /api/pulse/code/rates', () => {
  it('surfaces unpriced models and round-trips a rate override', async () => {
    await sql.run(`INSERT INTO code_assistant_meta (id, session_id, model, occurred_at) VALUES ('a1', 's1', 'made-up-model', ?)`, [NOW]);

    const route = await import('../app/api/pulse/code/rates/route');
    const getRes = await route.GET(makeRequest('/api/pulse/code/rates'));
    const getData = await getRes.json();
    expect(getData.unpricedModels).toEqual(['made-up-model']);

    const putRes = await route.PUT(makeRequest('/api/pulse/code/rates', {
      method: 'PUT',
      body: JSON.stringify({ rates: { 'made-up-model': { in: 2, out: 8, cacheWrite: 2.5, cacheRead: 0.2 } } }),
    }));
    expect(putRes.status).toBe(200);
    const putData = await putRes.json();
    expect(putData.rates['made-up-model']).toEqual({ in: 2, out: 8, cacheWrite: 2.5, cacheRead: 0.2 });

    const getRes2 = await route.GET(makeRequest('/api/pulse/code/rates'));
    const getData2 = await getRes2.json();
    expect(getData2.unpricedModels).toEqual([]); // now priced
  });
});

// ─── users route ────────────────────────────────────────────────────────────

describe('GET /api/pulse/code/users', () => {
  it('returns the latest user-scope row per user, joined to identity, dept-filterable', async () => {
    await sql.run(`INSERT INTO users (id, email, display_name, department) VALUES ('u1', 'u1@test.com', 'Ada', 'Engineering'), ('u2', 'u2@test.com', 'Grace', 'Sales')`);
    await sql.run(`INSERT INTO code_metrics (scope_type, scope_id, period_start, period_end, spend_usd, granularity, computed_at)
       VALUES ('user', 'u1', ?, ?, 4.0, 'rolling', ?), ('user', 'u1', ?, ?, 20.0, 'rolling', ?), ('user', 'u2', ?, ?, 1.0, 'rolling', ?)`, [NOW - 14 * DAY, NOW - 7 * DAY, NOW - 7 * DAY, NOW - 7 * DAY, NOW, NOW, NOW - 7 * DAY, NOW, NOW]);

    const route = await import('../app/api/pulse/code/users/route');
    const res = await route.GET(makeRequest('/api/pulse/code/users'));
    const data = await res.json();
    expect(data.users).toHaveLength(2);
    const u1 = data.users.find((u: { user_id: string }) => u.user_id === 'u1');
    // MAX(id) picks the later row (20.0), not the stale 4.0.
    expect(u1.spend_usd).toBeCloseTo(20.0, 6);
    expect(u1.display_name).toBe('Ada');

    const deptRes = await route.GET(makeRequest('/api/pulse/code/users?dept=Sales'));
    const deptData = await deptRes.json();
    expect(deptData.users).toHaveLength(1);
    expect(deptData.users[0].user_id).toBe('u2');
  });
});
