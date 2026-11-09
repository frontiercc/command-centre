// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The per-vendor tables (pulse_metrics_vendor, code_metrics_vendor) only gain
// a week while the aggregator runs in it, so a vendor view had no past weeks:
// the weekly volume, Delegation View and Developer Pulse's 8-week trends read
// empty. Both aggregators now recount every completed week that gained data
// since their last run (newly graded prompts; changed sessions), bounded to
// each week, and leave other weeks alone. Also: the Work Pulse department
// list shows a member only their own department.
// POSTGRES ONLY.
import { describe, it, expect, vi } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';
import { weekStart } from '@/lib/pulse/period';

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({ messages: { create: vi.fn() } })),
}));

const session = { authenticated: true, role: 'admin', email: 'me@example.org', department: null as string | null };
vi.mock('@/lib/auth/admin-auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/admin-auth')>();
  return { ...actual, getAdminSession: async () => ({ ...session }) };
});

const NOW = Math.floor(Date.now() / 1000);
const WEEK = 7 * 86400;
const THIS_WEEK = weekStart(NOW);
// Midday Wednesday of two and three weeks ago: well inside each week.
const W2 = THIS_WEEK - 2 * WEEK;
const W3 = THIS_WEEK - 3 * WEEK;
const mid = (week: number) => week + 2 * 86400 + 12 * 3600;

async function people(sql: TestSql): Promise<void> {
  await sql.run(`INSERT INTO users (id, email, display_name, source, department, first_seen_at, last_seen_at) VALUES
    ('u-ana', 'ana@example.org', 'Ana', 'otel', 'Finance', 1, ?),
    ('u-ben', 'ben@example.org', 'Ben', 'openai', 'Sales', 1, ?)`, [NOW, NOW]);
  await sql.run(`INSERT INTO admin_users (id, email, password_hash, role, department, linked_cowork_user_id) VALUES
    ('a-ana', 'ana@example.org', '__otel_pending__', 'pulse', 'Finance', 'u-ana'),
    ('a-ben', 'ben@example.org', '__otel_pending__', 'pulse', 'Sales', 'u-ben')`);
}

