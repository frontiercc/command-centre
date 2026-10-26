// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Security review: three Pulse routes open to more roles than the
// Audit Log carried a few prompt snippets beside their other data. The text
// now follows the Audit Log rule (admin everyone; manager their own
// department, or everyone when they have none; the person themselves; nobody
// else), and every other field stays. Real Postgres; only auth, the access
// log and two unrelated helpers are mocked.
//   - /api/pulse/cio capabilityLog: content_preview + body (viewers saw them)
//   - /api/pulse/me?userId=: pending candidates' body (same-department
//     colleagues saw them)
//   - /api/pulse/admin/users/[userId]: classifications' content_preview
//     (managers saw every department's)
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

let session: { authenticated: boolean; role?: string; email?: string; userId?: string; department?: string | null };

vi.mock('@/lib/auth/admin-auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/admin-auth')>();
  return { ...actual, getAdminSession: async () => session };
});
const logAccess = vi.fn<(e: { resource: string }) => Promise<void>>(async () => {});
vi.mock('@/lib/audit/log', () => ({ logAccess: (e: { resource: string }) => logAccess(e) }));
vi.mock('@/lib/pulse/aggregator', async (orig) => {
  const actual = await orig<typeof import('@/lib/pulse/aggregator')>();
  return { ...actual, getCoworkCostUsd: async () => 0, getCoworkFrictionIndex: async () => 0 };
});
vi.mock('@/lib/pulse/cowork/file-categories', async (orig) => {
  const actual = await orig<typeof import('@/lib/pulse/cowork/file-categories')>();
  return { ...actual, getFileCategoryMix: async () => [] };
});

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;
let cleanup: () => Promise<void>;

const as = (role: string, email: string, department: string | null) => {
  session = { authenticated: true, role, email, userId: `sess-${email}`, department };
};
const req = (url: string) => new NextRequest(`http://localhost${url}`);

beforeAll(async () => {
  const { createTestDbClient } = await import('./helpers/db');
  const h = await createTestDbClient('postgres');
  cleanup = h.cleanup;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = h.client;
  const { schema } = await import('@/lib/db/schema');

  await client.insert(schema.users).values([
    { id: 'fin1', email: 'fin1@t.test', display_name: 'Fiona', department: 'Finance' },
    { id: 'fin2', email: 'fin2@t.test', display_name: 'Fred', department: 'Finance' },
    { id: 'sal1', email: 'sal1@t.test', display_name: 'Sam', department: 'Sales' },
  ]);
  await client.insert(schema.adminUsers).values([
    { id: 'a-fin1', email: 'fin1@t.test', password_hash: 'x', role: 'pulse', department: 'Finance', linked_cowork_user_id: 'fin1' },
    { id: 'a-fin2', email: 'fin2@t.test', password_hash: 'x', role: 'pulse', department: 'Finance', linked_cowork_user_id: 'fin2' },
    { id: 'a-sal1', email: 'sal1@t.test', password_hash: 'x', role: 'pulse', department: 'Sales', linked_cowork_user_id: 'sal1' },
  ]);
  await client.insert(schema.coworkMessages).values([
    { id: 'cmF', session_id: 'sF', user_id: 'fin1', message_type: 'cowork_user_message', surface: 'cowork', occurred_at: NOW - 2 * DAY, content_preview: 'FIN PREVIEW' },
    { id: 'cmS', session_id: 'sS', user_id: 'sal1', message_type: 'cowork_user_message', surface: 'cowork', occurred_at: NOW - 2 * DAY, content_preview: 'SALES PREVIEW' },
  ]);
  await client.insert(schema.pulseClassifications).values([
    { cowork_message_id: 'cmF', user_id: 'fin1', tier: 3, task_type: 'analysis', classifier_confidence: 0.9, classifier_model: 'haiku', classifier_status: 'classified', classified_at: NOW - 2 * DAY },
  ]);
  await client.insert(schema.pulseEvents).values([
    { user_id: 'fin1', event_type: 'capability_creation', status: 'confirmed', title: 'Fin capability', body: 'Prompt: "FIN BODY"', tier: 3, detected_at: NOW - 2 * DAY, confirmed_at: NOW - DAY, cowork_message_id: 'cmF' },
    { user_id: 'sal1', event_type: 'capability_creation', status: 'confirmed', title: 'Sales capability', body: 'Prompt: "SALES BODY"', tier: 3, detected_at: NOW - 2 * DAY, confirmed_at: NOW - DAY, cowork_message_id: 'cmS' },
    { user_id: 'fin1', event_type: 'capability_creation', status: 'candidate', title: 'Fin candidate', body: 'Prompt: "FIN CANDIDATE"', tier: 3, detected_at: NOW - DAY },
  ]);
}, 120_000);

afterAll(async () => cleanup?.());
beforeEach(() => logAccess.mockClear());

