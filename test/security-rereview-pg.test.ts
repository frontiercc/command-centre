// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Security fixes. Real Postgres; only auth, the access
// log and the report generator are mocked.
//   R1  telemetry accepts only a single plain email address
//   R2  Developer Pulse department page refuses a contributor with no department
//   R3  stored reports holding a cost section are hidden from viewers
//   R4  intent-alert AI reasoning follows the Audit Log rule
//   R5  a value sent with a self-confirm is ignored
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

let session: { authenticated: boolean; role?: string; email?: string; userId?: string; department?: string | null };

vi.mock('@/lib/auth/admin-auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/admin-auth')>();
  return { ...actual, getAdminSession: async () => session };
});
const logAccess = vi.fn<(e: { resource: string }) => Promise<void>>(async () => {});
vi.mock('@/lib/audit/log', () => ({ logAccess: (e: { resource: string }) => logAccess(e) }));
vi.mock('@/lib/anthropic/ai', async (orig) => {
  const actual = await orig<typeof import('@/lib/anthropic/ai')>();
  return { ...actual, generateGovernanceReport: async () => '## Executive Summary\nAll fine.\n\n### Spend Review: October 2026\nAda $500' };
});

let cleanup: () => Promise<void>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let schema: any;
const as = (role: string, department: string | null, userId = `sess-${role}`) => {
  session = { authenticated: true, role, email: `${role}@t.test`, userId, department };
};
const req = (url: string, init?: ConstructorParameters<typeof NextRequest>[1]) => new NextRequest(`http://localhost${url}`, init);

beforeAll(async () => {
  const { createTestDbClient } = await import('./helpers/db');
  const h = await createTestDbClient('postgres');
  cleanup = h.cleanup;
  client = h.client;
  ({ schema } = await import('@/lib/db/schema'));

  await client.insert(schema.users).values([
    { id: 'fin1', email: 'fin1@t.test', display_name: 'Fiona', department: 'Finance' },
    { id: 'sal1', email: 'sal1@t.test', display_name: 'Sam', department: 'Sales' },
  ]);
  await client.insert(schema.adminUsers).values([
    { id: 'au-fin1', email: 'fin1@t.test', password_hash: 'x', role: 'pulse', department: 'Finance', linked_cowork_user_id: 'fin1' },
  ]);
  await client.insert(schema.config).values({ key: 'chargeback_enabled', value: 'true' });
}, 120_000);

afterAll(async () => cleanup?.());
beforeEach(() => logAccess.mockClear());

describe('R1: telemetry accepts only a single plain email address', () => {
  it('isPlainEmail allows real addresses and refuses list or header syntax', async () => {
    const { isPlainEmail } = await import('@/lib/email/address');
    for (const ok of ['ada@example.com', 'o\'brien@example.co.uk', 'bob+fin@example.com', 'First.Last@Sub.Example.com', 'zoë@exämple.de']) expect(isPlainEmail(ok)).toBe(true);
    for (const bad of ['attacker@example.net,x@example.com', 'a@example.net;b@example.com', 'A <a@example.com>', 'a b@example.com', '"a"@example.com', 'a@b@example.com', 'a@example', '', 'a@example.com\nBcc: x@y.com']) expect(isPlainEmail(bad)).toBe(false);
  });

  it('resolveOtelUser refuses a list address and creates no account', async () => {
    const { resolveOtelUser } = await import('@/lib/otel/resolve-user');
    const input = { email: 'attacker@example.net,x@example.com', installationId: 'inst-r1', displayName: 'X', department: 'Finance', surface: 'cowork' as const, nowS: 1, eventCount: 1 };
    await expect(resolveOtelUser(client, input)).rejects.toThrow(/single plain email/);
    const rows = await client.select().from(schema.adminUsers).where((await import('drizzle-orm')).like(schema.adminUsers.email, '%example.net%'));
    expect(rows).toHaveLength(0);
  });

  it('resolveOtelUser still creates an account for a plain address', async () => {
    const { resolveOtelUser } = await import('@/lib/otel/resolve-user');
    const r = await resolveOtelUser(client, { email: 'newperson@example.com', installationId: 'inst-r1b', displayName: 'New', department: 'Sales', surface: 'cowork', nowS: 1, eventCount: 1 });
    expect(r.created).toBe(true);
  });
});

describe('R2: Developer Pulse department page and contributors with no department', () => {
  const get = async (dept: string) => {
    const { GET } = await import('../app/api/pulse/code/dept/[dept]/route');
    return GET(req(`/api/pulse/code/dept/${dept}`), { params: Promise.resolve({ dept }) });
  };
  it('refuses a pulse user with no department (was: any department returned)', async () => {
    as('pulse', null);
    const res = await get('Finance');
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('no_department');
  });
  it('refuses another department and allows their own', async () => {
    as('code', 'Sales');
    expect((await get('Finance')).status).toBe(403);
    expect((await get('Sales')).status).toBe(200);
  });
  it('admins still see any department', async () => {
    as('admin', null);
    expect((await get('Finance')).status).toBe(200);
  });
});