async function prompt(sql: TestSql, id: string, user: string, source: string, at: number, tier: number, gradedAt = NOW - 3600): Promise<void> {
  await sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, occurred_at)
    VALUES (?, ?, ?, 'cowork_user_message', 'cowork', ?, ?)`, [id, `s-${id}`, user, source, at]);
  await sql.run(`INSERT INTO pulse_classifications (cowork_message_id, user_id, tier, task_type, classifier_confidence, classifier_model, classified_at)
    VALUES (?, ?, ?, 'analysis', 0.9, 'test', ?)`, [id, user, tier, gradedAt]);
}

describe('Work Pulse per-vendor past weeks', () => {
  it('counts past weeks from the prompts, recounts a week that gains a late prompt, and leaves other weeks alone', async () => {
    const { sql, cleanup } = await createTestDatabase();
    try {
      await people(sql);
      // Ana on Claude: two prompts three weeks ago, one two weeks ago, one now.
      await prompt(sql, 'c1', 'u-ana', 'otel', mid(W3), 3);
      await prompt(sql, 'c2', 'u-ana', 'otel', mid(W3), 1);
      await prompt(sql, 'c3', 'u-ana', 'otel', mid(W2), 2);
      await prompt(sql, 'c4', 'u-ana', 'otel', NOW - 60, 2);
      // Ben on ChatGPT: one prompt three weeks ago, one now.
      await prompt(sql, 'o1', 'u-ben', 'chatgpt_chat', mid(W3), 2);
      await prompt(sql, 'o2', 'u-ben', 'chatgpt_chat', NOW - 60, 1);

      const { runHourlyAggregation } = await import('@/lib/pulse/aggregator');
      await runHourlyAggregation();

      type Row = { vendor: string; scope_type: string; scope_id: string; period_start: number; event_count: number; tier_3_count: number };
      const read = () => sql.all<Row>(
        `SELECT vendor, scope_type, scope_id, period_start, event_count, tier_3_count FROM pulse_metrics_vendor
          WHERE granularity = 'week' AND period_start < ? ORDER BY vendor, scope_type, scope_id, period_start`, [THIS_WEEK]);
      expect(await read()).toEqual([
        { vendor: 'claude', scope_type: 'function', scope_id: 'Finance', period_start: W3, event_count: 2, tier_3_count: 1 },
        { vendor: 'claude', scope_type: 'function', scope_id: 'Finance', period_start: W2, event_count: 1, tier_3_count: 0 },
        { vendor: 'claude', scope_type: 'user', scope_id: 'u-ana', period_start: W3, event_count: 2, tier_3_count: 1 },
        { vendor: 'claude', scope_type: 'user', scope_id: 'u-ana', period_start: W2, event_count: 1, tier_3_count: 0 },
        { vendor: 'openai', scope_type: 'function', scope_id: 'Sales', period_start: W3, event_count: 1, tier_3_count: 0 },
        { vendor: 'openai', scope_type: 'user', scope_id: 'u-ben', period_start: W3, event_count: 1, tier_3_count: 0 },
      ]);

      // The overview's weekly volume has the past weeks in a vendor view.
      const { NextRequest } = await import('next/server');
      const { GET } = await import('../app/api/pulse/cio/route');
      const res = await GET(new NextRequest('http://localhost/api/pulse/cio?vendor=claude'));
      const body = await res.json() as { weeklyVolume: { series: Array<{ weekStart: number; eventCount: number }> } };
      const byWeek = new Map(body.weeklyVolume.series.map(w => [w.weekStart, w.eventCount]));
      expect(byWeek.get(W3)).toBe(2);
      expect(byWeek.get(W2)).toBe(1);

      // A week with nothing newly graded is left exactly as it is (77 marks "untouched").
      await sql.run(`UPDATE pulse_metrics_vendor SET event_count = 77 WHERE vendor = 'claude' AND scope_type = 'user' AND scope_id = 'u-ana' AND period_start = ? AND granularity = 'week'`, [W3]);
      // A late prompt for two weeks ago is graded now.
      await prompt(sql, 'c5', 'u-ana', 'otel', mid(W2), 3, Math.floor(Date.now() / 1000));
      await runHourlyAggregation();
      const after = await read();
      const ana = (week: number) => after.find(r => r.vendor === 'claude' && r.scope_type === 'user' && r.scope_id === 'u-ana' && r.period_start === week);
      expect(ana(W2)).toMatchObject({ event_count: 2, tier_3_count: 1 });
      expect(ana(W3)).toMatchObject({ event_count: 77 });
      expect(after.find(r => r.vendor === 'claude' && r.scope_type === 'function' && r.period_start === W2)).toMatchObject({ event_count: 2 });
    } finally {
      await cleanup();
    }
  });
});

describe('Developer Pulse per-product past weeks', () => {
  it('fills a completed week for all products, Claude Code and Codex, bounded to that week', async () => {
    const { sql, cleanup } = await createTestDatabase();
    try {
      await people(sql);
      const seedWeek = async (tag: string, at: number, codexUsd: number) => {
        await sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, occurred_at)
          VALUES (?, ?, 'u-ana', 'code_user_message', 'code', 'otel', ?)`, [`cc-p-${tag}`, `cc-s-${tag}`, at]);
        await sql.run(`INSERT INTO code_assistant_meta (id, user_id, session_id, model, input_tokens, output_tokens, tool_use_count, error_count, commit_count, occurred_at, source)
          VALUES (?, 'u-ana', ?, 'claude-sonnet-4-5', 1000, 200, 3, 0, 1, ?, 'otel')`, [`cc-a-${tag}`, `cc-s-${tag}`, at + 60]);
        await sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, occurred_at)
          VALUES (?, ?, 'u-ben', 'code_user_message', 'code', 'codex', ?)`, [`cx-p-${tag}`, `codex:${tag}`, at]);
        await sql.run(`INSERT INTO codex_actions (id, user_id, session_id, tool_name, failed, commit_count, occurred_at)
          VALUES (?, 'u-ben', ?, 'shell', 0, 1, ?)`, [`cx-a-${tag}`, `codex:${tag}`, at + 30]);
        await sql.run(`INSERT INTO codex_turns (id, user_id, session_id, model, started_at, uncached_input_tokens, cached_input_tokens, output_tokens, openai_cost_usd)
          VALUES (?, 'u-ben', ?, 'gpt-5.5-codex', ?, 1000000, 0, 100000, ?)`, [`cx-t-${tag}`, `codex:${tag}`, at, codexUsd]);
      };
      await seedWeek('past', mid(W2), 2.25);
      await seedWeek('now', NOW - 3 * 3600, 2.25);

      const { runCodeHourlyAggregation } = await import('@/lib/pulse/code/aggregator');
      await runCodeHourlyAggregation();

      const org = await sql.all<{ vendor: string; commit_count: number; session_count: number; output_tokens: number }>(
        `SELECT vendor, commit_count, session_count, output_tokens FROM code_metrics_vendor
          WHERE scope_type = 'organisation' AND granularity = 'week' AND period_start = ? ORDER BY vendor`, [W2]);
      // Only that week's sessions and turns: the current week's never leak in.
      expect(org).toEqual([
        { vendor: 'all', commit_count: 2, session_count: 2, output_tokens: 100200 },
        { vendor: 'claude', commit_count: 1, session_count: 1, output_tokens: 200 },
        { vendor: 'openai', commit_count: 1, session_count: 1, output_tokens: 100000 },
      ]);

      // A Claude Code session for that week arrives late: the week is recounted on the next run.
      await sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, occurred_at)
        VALUES ('cc-p-late', 'cc-s-late', 'u-ana', 'code_user_message', 'code', 'otel', ?)`, [mid(W2) + 3600]);
      await sql.run(`INSERT INTO code_assistant_meta (id, user_id, session_id, model, input_tokens, output_tokens, tool_use_count, error_count, commit_count, occurred_at, source)
        VALUES ('cc-a-late', 'u-ana', 'cc-s-late', 'claude-sonnet-4-5', 1000, 200, 3, 0, 1, ?, 'otel')`, [mid(W2) + 3660]);
      await runCodeHourlyAggregation();
      const late = await sql.all<{ vendor: string; commit_count: number; session_count: number }>(
        `SELECT vendor, commit_count, session_count FROM code_metrics_vendor
          WHERE scope_type = 'organisation' AND granularity = 'week' AND period_start = ? ORDER BY vendor`, [W2]);
      expect(late).toEqual([
        { vendor: 'all', commit_count: 3, session_count: 3 },
        { vendor: 'claude', commit_count: 2, session_count: 2 },
        { vendor: 'openai', commit_count: 1, session_count: 1 },
      ]);
    } finally {
      await cleanup();
    }
  });
});

describe('Work Pulse department list', () => {
  it("shows a member only their own department, and everyone to an admin", async () => {
    const { sql, cleanup } = await createTestDatabase();
    try {
      await people(sql);
      const { NextRequest } = await import('next/server');
      const { GET } = await import('../app/api/pulse/depts/route');
      const list = async () => ((await (await GET(new NextRequest('http://localhost/api/pulse/depts'))).json()) as { depts: Array<{ department: string }> }).depts.map(d => d.department);

      Object.assign(session, { role: 'admin', department: null });
      expect(await list()).toEqual(['Finance', 'Sales']);

      Object.assign(session, { role: 'pulse', department: 'Sales' });
      expect(await list()).toEqual(['Sales']);

      Object.assign(session, { role: 'pulse', department: null });
      expect((await GET(new NextRequest('http://localhost/api/pulse/depts'))).status).toBe(422);
    } finally {
      Object.assign(session, { role: 'admin', department: null });
      await cleanup();
    }
  });
});
