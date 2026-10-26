// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Smoke coverage for the remaining converted admin
// routes NOT exercised by test/pulse-admin-routes-pg.test.ts
// (which covers /api/pulse/admin/health + /api/pulse/admin/tiers). These
// routes previously had ZERO test coverage; this file
// proves the converted async-Drizzle queries execute correctly and return
// the expected shapes on Postgres — the
// NOT-IN-subquery / GROUP BY / dept-filter-with-NULL / ON-CONFLICT
// idioms they share with health/tiers are proven there.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from './helpers/db';

let cleanupDb: () => Promise<void>;
let schema: typeof import('@/lib/db/schema').schema;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;

const mockSession: { authenticated: boolean; role?: string; email?: string; userId?: string; displayName?: string; department?: string | null } = {
  authenticated: true,
  role: 'admin',
  email: 'admin@test.com',
  userId: 'admin1',
  displayName: 'Admin',
};

vi.mock('@/lib/auth/admin-auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/admin-auth')>();
  return {
    ...actual,
    getAdminSession: async () => mockSession,
    requireAdmin: async () => (mockSession.authenticated && mockSession.role === 'admin' ? mockSession : null),
  };
});

vi.mock('@/lib/db/auth-events', () => ({ logAuthEvent: vi.fn() }));

vi.mock('@/lib/audit/log', () => ({ logAccess: vi.fn() }));

function makeRequest(url: string, init?: { method?: string; body?: string }): NextRequest {
  return new NextRequest(`http://localhost${url}`, init);
}

const NOW = Math.floor(Date.now() / 1000);
const DAY = 24 * 3600;

beforeAll(async () => {
  const h = await createTestDatabase();
  cleanupDb = h.cleanup;
  ({ schema } = await import('@/lib/db/schema'));
  const { getClient } = await import('@/lib/db/client');
  client = await getClient();

  await client.insert(schema.users).values([
    { id: 'u1', email: 'u1@test.com', display_name: 'Ada Lovelace', department: 'Engineering', source: 'agent' },
    { id: 'u2', email: 'u2@test.com', display_name: 'Grace Hopper', department: 'Sales', source: 'otel', first_seen_at: NOW - DAY },
  ]);

  await client.insert(schema.coworkMessages).values([
    { id: 'cm1', session_id: 's1', user_id: 'u1', message_type: 'cowork_user_message', surface: 'cowork', content_preview: 'hello', occurred_at: NOW - DAY, source: 'otel' },
    { id: 'cm2', session_id: 's1', user_id: 'u1', message_type: 'cowork_user_message', surface: 'cowork', content_preview: 'unclassified msg', occurred_at: NOW - DAY },
    { id: 'chat1', session_id: 's3', user_id: 'u1', message_type: 'cowork_tool_summary', surface: 'code', occurred_at: NOW - DAY },
  ]);

  await client.insert(schema.pulseClassifications).values([
    { cowork_message_id: 'cm1', user_id: 'u1', tier: 2, task_type: 'coding', classifier_confidence: 0.9, classifier_model: 'haiku', classifier_status: 'classified', classified_at: NOW - DAY },
  ]);

  await client.insert(schema.pulseBriefings).values({
    scope_type: 'organisation', scope_id: 'org', period_start: NOW - 7 * DAY, period_end: NOW,
    body: 'org doing well', model: 'haiku', generated_at: NOW,
  });

  await client.insert(schema.chatMessages).values({
    id: 'chatmsg1', user_id: 'u1', prompt_text: 'hi there', prompt_length: 8, occurred_at: NOW - DAY,
  });

  await client.insert(schema.coworkSessions).values({
    id: 'cs1', conversation_id: 'conv1', user_id: 'u1', started_at: NOW - DAY,
    files_uploaded: JSON.stringify(['report.pdf', 'notes.txt']),
  });
});

afterAll(async () => cleanupDb());

