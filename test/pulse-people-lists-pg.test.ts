// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The "See who" lists behind Work Pulse's headline figures: each list is exactly
// the people its card counts (one row per person per product), on every view,
// and a contributor role sees its own department only.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';

const session: { authenticated: boolean; role: string; email: string; department: string | null } = {
  authenticated: true, role: 'admin', email: 'me@test.com', department: null,
};
vi.mock('@/lib/auth/admin-auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/admin-auth')>();
  return { ...actual, getAdminSession: async () => ({ ...session }) };
});

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const { createTestDbClient } = await import('./helpers/db');
  const h = await createTestDbClient('postgres');
  cleanup = h.cleanup;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = h.client;
  const { schema } = await import('@/lib/db/schema');
  await client.insert(schema.users).values([
    { id: 'a', email: 'a@corp.com', display_name: 'Ada', department: 'Sales' },
    { id: 'b', email: 'b@corp.com', display_name: 'Ben', department: 'Sales' },
    { id: 'c', email: 'c@corp.com', display_name: 'Cy', department: 'Legal' },
    { id: 'd', email: 'd@corp.com', display_name: 'Dee', department: 'Legal' },
  ]);
  // [user, source, tier, count]: Ada deep on Claude, admin-only on ChatGPT; Ben admin-only on
  // Claude; Cy frontier on Claude; Dee frontier on ChatGPT.
  const work: Array<[string, string, number, number]> = [
    ['a', 'otel', 3, 6], ['a', 'chatgpt_chat', 1, 2], ['b', 'otel', 1, 3],
    ['c', 'otel', 3, 2], ['d', 'chatgpt_chat', 3, 4],
  ];
  let i = 0;
  for (const [user, source, tier, n] of work) {
    for (let k = 0; k < n; k++) {
      const id = `m${i++}`;
      await client.insert(schema.coworkMessages).values({
        id, session_id: `${source === 'otel' ? '' : 'chatgpt:'}s-${user}`, user_id: user, message_type: 'cowork_user_message',
        surface: 'cowork', source, occurred_at: NOW - 2 * DAY,
      });
      await client.insert(schema.pulseClassifications).values({
        cowork_message_id: id, user_id: user, tier, task_type: 'analysis', classifier_status: 'classified',
        classifier_confidence: 0.9, classifier_model: 'test', classified_at: NOW - 2 * DAY,
      });
    }
  }
}, 120_000);

afterAll(async () => cleanup?.());

async function card(vendor: string) {
  const { GET } = await import('../app/api/pulse/org-summary/route');
  return (await (await GET(new NextRequest(`http://localhost/api/pulse/org-summary?vendor=${vendor}`))).json()).dashboard;
}
async function people(list: string, vendor: string) {
  const { GET } = await import('../app/api/pulse/people/route');
  const res = await GET(new NextRequest(`http://localhost/api/pulse/people?list=${list}&vendor=${vendor}`));
  return { status: res.status, body: await res.json() };
}

describe('See who lists', () => {
  it('match their cards on All, Claude and ChatGPT', async () => {
    for (const vendor of ['all', 'claude', 'openai']) {
      const d = await card(vendor);
      const adminOnly = (await people('admin-only', vendor)).body.people;
      const half = (await people('frontier-half', vendor)).body.people;
      expect(adminOnly.length).toBe(d.activePeople30d - d.deepPeople30d);
      expect(half.length).toBe(d.frontierHalfPeople ?? 0);
    }
  });

  it('names the right people, one row per person per product', async () => {
    const adminOnly = (await people('admin-only', 'all')).body.people.map((p: { name: string; product: string }) => `${p.name}:${p.product}`).sort();
    expect(adminOnly).toEqual(['Ada:openai', 'Ben:claude']);
    const half = (await people('frontier-half', 'all')).body.people.map((p: { name: string; product: string }) => `${p.name}:${p.product}`).sort();
    expect(half).toEqual(['Ada:claude', 'Dee:openai']);
  });

  it('shows a contributor role its own department only, and refuses an unknown list', async () => {
    session.role = 'cowork'; session.department = 'Legal';
    try {
      const half = (await people('frontier-half', 'all')).body.people.map((p: { name: string }) => p.name).sort();
      expect(half).toEqual(['Cy', 'Dee']);
      expect((await people('nope', 'all')).status).toBe(400);
    } finally { session.role = 'admin'; session.department = null; }
  });
});