type LogRow = { title: string; body: string | null; content_preview: string | null };
async function capabilityLog(): Promise<Record<string, LogRow>> {
  const { GET } = await import('../app/api/pulse/cio/route');
  const res = await GET(req('/api/pulse/cio'));
  expect(res.status).toBe(200);
  const rows = (await res.json()).capabilityLog as LogRow[];
  return Object.fromEntries(rows.map(r => [r.title, r]));
}

describe('/api/pulse/cio capability log', () => {
  it('a viewer sees titles but no prompt text, and nothing is logged as a prompt read', async () => {
    as('viewer', 'viewer@t.test', null);
    const log = await capabilityLog();
    expect(Object.keys(log).sort()).toEqual(['Fin capability', 'Sales capability']);
    for (const r of Object.values(log)) { expect(r.body).toBeNull(); expect(r.content_preview).toBeNull(); }
    expect(logAccess).not.toHaveBeenCalled();
  });

  it('a Sales manager sees Sales prompt text only, and the read is logged', async () => {
    as('manager', 'mgr@t.test', 'Sales');
    const log = await capabilityLog();
    expect(log['Sales capability'].content_preview).toBe('SALES PREVIEW');
    expect(log['Sales capability'].body).toContain('SALES BODY');
    expect(log['Fin capability'].content_preview).toBeNull();
    expect(log['Fin capability'].body).toBeNull();
    expect(logAccess.mock.calls.map(c => c[0].resource)).toEqual(['pulse/cio/capability-log']);
  });

  it('an admin sees everything', async () => {
    as('admin', 'admin@t.test', null);
    const log = await capabilityLog();
    expect(log['Fin capability'].content_preview).toBe('FIN PREVIEW');
    expect(log['Sales capability'].content_preview).toBe('SALES PREVIEW');
  });

  it('a manager with no department sees no prompt text', async () => {
    as('manager', 'manager@t.test', null);
    const log = await capabilityLog();
    expect(log['Fin capability'].content_preview).toBeNull();
    expect(log['Sales capability'].content_preview).toBeNull();
    expect(log['Sales capability'].body).toBeNull();
  });
});

type Pending = { title: string; body: string | null };
async function pending(url: string): Promise<Pending[]> {
  const { GET } = await import('../app/api/pulse/me/route');
  const res = await GET(req(url));
  expect(res.status).toBe(200);
  return (await res.json()).capabilitiesDetail.pending as Pending[];
}

describe('/api/pulse/me capability candidates', () => {
  it('a same-department colleague sees the candidate title but not the prompt', async () => {
    as('pulse', 'fin2@t.test', 'Finance');
    const p = await pending('/api/pulse/me?userId=fin1');
    expect(p.map(c => c.title)).toEqual(['Fin candidate']);
    expect(p[0].body).toBeNull();
    expect(logAccess).not.toHaveBeenCalled();
  });

  it('the person sees their own candidate prompt', async () => {
    as('pulse', 'fin1@t.test', 'Finance');
    const p = await pending('/api/pulse/me');
    expect(p[0].body).toContain('FIN CANDIDATE');
  });

  it("a manager from another department doesn't see it; an admin does, logged", async () => {
    as('manager', 'mgr@t.test', 'Sales');
    expect((await pending('/api/pulse/me?userId=fin1'))[0].body).toBeNull();
    as('admin', 'admin@t.test', null);
    expect((await pending('/api/pulse/me?userId=fin1'))[0].body).toContain('FIN CANDIDATE');
    expect(logAccess.mock.calls.map(c => c[0].resource)).toEqual(['pulse/me/capability-candidates']);
  });
});

type Classification = { tier: number; content_preview: string | null };
async function drillDown(userId: string): Promise<Classification[]> {
  const { GET } = await import('../app/api/pulse/admin/users/[userId]/route');
  const res = await GET(req(`/api/pulse/admin/users/${userId}`), { params: Promise.resolve({ userId }) });
  expect(res.status).toBe(200);
  return (await res.json()).classifications as Classification[];
}

describe('/api/pulse/admin/users/[userId] drill-down', () => {
  it('a manager from another department sees the tiers but not the prompt previews', async () => {
    as('manager', 'mgr@t.test', 'Sales');
    const c = await drillDown('fin1');
    expect(c).toHaveLength(1);
    expect(c[0].tier).toBe(3);
    expect(c[0].content_preview).toBeNull();
    expect(logAccess).not.toHaveBeenCalled();
  });

  it("a manager in the person's department sees the previews, logged", async () => {
    as('manager', 'mgr@t.test', 'Finance');
    expect((await drillDown('fin1'))[0].content_preview).toBe('FIN PREVIEW');
    expect(logAccess.mock.calls.map(c => c[0].resource)).toEqual(['pulse/admin/user-detail']);
  });
});