describe('GET /api/pulse/admin/stats', () => {
  it('returns aggregate counts', async () => {
    const { GET } = await import('../app/api/pulse/admin/stats/route');
    const res = await GET(makeRequest('/api/pulse/admin/stats'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.classifiedTotal).toBe(1);
    expect(body.classifiedThisWeek).toBe(1);
    expect(body.failedTotal).toBe(0);
    expect(body.eventsTotal).toBe(0);
    expect(typeof body.classifiedTotal).toBe('number');
  });
});

describe('GET /api/pulse/admin/users/[userId]', () => {
  it('returns the user + classifications + pendingCount', async () => {
    const { GET } = await import('../app/api/pulse/admin/users/[userId]/route');
    const res = await GET(makeRequest('/api/pulse/admin/users/u1'), { params: Promise.resolve({ userId: 'u1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.display_name).toBe('Ada Lovelace');
    expect(body.classifications).toHaveLength(1);
    expect(body.classifications[0].content_preview).toBe('hello');
    // cm2 is unclassified and counts toward pendingCount.
    expect(body.pendingCount).toBe(1);
  });

  it('404s for an unknown user', async () => {
    const { GET } = await import('../app/api/pulse/admin/users/[userId]/route');
    const res = await GET(makeRequest('/api/pulse/admin/users/nope'), { params: Promise.resolve({ userId: 'nope' }) });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/pulse/admin/users', () => {
  it('returns the user list with pending/failed counts, dept-filterable', async () => {
    const { GET } = await import('../app/api/pulse/admin/users/route');
    const res = await GET(makeRequest('/api/pulse/admin/users'));
    expect(res.status).toBe(200);
    const body = await res.json();
    const u1 = body.users.find((u: { id: string }) => u.id === 'u1');
    expect(u1).toBeTruthy();
    expect(u1.pending_count).toBe(1);
    expect(typeof u1.pending_count).toBe('number');
    expect(u1.failed_count).toBe(0);

    const deptRes = await GET(makeRequest('/api/pulse/admin/users?dept=Engineering'));
    const deptBody = await deptRes.json();
    expect(deptBody.users.every((u: { department: string }) => u.department === 'Engineering')).toBe(true);
  });
});

describe('POST /api/pulse/admin/classify', () => {
  it('reports nothing-to-classify when the queue is empty', async () => {
    vi.doMock('@/lib/config', async (orig) => {
      const actual = await (orig as () => Promise<typeof import('@/lib/config')>)();
      return { ...actual, getConfigValue: async (key: string) => (key === 'pulseEnabled' ? 'true' : actual.getConfigValue(key as never)) };
    });
    vi.doMock('@/lib/pulse/classifier', () => ({
      runClassifierJob: vi.fn(async () => ({ selected: 0, classified: 0, failed: 0 })),
    }));
    const { POST } = await import('../app/api/pulse/admin/classify/route');
    const res = await POST(makeRequest('/api/pulse/admin/classify', { method: 'POST' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    // cm2 is unclassified, so the queue is NOT empty — classified will attempt at least one batch.
    expect(body.ok).toBe(true);
    vi.doUnmock('@/lib/config');
    vi.doUnmock('@/lib/pulse/classifier');
  });

  it('reports classified from the job itself, not a queue-depth delta (regression for the 537d8432 fix)', async () => {
    vi.doMock('@/lib/config', async (orig) => {
      const actual = await (orig as () => Promise<typeof import('@/lib/config')>)();
      return { ...actual, getConfigValue: async (key: string) => (key === 'pulseEnabled' ? 'true' : actual.getConfigValue(key as never)) };
    });
    // Simulates the exact bug scenario: the job's one pass attempts cm2 and
    // exhausts its attempts (writing a real classifier_attempts=5/failed row
    // as a side effect, so it drops out of the NOT-IN candidate query the
    // route's getQueueDepth() runs) WITHOUT actually classifying it. The old
    // buggy code computed classified = before - after, and since the queue
    // genuinely shrank (cm2 is now excluded via attempts>=5), it would have
    // reported classified: 1 — wrong, nothing was ever classified. The fixed
    // code reports classified: 0, taken from the job's own result.
    vi.doMock('@/lib/pulse/classifier', () => ({
      runClassifierJob: vi.fn(async () => {
        await client.insert(schema.pulseClassifications).values({
          cowork_message_id: 'cm2', user_id: 'u1', tier: 1, task_type: 'summarisation',
          frontier_push_candidate: 0, capability_creation_candidate: 0, classifier_confidence: 0,
          classifier_model: 'unknown', classifier_status: 'failed', classifier_attempts: 5,
          classifier_error: 'API call failed', classified_at: NOW,
        }).onConflictDoUpdate({
          target: schema.pulseClassifications.cowork_message_id,
          set: { classifier_attempts: 5, classifier_status: 'failed' },
        });
        return { selected: 1, classified: 0, failed: 1 };
      }),
    }));
    const { POST } = await import('../app/api/pulse/admin/classify/route');
    const res = await POST(makeRequest('/api/pulse/admin/classify', { method: 'POST' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.classified).toBe(0); // NOT 1 — the queue-depth-delta bug would have reported 1
    vi.doUnmock('@/lib/config');
    vi.doUnmock('@/lib/pulse/classifier');
    // Restore cm2 to unclassified for any other test in this file that assumes it.
    await client.delete(schema.pulseClassifications).where(eq(schema.pulseClassifications.cowork_message_id, 'cm2'));
  });
});

describe('GET/POST /api/admin/otel-status', () => {
  it('returns OTel adoption stats', async () => {
    const { GET } = await import('../app/api/admin/otel-status/route');
    const res = await GET(makeRequest('/api/admin/otel-status'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.otelUserCount).toBe(1); // u2 is source='otel'
    expect(typeof body.otelUserCount).toBe('number');
    expect(body.recentOtelUsers).toHaveLength(1);
    expect(body.recentOtelUsers[0].id).toBe('u2');
    expect(body.lastOtelEventAt).toBe(NOW - DAY); // cm1 has source='otel'
  });
});

describe('GET/POST /api/admin/pulse/psr-baselines', () => {
  it('lists departments (via admin_users.department, not the unpopulated users.team_id) and upserts a baseline', async () => {
    const { GET, POST } = await import('../app/api/admin/pulse/psr-baselines/route');
    // Every OTel-enrolled user gets an auto-created admin_users row with
    // department mirrored + linked_cowork_user_id set (see the receivers'
    // "auto-enrol admin_users" logic) — this is what PSR now reads from.
    await client.insert(schema.adminUsers).values({
      id: 'admin-u1', email: 'u1-admin@test.com', display_name: 'Ada Lovelace',
      password_hash: '__otel_pending__', role: 'pulse', department: 'Engineering', linked_cowork_user_id: 'u1',
    });

    const getRes = await GET(makeRequest('/api/admin/pulse/psr-baselines'));
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.teams.some((t: { teamId: string }) => t.teamId === 'Engineering')).toBe(true);

    const postRes = await POST(makeRequest('/api/admin/pulse/psr-baselines', {
      method: 'POST', body: JSON.stringify({ teamId: 'Engineering', baselineProcessCount: 5 }),
    }));
    expect(postRes.status).toBe(200);
    const postBody = await postRes.json();
    expect(postBody.ok).toBe(true);
    expect(postBody.baselineProcessCount).toBe(5);

    // Round-trip: a second GET reflects the saved baseline.
    const getRes2 = await GET(makeRequest('/api/admin/pulse/psr-baselines'));
    const getBody2 = await getRes2.json();
    const dept = getBody2.teams.find((t: { teamId: string }) => t.teamId === 'Engineering');
    expect(dept.baselineProcessCount).toBe(5);

    // Upsert again — updates in place rather than duplicating.
    const postRes2 = await POST(makeRequest('/api/admin/pulse/psr-baselines', {
      method: 'POST', body: JSON.stringify({ teamId: 'Engineering', baselineProcessCount: 9 }),
    }));
    expect((await postRes2.json()).baselineProcessCount).toBe(9);
    const getRes3 = await GET(makeRequest('/api/admin/pulse/psr-baselines'));
    const depts3 = (await getRes3.json()).teams.filter((t: { teamId: string }) => t.teamId === 'Engineering');
    expect(depts3).toHaveLength(1);
    expect(depts3[0].baselineProcessCount).toBe(9);
  });

  it('saves when the admin session email already belongs to a DIFFERENT users.id (real-world case: admin is also an OTel-captured user)', async () => {
    const { POST } = await import('../app/api/admin/pulse/psr-baselines/route');

    // users and admin_users are separate keyspaces. This
    // row simulates OTel/Compliance capture having already created a users
    // row for this person's real email, keyed by a DIFFERENT id than their
    // admin_users.id (which is what session.userId resolves to below).
    await client.insert(schema.users).values({
      id: 'sam.taylor@example.com', email: 'sam.taylor@example.com', display_name: 'Sam Taylor',
    });

    mockSession.userId = 'admin-uuid-never-in-users-table';
    mockSession.email = 'sam.taylor@example.com';

    const postRes = await POST(makeRequest('/api/admin/pulse/psr-baselines', {
      method: 'POST', body: JSON.stringify({ teamId: 'Consulting', baselineProcessCount: 13 }),
    }));
    expect(postRes.status).toBe(200);
    const postBody = await postRes.json();
    expect(postBody.ok).toBe(true);
    expect(postBody.baselineProcessCount).toBe(13);

    // restore the shared mock session for any later tests in this file
    mockSession.userId = 'admin1';
    mockSession.email = 'admin@test.com';
  });
});

describe('POST /api/admin/otel-prepopulate', () => {
  it('bulk-creates users + admin_users rows, tolerating duplicates', async () => {
    const { POST } = await import('../app/api/admin/otel-prepopulate/route');
    const res = await POST(makeRequest('/api/admin/otel-prepopulate', {
      method: 'POST',
      body: JSON.stringify({ users: [
        { email: 'new1@test.com', display_name: 'New One', department: 'Ops' },
        { email: 'new2@test.com', display_name: 'New Two' },
        { email: 'u1@test.com', display_name: 'Ada Duplicate' }, // already exists — skipped
      ] }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(2);
    expect(body.skipped).toBe(1);

    const newUserRows = await client.select().from(schema.users).where(eq(schema.users.email, 'new1@test.com'));
    expect(newUserRows).toHaveLength(1);
    expect(newUserRows[0].source).toBe('otel');

    const adminRows = await client.select().from(schema.adminUsers).where(eq(schema.adminUsers.email, 'new1@test.com'));
    expect(adminRows).toHaveLength(1);
    expect(adminRows[0].password_hash).toBe('__otel_pending__');
    expect(adminRows[0].role).toBe('cowork');
  });
});

describe('GET /api/admin/export', () => {
  it('returns a CSV with cowork + chat rows, excluding tool-summary types', async () => {
    const { GET } = await import('../app/api/admin/export/route');
    const res = await GET(makeRequest('/api/admin/export'));
    expect(res.status).toBe(200);
    const csv = await res.text();
    expect(csv).toContain('hello');
    expect(csv).toContain('hi there');
    // cowork_tool_summary rows are excluded.
    const lines = csv.split('\r\n');
    expect(lines.some(l => l.includes('cowork_tool_summary'))).toBe(false);
  });

  it('filters by surface', async () => {
    const { GET } = await import('../app/api/admin/export/route');
    const res = await GET(makeRequest('/api/admin/export?surface=chat'));
    const csv = await res.text();
    expect(csv).toContain('hi there');
    expect(csv).not.toContain('unclassified msg');
  });
});

describe('GET /api/admin/files', () => {
  it('explodes files_uploaded JSON into one row per file', async () => {
    const { GET } = await import('../app/api/admin/files/route');
    const res = await GET(makeRequest('/api/admin/files'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.files.map((f: { filename: string }) => f.filename).sort()).toEqual(['notes.txt', 'report.pdf']);
    expect(body.files[0].display_name).toBe('Ada Lovelace');
    expect(body.depts).toContain('Engineering');
  });

  it('filters by search term', async () => {
    const { GET } = await import('../app/api/admin/files/route');
    const res = await GET(makeRequest('/api/admin/files?search=report'));
    const body = await res.json();
    expect(body.files).toHaveLength(1);
    expect(body.files[0].filename).toBe('report.pdf');
  });
});

describe('GET /api/admin/users — agents list', () => {
  it('returns the users list as agents ordered by display_name with NULLs first', async () => {
    const { GET } = await import('../app/api/admin/users/route');
    const res = await GET(makeRequest('/api/admin/users'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agents.map((a: { id: string }) => a.id)).toEqual(expect.arrayContaining(['u1', 'u2']));
  });
});
