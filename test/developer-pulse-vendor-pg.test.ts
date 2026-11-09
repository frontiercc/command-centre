// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Developer Pulse by product: Codex actions, failures and commits count in the
// per-product figures (code_metrics_vendor) and never in code_metrics, which
// the digest, Reports and Highlights read; the routes follow the All / Claude
// / Codex switch; the Codex classify switch empties Codex from the queue.
// POSTGRES ONLY.
import { describe, it, expect, vi } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';
import { isGitCommit, interpretCodexAction } from '@/lib/openai/sync';

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({ messages: { create: vi.fn() } })),
}));

vi.mock('@/lib/auth/admin-auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/admin-auth')>();
  return { ...actual, getAdminSession: async () => ({ authenticated: true, role: 'admin', email: 'me@example.org' }) };
});

const NOW = Math.floor(Date.now() / 1000);

async function get(path: string) {
  const { NextRequest } = await import('next/server');
  const mod = path.startsWith('/api/pulse/code/org-summary')
    ? await import('../app/api/pulse/code/org-summary/route')
    : await import('../app/api/pulse/code/me/route');
  const res = await mod.GET(new NextRequest(`http://localhost${path}`));
  return res.json();
}

/** One Claude Code session with a commit and three tool calls, one Codex session with six actions. */
async function seed(sql: TestSql): Promise<void> {
  await sql.run(`INSERT INTO users (id, email, display_name, source, first_seen_at, last_seen_at) VALUES
    ('u-claude', 'ana@example.org', 'Ana', 'otel', 1, ?),
    ('u-codex', 'ben@example.org', 'Ben', 'openai', 1, ?)`, [NOW, NOW]);
  const t = NOW - 3 * 3600;
  // Claude Code
  await sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, occurred_at)
    VALUES ('cc-p1', 'cc-s1', 'u-claude', 'code_user_message', 'code', 'otel', ?)`, [t]);
  await sql.run(`INSERT INTO code_assistant_meta (id, user_id, session_id, model, input_tokens, output_tokens, tool_use_count, error_count, commit_count, occurred_at, source)
    VALUES ('cc-a1', 'u-claude', 'cc-s1', 'claude-sonnet-4-5', 1000, 200, 3, 0, 1, ?, 'otel')`, [t + 60]);
  // Codex: one prompt, six actions (one failed, one commit), one turn.
  await sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, occurred_at)
    VALUES ('cx-p1', 'codex:s1', 'u-codex', 'code_user_message', 'code', 'codex', ?)`, [t]);
  for (let i = 0; i < 6; i++) {
    await sql.run(`INSERT INTO codex_actions (id, user_id, session_id, tool_name, failed, commit_count, occurred_at)
      VALUES (?, 'u-codex', 'codex:s1', 'shell', ?, ?, ?)`, [`cx-a${i}`, i === 0 ? 1 : 0, i === 5 ? 1 : 0, t + 30 * (i + 1)]);
  }
  await sql.run(`INSERT INTO codex_turns (id, user_id, session_id, model, started_at, uncached_input_tokens, cached_input_tokens, output_tokens, openai_cost_usd)
    VALUES ('cx-t1', 'u-codex', 'codex:s1', 'gpt-5.5-codex', ?, 1000000, 0, 100000, 2.25)`, [t]);
}

