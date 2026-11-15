// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Ask the data on Postgres: only an admin can ask, and only when it is turned on; a question
// is answered from a real page lookup (alerts) whose data never carries the prompt behind an
// alert; the log keeps the question, lookups, outcome and cost but never the answer; the
// monthly cap stops questions once reached; old questions are pruned.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';

const session: { authenticated: boolean; role: string; email: string; userId: string; department: string | null } = {
  authenticated: true, role: 'admin', email: 'admin@test.com', userId: 'admin-1', department: null,
};
vi.mock('@/lib/auth/admin-auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/admin-auth')>();
  return {
    ...actual,
    getAdminSession: async () => ({ ...session }),
    requireAdmin: async () => (session.role === 'admin' ? { ...session } : null),
  };
});

// The model: asks the alerts lookup, then answers with the open count it read.
const sent: Array<{ messages: unknown }> = [];
let script: Array<object> = [];
vi.mock('@/lib/anthropic/client', () => ({
  createAnthropicClient: () => ({
    messages: {
      create: async (req: { messages: unknown }) => {
        sent.push({ messages: JSON.parse(JSON.stringify(req.messages)) });
        const next = script.shift();
        if (!next) throw new Error('no reply scripted');
        return { id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, ...next };
      },
    },
  }),
}));

const NOW = Math.floor(Date.now() / 1000);
let cleanup: () => Promise<void>;
let setConfigValue: typeof import('@/lib/config').setConfigValue;

beforeAll(async () => {
  const { createTestDbClient } = await import('./helpers/db');
  const h = await createTestDbClient('postgres');
  cleanup = h.cleanup;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db: any = h.client;
  const { schema } = await import('@/lib/db/schema');
  setConfigValue = (await import('@/lib/config')).setConfigValue;
  await setConfigValue('anthropicAiApiKey', 'sk-test');
  await db.insert(schema.users).values({ id: 'u1', email: 'ben@corp.com', display_name: 'Ben Okonkwo', department: 'Sales' });
  await db.insert(schema.alerts).values({
    id: 'a1', user_id: 'u1', alert_type: 'intent', severity: 'critical', title: 'Shadow IT intent detected in Codex',
    explanation: 'The request asks to export the customer table to a personal drive', raw_evidence: { product: 'Codex' }, status: 'open', generated_at: NOW - 3600,
  });
  // A PII alert that records the message but not the product: the product comes from the message.
  await db.insert(schema.coworkMessages).values({ id: 'chatgpt:m1-p', session_id: 'chatgpt:m1', user_id: 'u1', message_type: 'cowork_user_message', surface: 'cowork', source: 'chatgpt_chat', occurred_at: NOW - 7200 });
  await db.insert(schema.alerts).values({
    id: 'a2', user_id: 'u1', alert_type: 'policy', severity: 'high', title: 'Email address detected',
    explanation: 'x', raw_evidence: { surface: 'cowork', pii_type: 'email', message_id: 'chatgpt:m1-p', masked_value: 'b***@corp.com' }, status: 'resolved', generated_at: NOW - 7000,
  });
}, 120_000);
afterAll(async () => cleanup?.());

async function ask(question: string) {
  const { POST } = await import('../app/api/ask/route');
  const res = await POST(new NextRequest('http://localhost/api/ask', { method: 'POST', body: JSON.stringify({ question, page: '/alerts' }) }));
  return { status: res.status, body: await res.json() };
}

describe('Ask the data', () => {
  it('is refused to anyone but an admin, and is off until turned on', async () => {
    session.role = 'manager';
    try { expect((await ask('How many alerts?')).status).toBe(403); } finally { session.role = 'admin'; }
    const { GET } = await import('../app/api/ask/route');
    expect(await (await GET(new NextRequest('http://localhost/api/ask'))).json()).toMatchObject({ available: false, enabled: false });
    expect((await ask('How many alerts?')).status).toBe(409);
  });

  it('is turned on through /api/config as the admin page saves it', async () => {
    const { POST } = await import('../app/api/config/route');
    const res = await POST(new NextRequest('http://localhost/api/config', { method: 'POST', body: JSON.stringify({ askEnabled: 'true', askMonthlyCapUsd: '5', askLogRetentionDays: '90' }) }));
    expect(res.status).toBe(200);
    const { GET } = await import('../app/api/ask/route');
    expect(await (await GET(new NextRequest('http://localhost/api/ask'))).json()).toMatchObject({ available: true, enabled: true });
  });

  it('answers from the alerts page, never sees the prompt behind an alert, and logs no answer', async () => {
    script = [
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'alerts', input: { status: 'open' } }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'There is 1 open alert: a critical Shadow IT alert in Codex.', citations: null }] },
    ];
    const r = await ask('How many critical alerts are open?');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ outcome: 'answered', answer: 'There is 1 open alert: a critical Shadow IT alert in Codex.', sources: [{ label: 'Alerts', href: '/alerts' }] });

    // What the model read: the alert's type, severity, person and product, never its explanation.
    const seen = JSON.stringify(sent[sent.length - 1].messages);
    expect(seen).toContain('Shadow IT intent detected in Codex');
    expect(seen).toContain('Codex');
    expect(seen).not.toContain('customer table');
    // The open-alerts lookup is filtered to open, so read every alert to check the PII one.
    const { runLookup } = await import('@/lib/ask/lookups');
    const all = JSON.stringify((await runLookup('alerts', {}, { request: new NextRequest('http://localhost/api/ask') })).data);
    expect(all).toContain('"title":"Email address detected"');
    expect(all).toContain('"product":"ChatGPT Chat"');
    expect(all).toContain('"by_product":{"Codex":1,"ChatGPT Chat":1}');
    expect(all).not.toContain('b***@corp.com');

    const { GET } = await import('../app/api/admin/ask/route');
    const admin = await (await GET(new NextRequest('http://localhost/api/admin/ask'))).json();
    expect(admin.model).toBe('claude-haiku-5-5');
    expect(admin.questions[0]).toMatchObject({ question: 'How many critical alerts are open?', page: '/alerts', lookups: ['alerts'], outcome: 'answered' });
    // 1000 + 1000 input and 100 + 100 output tokens at $0.10 / $0.50 per million.
    expect(admin.questions[0].costUsd).toBeCloseTo(0.0003, 6);
    expect(JSON.stringify(admin)).not.toContain('Shadow IT alert in Codex.');
    expect(admin.month.outcomes).toMatchObject({ answered: 1 });
  });

  it('stops at the monthly cap, and prunes questions past the retention window', async () => {
    const { getTypedClient } = await import('@/lib/db/client');
    const { schema } = await import('@/lib/db/schema');
    const db = await getTypedClient();
    await db.insert(schema.askLog).values({ id: 'old', asked_at: NOW - 200 * 86400, asked_by: 'admin@test.com', question: 'old one', lookups_json: '[]', outcome: 'answered', model: 'claude-haiku-5-5', cost_usd: '0.01' });
    await setConfigValue('askMonthlyCapUsd', '0.0001');
    const r = await ask('Anything new?');
    expect(r.body.outcome).toBe('capped');
    expect(r.body.answer).toContain('spend cap');
    const rows = await db.select().from(schema.askLog);
    expect(rows.map(x => x.question)).not.toContain('old one');
    expect(rows.find(x => x.question === 'Anything new?')?.outcome).toBe('capped');
  });
});
