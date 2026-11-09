// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The admin pages with ChatGPT and Codex connected, on Postgres: User Insights
// names each person's main product and splits their days by product, the CSV
// export carries and filters by product, clearing the Audit Log clears the
// OpenAI metadata that goes with the prompts, and a sensitive file attached
// to a ChatGPT message raises the same file-upload alert as Claude Cowork.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

vi.mock('@/lib/auth/admin-auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/admin-auth')>();
  return {
    ...actual,
    getAdminSession: vi.fn(async () => ({ authenticated: true, role: 'admin', email: 'admin@test.local', userId: 'admin1' })),
  };
});

let sql: TestSql;
let cleanup: () => Promise<void>;
const NOW = Math.floor(Date.now() / 1000);
const TODAY = new Date(NOW * 1000).toISOString().slice(0, 10);

async function msg(id: string, user: string, surface: string, source: string, at = NOW - 3600) {
  await sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, content_preview, occurred_at)
    VALUES (?, ?, ?, 'cowork_user_message', ?, ?, ?, ?)`, [id, `s-${id}`, user, surface, source, `prompt ${id}`, at]);
}

beforeAll(async () => {
  const t = await createTestDatabase();
  sql = t.sql;
  cleanup = t.cleanup;
  await sql.run(`INSERT INTO users (id, email, display_name) VALUES
    ('mix', 'mix@test.local', 'Mix'), ('cdx', 'cdx@test.local', 'Cdx'), ('snap', 'snap@test.local', 'Snap')`);
  // Mix: 2 Claude Cowork prompts, 3 ChatGPT Chat prompts.
  await msg('m1', 'mix', 'cowork', 'otel');
  await msg('m2', 'mix', 'cowork', 'otel');
  for (const i of [1, 2, 3]) await msg(`g${i}`, 'mix', 'cowork', 'chatgpt_chat');
  // Cdx: Codex only.
  await msg('x1', 'cdx', 'code', 'codex');
  await msg('x2', 'cdx', 'code', 'codex');
  // Snap: Claude from the Analytics API (10 Claude Code), Codex from events,
  // and a Claude Code event the snapshot already counts.
  await sql.run(`INSERT INTO analytics_snapshots (id, user_id, snapshot_date, messages_sent, surface_code) VALUES ('a1', 'snap', ?, 10, 10)`, [TODAY]);
  await msg('k1', 'snap', 'code', 'otel');
  for (const i of [1, 2, 3, 4]) await msg(`c${i}`, 'snap', 'code', 'codex');
});
afterAll(async () => cleanup());

describe('User Insights with ChatGPT and Codex', () => {
  it('names each person\'s main product', async () => {
    const { getAllUserPrimarySurfaces, getUserPrimarySurface } = await import('@/lib/db/queries');
    const all = await getAllUserPrimarySurfaces();
    expect(all.get('mix')).toBe('ChatGPT Chat');
    expect(all.get('cdx')).toBe('Codex');
    expect(all.get('snap')).toBe('Claude Code');
    expect(await getUserPrimarySurface('cdx')).toBe('Codex');
  });

  it('counts OpenAI events for a person whose Claude figures come from the Analytics API', async () => {
    const { getAllUserMessageCounts7d, getUserMessageCount7d } = await import('@/lib/db/queries');
    expect((await getAllUserMessageCounts7d()).get('snap')).toBe(14);
    expect(await getUserMessageCount7d('snap')).toBe(14);
    expect(await getUserMessageCount7d('mix')).toBe(5);
  });

  it('splits a person\'s days by product, Claude from the snapshot without counting it twice', async () => {
    const { getUserProductDays } = await import('@/lib/db/queries');
    const days = await getUserProductDays('snap', 30);
    const totals = days.reduce((t, d) => {
      for (const [k, v] of Object.entries(d.counts)) t[k] = (t[k] ?? 0) + v;
      return t;
    }, {} as Record<string, number>);
    expect(totals.claude_code).toBe(10);
    expect(totals.codex).toBe(4);
    const mix = await getUserProductDays('mix', 30);
    expect(mix.reduce((n, d) => n + d.counts.chatgpt_chat, 0)).toBe(3);
    expect(mix.reduce((n, d) => n + d.counts.claude_cowork, 0)).toBe(2);
  });
});

describe('CSV export by product', () => {
  const csv = async (q: string) => {
    const { GET } = await import('@/app/api/admin/export/route');
    const res = await GET(new NextRequest(`http://localhost/api/admin/export?${q}`));
    expect(res.status).toBe(200);
    return (await res.text()).split('\r\n');
  };

  it('carries a Product column', async () => {
    const lines = await csv('surface=all');
    expect(lines[0]).toBe('Timestamp (UTC),User,Department,Surface,Product,Event Type,Content Preview');
    expect(lines.some(l => l.includes(',cowork,ChatGPT Chat,') && l.endsWith('prompt g1'))).toBe(true);
    expect(lines.some(l => l.includes(',code,Codex,') && l.endsWith('prompt x1'))).toBe(true);
    expect(lines.some(l => l.includes(',cowork,Claude Cowork,') && l.endsWith('prompt m1'))).toBe(true);
  });

  it('filters to one product', async () => {
    const codex = (await csv('product=codex')).slice(1);
    expect(codex).toHaveLength(6);
    expect(codex.every(l => l.includes(',Codex,'))).toBe(true);
    const chatgpt = (await csv('product=chatgpt_chat')).slice(1);
    expect(chatgpt).toHaveLength(3);
  });
});