describe('Developer Pulse by product', () => {
  it('keeps Codex out of code_metrics and counts it in the per-product figures', async () => {
    const { sql, cleanup } = await createTestDatabase();
    try {
      await seed(sql);
      const { setConfigValue } = await import('@/lib/config');
      // Codex priced from the rates table: $1.25 in, $10 out per million.
      await setConfigValue('codeModelRates', JSON.stringify({ 'gpt-5.5-codex': { in: 1.25, out: 10, cacheWrite: 1.25, cacheRead: 0.125 } }));
      const { runCodeHourlyAggregation } = await import('@/lib/pulse/code/aggregator');
      await runCodeHourlyAggregation();

      // code_metrics as before: Codex's actions and commits are not in it.
      const base = await sql.all<{ commit_count: number; session_count: number }>(
        `SELECT commit_count, session_count FROM code_metrics WHERE scope_type = 'organisation' AND granularity = 'rolling'`);
      expect(base[0].commit_count).toBe(1);

      const byVendor = await sql.all<{ vendor: string; session_count: number; commit_count: number; autonomy_ratio: number; friction_index: number; spend_usd: number }>(
        `SELECT vendor, session_count, commit_count, autonomy_ratio, friction_index, spend_usd FROM code_metrics_vendor
          WHERE scope_type = 'organisation' AND granularity = 'rolling' ORDER BY vendor`);
      const v = Object.fromEntries(byVendor.map(r => [r.vendor, r]));
      expect(v.openai).toMatchObject({ session_count: 1, commit_count: 1, autonomy_ratio: 6, friction_index: 1 / 6 });
      expect(v.openai.spend_usd).toBeCloseTo(2.25, 4);                    // 1M in × $1.25 + 0.1M out × $10
      expect(v.claude).toMatchObject({ session_count: 1, commit_count: 1, autonomy_ratio: 3 });
      expect(v.all).toMatchObject({ session_count: 2, commit_count: 2 });
      expect(v.all.spend_usd).toBeCloseTo(v.claude.spend_usd + 2.25, 4);
      // A Codex-only person gets a Codex row and no Claude Code row.
      const people = await sql.all<{ vendor: string }>(
        `SELECT vendor FROM code_metrics_vendor WHERE scope_type = 'user' AND scope_id = 'u-codex' AND granularity = 'rolling' ORDER BY vendor`);
      expect(people.map(p => p.vendor)).toEqual(['all', 'openai']);

      // The overview follows the switch.
      const codex = await get('/api/pulse/code/org-summary?vendor=openai');
      expect(codex.codexPresent).toBe(true);
      expect(codex.metrics.session_count).toBe(1);
      expect(codex.modelMix.map((m: { model: string }) => m.model)).toEqual(['gpt-5.5-codex']);
      const claude = await get('/api/pulse/code/org-summary?vendor=claude');
      expect(claude.modelMix.map((m: { model: string }) => m.model)).toEqual(['claude-sonnet-4-5']);
      expect(claude.metricsSplit).toBeNull();
      const all = await get('/api/pulse/code/org-summary?vendor=all');
      expect(all.metrics.session_count).toBe(2);
      expect(all.metricsSplit.claude.session_count).toBe(1);
      expect(all.metricsSplit.openai.commit_count).toBe(1);

      // A Codex session is tagged Codex, with its turn's spend.
      const me = await get('/api/pulse/code/me?userId=u-codex&vendor=all');
      expect(me.sessions[0]).toMatchObject({ session_id: 'codex:s1', source: 'codex' });
      expect(me.sessions[0].spend_usd).toBeCloseTo(2.25, 4);
      // A Codex-only person has no Claude Code figures: never Codex's borrowed.
      expect(me.metricsSplit.claude).toBeNull();
      expect(me.metricsSplit.openai.session_count).toBe(1);
      const meClaude = await get('/api/pulse/code/me?userId=u-codex&vendor=claude');
      expect(meClaude.metrics).toBeNull();

      // Erasure removes the person's Codex actions and per-product rows.
      const { deleteUserData } = await import('@/lib/db/queries');
      await deleteUserData('u-codex');
      const left = await sql.all<{ n: number }>(
        `SELECT (SELECT COUNT(*) FROM codex_actions WHERE user_id = 'u-codex')
              + (SELECT COUNT(*) FROM code_metrics_vendor WHERE scope_type = 'user' AND scope_id = 'u-codex') AS n`);
      expect(left[0].n).toBe(0);
    } finally {
      await cleanup();
    }
  }, 120_000);

  it('leaves Codex sessions out of the classifier queue when its switch is off', async () => {
    const { sql, cleanup } = await createTestDatabase();
    try {
      await seed(sql);
      const { runCodeHourlyAggregation } = await import('@/lib/pulse/code/aggregator');
      await runCodeHourlyAggregation();
      const { getClassifierQueueDepth } = await import('@/lib/pulse/code/classifier');
      const { setConfigValue } = await import('@/lib/config');
      expect((await getClassifierQueueDepth()).final).toBe(2);
      await setConfigValue('codeClassifyCodex', 'false');
      expect((await getClassifierQueueDepth()).final).toBe(1);
    } finally {
      await cleanup();
    }
  }, 120_000);

  it('writes no per-product rows on a Claude-only hub', async () => {
    const { sql, cleanup } = await createTestDatabase();
    try {
      await seed(sql);
      await sql.run(`DELETE FROM cowork_messages WHERE source = 'codex'`);
      await sql.run(`DELETE FROM codex_actions`);
      await sql.run(`DELETE FROM codex_turns`);
      const { runCodeHourlyAggregation } = await import('@/lib/pulse/code/aggregator');
      await runCodeHourlyAggregation();
      expect((await sql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM code_metrics_vendor`))[0].n).toBe(0);
      const overview = await get('/api/pulse/code/org-summary?vendor=all');
      expect(overview.codexPresent).toBe(false);
      expect(overview.metrics.session_count).toBe(1);
    } finally {
      await cleanup();
    }
  }, 120_000);
});

describe('Codex actions from the Codex log', () => {
  it('spots a git commit in each shape of tool input, and nothing else', () => {
    expect(isGitCommit(JSON.stringify({ command: ['git', 'commit', '-m', 'x'] }))).toBe(true);
    expect(isGitCommit({ command: 'git commit -am "x"' })).toBe(true);
    expect(isGitCommit(['bash', '-lc', 'git add . && git commit -m x'])).toBe(true);
    expect(isGitCommit(JSON.stringify({ command: ['git', 'status'] }))).toBe(false);
    expect(isGitCommit(JSON.stringify({ path: 'src/commit.ts' }))).toBe(false);
    expect(isGitCommit(undefined)).toBe(false);
  });

  it('reads a tool call, its failure and its commit, and skips ChatGPT Work', () => {
    const call = (event: string, client: string, input: unknown) => ({
      type: 'CODEX_LOG', event_id: 'e1', event_type: event, client_id: client, timestamp: '2026-10-30T14:00:00Z',
      actor: { user_email: 'ben@example.org' },
      event_details: { session_id: 's1', tool_name: 'shell', tool_input: JSON.stringify(input) },
    });
    const floors = { cowork: 0, code: 0 };
    expect(interpretCodexAction(call('TOOL_CALL_COMPLETED', 'CODEX_CLI', { command: ['git', 'commit', '-m', 'x'] }), floors))
      .toMatchObject({ id: 'codex-action:e1', sessionId: 'codex:s1', failed: false, commits: 1, toolName: 'shell' });
    expect(interpretCodexAction(call('TOOL_CALL_FAILED', 'CODEX_CLI', { command: ['git', 'commit'] }), floors))
      .toMatchObject({ failed: true, commits: 0 });
    expect(interpretCodexAction(call('TOOL_CALL_COMPLETED', 'CODEX_WORK_WEB', {}), floors)).toBeNull();
    expect(interpretCodexAction(call('PROMPT_SENT', 'CODEX_CLI', {}), floors)).toBeNull();
  });
});
