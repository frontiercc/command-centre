// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The Alerts page is open to admins, managers and viewers. A personal-data
// alert's evidence keeps the first 200 characters of the person's prompt, and
// that quote now follows the Audit Log rule: admins see it for everyone, a
// manager for their own department (everyone when they have none), viewers
// never. The masked value and every other field stay. Real Postgres; only auth
// and the access log are mocked.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

let session: { authenticated: boolean; role?: string; email?: string; userId?: string; department?: string | null };

vi.mock('@/lib/auth/admin-auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/admin-auth')>();
  return { ...actual, getAdminSession: async () => session };
});
const logAccess = vi.fn<(e: { resource: string }) => Promise<void>>(async () => {});
vi.mock('@/lib/audit/log', () => ({ logAccess: (e: { resource: string }) => logAccess(e) }));

let cleanup: () => Promise<void>;
const as = (role: string, department: string | null) => {
  session = { authenticated: true, role, email: `${role}@t.test`, userId: `sess-${role}`, department };
};
const req = (url: string) => new NextRequest(`http://localhost${url}`);

const pii = (user: string, quote: string) => ({
  surface: 'cowork', message_id: `m-${user}`, pii_type: 'uk_phone', masked_value: '07*** ***123', evidence: quote,
});

beforeAll(async () => {
  const { createTestDbClient } = await import('./helpers/db');
  const h = await createTestDbClient('postgres');
  cleanup = h.cleanup;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = h.client;
  const { schema } = await import('@/lib/db/schema');

  await client.insert(schema.users).values([
    { id: 'fin1', email: 'fin1@t.test', display_name: 'Fiona', department: 'Finance' },
    { id: 'sal1', email: 'sal1@t.test', display_name: 'Sam', department: 'Sales' },
  ]);
  await client.insert(schema.alerts).values([
    { id: 'a-fin', user_id: 'fin1', alert_type: 'policy', severity: 'high', title: 'Fin PII', explanation: 'x', raw_evidence: pii('fin1', 'FIN PROMPT call 07700 900123') },
    { id: 'a-sal', user_id: 'sal1', alert_type: 'policy', severity: 'high', title: 'Sales PII', explanation: 'x', raw_evidence: pii('sal1', 'SALES PROMPT call 07700 900123') },
    { id: 'a-none', user_id: null, alert_type: 'policy', severity: 'high', title: 'No person PII', explanation: 'x', raw_evidence: pii('none', 'ORPHAN PROMPT') },
    { id: 'a-cost', user_id: 'fin1', alert_type: 'anomaly', severity: 'medium', title: 'Cost spike', explanation: 'x', raw_evidence: { source: 'code_pulse', spend_24h: 12 } },
  ]);
}, 120_000);

afterAll(async () => cleanup?.());
beforeEach(() => logAccess.mockClear());

type Row = { id: string; raw_evidence: string | null };
async function list(): Promise<Record<string, Record<string, unknown>>> {
  const { GET } = await import('../app/api/alerts/route');
  const res = await GET(req('/api/alerts'));
  expect(res.status).toBe(200);
  const rows = (await res.json()) as Row[];
  return Object.fromEntries(rows.map(r => [r.id, JSON.parse(r.raw_evidence ?? '{}')]));
}
const evidenceReads = () => logAccess.mock.calls.filter(c => c[0].resource === 'alerts/evidence').length;

describe('/api/alerts evidence quote', () => {
  it('a viewer sees every alert and its masked value, but no prompt quote, and no prompt read is logged', async () => {
    as('viewer', null);
    const ev = await list();
    expect(Object.keys(ev).sort()).toEqual(['a-cost', 'a-fin', 'a-none', 'a-sal']);
    for (const id of ['a-fin', 'a-sal', 'a-none']) {
      expect(ev[id].evidence).toBeUndefined();
      expect(ev[id].masked_value).toBe('07*** ***123');
      expect(ev[id].pii_type).toBe('uk_phone');
    }
    expect(ev['a-cost']).toEqual({ source: 'code_pulse', spend_24h: 12 });
    expect(evidenceReads()).toBe(0);
  });

  it('a Sales manager sees the Sales quote only, and the read is logged', async () => {
    as('manager', 'Sales');
    const ev = await list();
    expect(ev['a-sal'].evidence).toContain('SALES PROMPT');
    expect(ev['a-fin'].evidence).toBeUndefined();
    expect(ev['a-none'].evidence).toBeUndefined();
    expect(ev['a-fin'].masked_value).toBe('07*** ***123');
    expect(evidenceReads()).toBe(1);
  });

  it('an admin sees every quote', async () => {
    as('admin', null);
    const ev = await list();
    expect(ev['a-fin'].evidence).toContain('FIN PROMPT');
    expect(ev['a-sal'].evidence).toContain('SALES PROMPT');
    expect(ev['a-none'].evidence).toBe('ORPHAN PROMPT');
  });

  it('a manager with no department sees no quote', async () => {
    as('manager', null);
    const ev = await list();
    expect(ev['a-fin'].evidence).toBeUndefined();
    expect(ev['a-sal'].evidence).toBeUndefined();
  });

  it('the single-alert view follows the same rule', async () => {
    const { GET } = await import('../app/api/alerts/route');
    as('viewer', null);
    const viewer = JSON.parse((await (await GET(req('/api/alerts?id=a-fin'))).json()).raw_evidence);
    expect(viewer.evidence).toBeUndefined();
    expect(viewer.masked_value).toBe('07*** ***123');
    as('manager', 'Finance');
    const manager = JSON.parse((await (await GET(req('/api/alerts?id=a-fin'))).json()).raw_evidence);
    expect(manager.evidence).toContain('FIN PROMPT');
  });

  it('the stored alert is unchanged', async () => {
    as('viewer', null);
    await list();
    const { getAlertById } = await import('@/lib/db/queries');
    const stored = await getAlertById('a-fin');
    expect(JSON.parse(stored!.raw_evidence!).evidence).toContain('FIN PROMPT');
  });
});
