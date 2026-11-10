// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The OpenAI panel's two switches on Postgres.
//   Pause sync: the job skips its runs, the key and data kept.
//   Show ChatGPT and Codex: off makes the analytics read as Claude-only
//   (connected products, the vendor a route reads, FinOps, the S&C Board,
//   the By product panel), while the Audit Log still lists OpenAI's prompts.
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

const runOpenAiSync = vi.fn();
vi.mock('@/lib/openai/sync', () => ({ runOpenAiSync: (...a: unknown[]) => runOpenAiSync(...a) }));
vi.mock('@/lib/auth/admin-auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/admin-auth')>();
  return { ...actual, getAdminSession: async () => ({ authenticated: true, role: 'admin', userId: 'a1', email: 'a@x.test' }) };
});
vi.mock('@/lib/audit/log', () => ({ logAccess: vi.fn() }));

const MARCH_15 = Math.floor(Date.UTC(2026, 2, 15) / 1000);

async function runSpec(): Promise<void> {
  const { createTestDatabase } = await import('./helpers/db');
  const { sql, cleanup } = await createTestDatabase();
  try {
    const setConfig = (key: string, value: string) =>
      sql.run(`INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [key, value]);
    const nowS = Math.floor(Date.now() / 1000);
    const t = nowS - 86400;

    // ── Pause sync ──
    const { runOpenAiSyncJob } = await import('@/lib/openai/job');
    await setConfig('openai_admin_api_key', 'sk-admin-test');
    await setConfig('openai_workspace_id', 'ws-test');
    await setConfig('openai_sync_paused', 'true');
    expect(await runOpenAiSyncJob({ force: true })).toEqual({ skipped: true, stats: null });
    expect(runOpenAiSync).not.toHaveBeenCalled();
    await setConfig('openai_sync_paused', 'false');
    runOpenAiSync.mockResolvedValueOnce({ files: 0, records: 0, prompts: { chatgpt_chat: 0, chatgpt_work: 0, codex: 0 }, errors: [] });
    expect((await runOpenAiSyncJob({ force: true })).skipped).toBe(false);
    expect(runOpenAiSync).toHaveBeenCalledTimes(1);

    // ── Data: a Claude Cowork person and a ChatGPT person, both in Legal ──
    for (const [id, source] of [['u-claude', 'otel'], ['u-gpt', 'openai']]) {
      await sql.run(`INSERT INTO users (id, email, display_name, source, department, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, 'Legal', ?, ?)`,
        [id, `${id}@test.local`, id, source, t, t]);
    }
    await sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, content_full, occurred_at)
                   VALUES ('cw-1', 'cw-s', 'u-claude', 'cowork_user_message', 'cowork', 'otel', 'claude text', ?)`, [t]);
    await sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, content_full, occurred_at)
                   VALUES ('gw-1', 'chatgpt:w', 'u-gpt', 'cowork_user_message', 'cowork', 'chatgpt_work', 'gpt text', ?)`, [t]);
    await sql.run(`INSERT INTO code_assistant_meta (id, session_id, user_id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, occurred_at)
                   VALUES ('cam-1', 's-1', 'u-claude', 'claude-haiku-4-5', 1000000, 0, 0, 0, ?)`, [MARCH_15]);
    await sql.run(`INSERT INTO openai_costs (id, user_id, hour_start, product, model, input_tokens, cached_input_tokens, output_tokens, cost_usd, billed_in)
                   VALUES ('oc-1', 'u-gpt', ?, 'chatgpt', 'gpt-6.1-terra', 1000000, 0, 0, 9.99, 'usd')`, [MARCH_15]);
    // A connector used only in ChatGPT, and one used in Claude.
    await sql.run(`INSERT INTO cowork_mcp_invocations (id, user_id, session_id, mcp_server, mcp_tool, occurred_at, source, surface)
                   VALUES ('m-gpt', 'u-gpt', 'chatgpt:w', 'gptonly', 'search', ?, 'chatgpt_work', 'cowork')`, [t]);
    await sql.run(`INSERT INTO cowork_mcp_invocations (id, user_id, session_id, mcp_server, mcp_tool, occurred_at, source, surface)
                   VALUES ('m-cl', 'u-claude', 'cw-s', 'salesforce', 'soql', ?, 'otel', 'cowork')`, [t]);
    for (const name of ['gptonly', 'salesforce']) {
      await sql.run(`INSERT INTO skill_library_entries (name, type, source, is_published, created_at, updated_at) VALUES (?, 'connector', 'org', 0, ?, ?)`, [name, t, t]);
    }

    const { getConnectedProducts } = await import('@/lib/sources/connected');
    const { visibleVendor } = await import('@/lib/sources/openai-visibility');
    const { buildChargeback } = await import('@/lib/finance/chargeback');
    const { buildByProduct } = await import('@/lib/pulse/cowork/by-product');
    const board = async () => {
      const { GET } = await import('@/app/api/library/route');
      const res = await GET(new NextRequest('http://localhost/api/library?type=connector'));
      return ((await res.json()).entries as Array<{ name: string; invocation_count: number; products: string[] }>);
    };
    const audit = async () => {
      const { GET } = await import('@/app/api/events/route');
      const res = await GET(new NextRequest('http://localhost/api/events?source=openai'));
      return ((await res.json()) as Array<{ id: string }>).map(r => r.id).sort();
    };

    // Shown (the default): OpenAI everywhere.
    expect(await getConnectedProducts()).toMatchObject({ openai: true, openaiConnected: true });
    expect(await visibleVendor('openai')).toBe('openai');
    const shownReport = await buildChargeback('2026-03', nowS);
    expect(shownReport.vendors).toBeDefined();
    expect(shownReport.grandTotalUsd).toBeCloseTo(2, 5);
    // The fresh database carries built-in entries too; look at the two added here.
    const mine = (entries: Awaited<ReturnType<typeof board>>) => entries.filter(e => e.name === 'gptonly' || e.name === 'salesforce');
    const shownBoard = mine(await board());
    expect(shownBoard.map(e => e.name).sort()).toEqual(['gptonly', 'salesforce']);
    expect(shownBoard.find(e => e.name === 'gptonly')!.products).toEqual(['ChatGPT']);

    // Hidden: the analytics read as Claude-only.
    await setConfig('openai_shown', 'false');
    expect(await getConnectedProducts()).toMatchObject({ claude: true, openai: false, openaiConnected: true });
    expect(await visibleVendor('openai')).toBe('claude');
    expect(await visibleVendor('all')).toBe('claude');
    const hiddenReport = await buildChargeback('2026-03', nowS);
    expect(hiddenReport.vendors).toBeUndefined();
    expect(hiddenReport.grandTotalUsd).toBeCloseTo(1, 5);
    const hiddenBoard = mine(await board());
    expect(hiddenBoard.map(e => e.name)).toEqual(['salesforce']);
    expect(hiddenBoard[0].products).toEqual(['Claude']);
    const panel = (await buildByProduct(nowS, { chatgpt: (await getConnectedProducts()).openai }))!;
    expect(panel.rows.map(r => r.product)).not.toContain('chatgpt');
    expect(panel.total.sessions).toBe(1);

    // The Audit Log still lists ChatGPT's prompt and connector call.
    expect(await audit()).toEqual(['gw-1', 'm-gpt']);

    // Collection is untouched: the sync still runs while hidden.
    runOpenAiSync.mockResolvedValueOnce({ files: 0, records: 0, prompts: { chatgpt_chat: 0, chatgpt_work: 0, codex: 0 }, errors: [] });
    expect((await runOpenAiSyncJob({ force: true })).skipped).toBe(false);
  } finally {
    await cleanup();
  }
}

describe('OpenAI pause sync and show switch (postgres)', () => {
  it('pauses the sync, and hides ChatGPT and Codex from the analytics but not the Audit Log', async () => {
    await runSpec();
  }, 180_000);
});