describe('R3: stored reports with a cost section', () => {
  beforeAll(async () => {
    await client.insert(schema.reports).values([
      { id: 'r-plain', report_type: 'on-demand', period_start: '2026-09-01', period_end: '2026-09-30', content_md: '## Executive Summary\nok', generated_at: 3 },
      { id: 'r-flag', report_type: 'on-demand', period_start: '2026-09-01', period_end: '2026-09-30', content_md: '## Executive Summary\nok', manager_only: 1, generated_at: 2 },
      { id: 'r-legacy', report_type: 'on-demand', period_start: '2026-09-01', period_end: '2026-09-30', content_md: '## Cost & Chargeback\nAda $900', generated_at: 1 },
    ]);
  });
  const list = async () => {
    const { GET } = await import('../app/api/ai/report/route');
    const res = await GET(req('/api/ai/report'));
    expect(res.status).toBe(200);
    return ((await res.json()) as { id: string }[]).map(r => r.id).filter(id => id.startsWith('r-'));
  };
  const one = async (id: string) => {
    const { GET } = await import('../app/api/ai/report/route');
    return (await GET(req(`/api/ai/report?id=${id}`))).status;
  };

  it('a viewer sees only reports without a cost section, flagged or legacy', async () => {
    as('viewer', null);
    expect(await list()).toEqual(['r-plain']);
    expect(await one('r-flag')).toBe(404);
    expect(await one('r-legacy')).toBe(404);
    expect(await one('r-plain')).toBe(200);
  });

  it('a manager sees them all', async () => {
    as('manager', null);
    expect((await list()).sort()).toEqual(['r-flag', 'r-legacy', 'r-plain']);
  });

  it('a report generated with Spend Review is stored flagged', async () => {
    as('manager', null);
    const { POST } = await import('../app/api/ai/report/route');
    const res = await POST(req('/api/ai/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sections: ['spend_review'] }) }));
    expect(res.status).toBe(200);
    const { id } = await res.json();
    const rows = await client.select({ m: schema.reports.manager_only }).from(schema.reports).where((await import('drizzle-orm')).eq(schema.reports.id, id));
    expect(rows[0].m).toBe(1);
  });
});

describe('R4: intent-alert reasoning', () => {
  beforeAll(async () => {
    const intent = (reasoning: string) => ({ surface: 'cowork', message_id: 'm1', intent_category: 'data_exfiltration', matched_patterns: ['export'], ai_assessment: { severity: 'high', reasoning, recommended_action: 'Review' } });
    await client.insert(schema.alerts).values([
      { id: 'i-fin', user_id: 'fin1', alert_type: 'intent', severity: 'high', title: 'Intent', explanation: 'FIN REASONING "send the client list to my gmail"', raw_evidence: intent('FIN REASONING') },
      { id: 'c-fin', user_id: 'fin1', alert_type: 'anomaly', severity: 'medium', title: 'Cost spike', explanation: 'COST EXPLANATION', raw_evidence: { spend_24h: 12 } },
    ]);
  });
  type A = { id: string; explanation: string; raw_evidence: string };
  const alerts = async () => {
    const { GET } = await import('../app/api/alerts/route');
    const res = await GET(req('/api/alerts'));
    expect(res.status).toBe(200);
    return Object.fromEntries(((await res.json()) as A[]).map(a => [a.id, a]));
  };

  it('a viewer sees the alert but not the reasoning, in the explanation or the detail', async () => {
    as('viewer', null);
    const { WITHHELD_REASONING } = await import('@/lib/alerts/evidence-visibility');
    const a = await alerts();
    expect(a['i-fin'].explanation).toBe(WITHHELD_REASONING);
    expect(a['i-fin'].raw_evidence).not.toContain('FIN REASONING');
    expect(JSON.parse(a['i-fin'].raw_evidence).intent_category).toBe('data_exfiltration');
    expect(a['c-fin'].explanation).toBe('COST EXPLANATION');
  });

  it('a manager in another department does not see it; one in Finance does', async () => {
    as('manager', 'Sales');
    expect((await alerts())['i-fin'].explanation).not.toContain('FIN REASONING');
    as('manager', 'Finance');
    const a = await alerts();
    expect(a['i-fin'].explanation).toContain('FIN REASONING');
    expect(a['i-fin'].raw_evidence).toContain('FIN REASONING');
  });
});

describe('R5: value on a self-confirm', () => {
  const patch = async (body: unknown) => {
    const { PATCH } = await import('../app/api/pulse/capabilities/route');
    return PATCH(req('/api/pulse/capabilities', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  };
  const value = { valueAmount: 5_000_000, valueType: 'cost_avoidance', valuePeriod: 'annual', valueBasis: 'made up' };
  const event = async (id: number) => (await client.select().from(schema.pulseEvents).where((await import('drizzle-orm')).eq(schema.pulseEvents.id, id)))[0];

  it('a pulse user confirms their own capability but the value is ignored', async () => {
    const [{ id }] = await client.insert(schema.pulseEvents).values({ user_id: 'fin1', event_type: 'capability_creation', status: 'candidate', title: 'Own', tier: 3, detected_at: 1 }).returning({ id: schema.pulseEvents.id });
    as('pulse', 'Finance', 'au-fin1');
    expect((await patch({ id, action: 'confirm', value })).status).toBe(200);
    const e = await event(id);
    expect(e.status).toBe('confirmed');
    expect(e.value_amount).toBeNull();
  });

  it('an admin can still attribute a value', async () => {
    const [{ id }] = await client.insert(schema.pulseEvents).values({ user_id: 'fin1', event_type: 'capability_creation', status: 'candidate', title: 'Queue', tier: 3, detected_at: 1 }).returning({ id: schema.pulseEvents.id });
    as('admin', null);
    expect((await patch({ id, action: 'confirm', value })).status).toBe(200);
    expect(Number((await event(id)).value_amount)).toBe(5_000_000);
  });
});