describe('a sensitive file attached in ChatGPT', () => {
  it('raises the file-upload alert, naming ChatGPT, once', async () => {
    const { importOpenAiFiles } = await import('@/lib/openai/sync');
    const at = new Date((NOW - 600) * 1000).toISOString();
    const record = {
      event_id: 'evt-f1',
      type: 'CONVERSATION_MESSAGE',
      timestamp: at,
      actor: { type: 'ACCOUNT_USER', user_id: 'user-f', user_email: 'files@test.local' },
      message: {
        id: 'msg-f1',
        created_at: at,
        author: { type: 'user', client_type: 'web' },
        content: { type: 'text', value: 'Tidy up this export for me.' },
        files: [{ id: 'file-1', name: 'customers.sql' }, { id: 'file-2', name: 'notes.pdf' }],
      },
      conversation: { id: 'conv-f', mode: 'chat' },
    };
    await importOpenAiFiles([[record]], NOW);
    const alerts = async () => sql.all<{ title: string; explanation: string; severity: string }>(
      `SELECT title, explanation, severity FROM alerts WHERE alert_type = 'policy' AND raw_evidence->>'filename' = 'customers.sql'`);
    await vi.waitFor(async () => expect(await alerts()).toHaveLength(1));
    const [a] = await alerts();
    expect(a.title).toBe('Sensitive file uploaded to ChatGPT: SQL database dump');
    expect(a.explanation).toContain('"customers.sql" was uploaded to a ChatGPT Chat conversation.');
    // The same record again is a repeat: stored once, no second alert.
    await importOpenAiFiles([[record]], NOW);
    await new Promise(r => setTimeout(r, 200));
    expect(await alerts()).toHaveLength(1);
  });
});

describe('Clear Audit Log & Alerts', () => {
  it('clears the ChatGPT and Codex metadata with the prompts', async () => {
    await sql.run(`INSERT INTO openai_replies (id, user_id, session_id, source, occurred_at) VALUES ('r1', 'mix', 's-g1', 'chatgpt_chat', ?)`, [NOW]);
    await sql.run(`INSERT INTO chatgpt_session_time (session_id, user_id, source, first_at, last_at, computed_at) VALUES ('s-g1', 'mix', 'chatgpt_chat', ?, ?, ?)`, [NOW, NOW, NOW]);
    await sql.run(`INSERT INTO codex_turns (id, user_id, session_id, started_at) VALUES ('t1', 'cdx', 's-x1', ?)`, [NOW]);
    await sql.run(`INSERT INTO codex_actions (id, user_id, session_id, occurred_at) VALUES ('ac1', 'cdx', 's-x1', ?)`, [NOW]);
    await sql.run(`INSERT INTO openai_costs (id, user_id, hour_start, product, billed_in) VALUES ('oc1', 'mix', ?, 'chatgpt', 'usd')`, [NOW]);
    const { clearAuditAndAlerts } = await import('@/lib/admin/clear-data');
    const counts = await clearAuditAndAlerts();
    for (const table of ['openai_replies', 'chatgpt_session_time', 'codex_turns', 'codex_actions', 'openai_costs']) {
      expect(counts[table]).toBe(1);
      expect((await sql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))[0].n).toBe(0);
    }
  });
});
