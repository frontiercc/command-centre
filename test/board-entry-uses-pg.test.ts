// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// An entry's own page counts the same uses the S&C Board list does: a connector
// from its connector (MCP) uses, a skill from its skill uses, ChatGPT and Codex
// left out of every figure (week counts included) while they are hidden. Claude's
// own skills (run, verify...) are never listed or counted, and the Board's counts
// match its list while ChatGPT and Codex are hidden.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { isBoardHiddenSkill } from '@/lib/library/built-in-connectors';

vi.mock('@/lib/auth/admin-auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/admin-auth')>();
  return {
    ...actual,
    getAdminSession: async () => ({ authenticated: true, role: 'admin', email: 'admin@test.com', userId: 'admin-1', department: null }),
  };
});

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;
let cleanup: () => Promise<void>;
let setConfigValue: typeof import('@/lib/config').setConfigValue;
const ids: Record<string, number> = {};

interface BoardEntry { id: number; name: string; invocation_count: number; user_count: number; week_count: number; prev_week_count: number }

async function board(query = ''): Promise<{ entries: BoardEntry[]; unclaimed_count: number; stats: { skill_count: number; connector_count: number } }> {
  const { GET } = await import('../app/api/library/route');
  return (await GET(new NextRequest(`http://localhost/api/library?source=org&per_page=200${query}`))).json();
}

async function detail(name: string) {
  const { GET } = await import('../app/api/library/[id]/route');
  const id = ids[name];
  const res = await GET(new NextRequest(`http://localhost/api/library/${id}`), { params: Promise.resolve({ id: String(id) }) });
  expect(res.status).toBe(200);
  return res.json();
}

beforeAll(async () => {
  const { createTestDatabase } = await import('./helpers/db');
  const h = await createTestDatabase();
  cleanup = h.cleanup;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = h.client;
  ({ setConfigValue } = await import('@/lib/config'));
  const { schema } = await import('@/lib/db/schema');
  await client.insert(schema.users).values([
    { id: 'u1', email: 'u1@corp.com', display_name: 'Ada', department: 'Sales' },
    { id: 'u2', email: 'u2@corp.com', display_name: 'Grace', department: 'Sales' },
  ]);
  const rows = await client.insert(schema.skillLibraryEntries).values([
    { name: 'jira', type: 'connector', surface: 'cowork', source: 'org', is_published: 0, created_at: NOW - 30 * DAY, updated_at: NOW - 30 * DAY },
    { name: 'brand-review', type: 'skill', surface: 'cowork', source: 'org', is_published: 1, created_at: NOW - 30 * DAY, updated_at: NOW - 30 * DAY },
    { name: 'run', type: 'skill', surface: 'code', source: 'org', is_published: 0, created_at: NOW - DAY, updated_at: NOW - DAY },
    { name: 'verify', type: 'skill', surface: 'code', source: 'org', is_published: 0, created_at: NOW - DAY, updated_at: NOW - DAY },
    { name: 'gpt-only', type: 'skill', surface: 'cowork', source: 'org', is_published: 0, created_at: NOW - 30 * DAY, updated_at: NOW - 30 * DAY },
  ]).returning();
  for (const r of rows as Array<{ id: number; name: string }>) ids[r.name] = r.id;

  await client.insert(schema.coworkMcpInvocations).values([
    { id: 'm1', user_id: 'u1', session_id: 's1', mcp_server: 'jira', mcp_tool: 'search', occurred_at: NOW - DAY, source: 'otel', surface: 'cowork', success: 1 },
    { id: 'm2', user_id: 'u1', session_id: 's1', mcp_server: 'jira', mcp_tool: 'search', occurred_at: NOW - 2 * DAY, source: 'otel', surface: 'cowork', success: 1 },
    { id: 'm3', user_id: 'u2', session_id: 's2', mcp_server: 'jira', mcp_tool: 'create', occurred_at: NOW - 10 * DAY, source: 'otel', surface: 'cowork', success: 1 },
    // ChatGPT's use this week: counted only while ChatGPT and Codex are shown.
    { id: 'm4', user_id: 'u2', session_id: 'chatgpt:s', mcp_server: 'jira', mcp_tool: 'search', occurred_at: NOW - DAY, source: 'chatgpt_work', surface: 'cowork', success: 1 },
  ]);
  await client.insert(schema.coworkSkillInvocations).values([
    // A skill use under the connector's name: never one of the connector's uses.
    { id: 'k1', user_id: 'u2', session_id: 's2', skill_name: 'jira', occurred_at: NOW - DAY, invocation_type: 'user_typed' },
    { id: 'k2', user_id: 'u1', session_id: 's1', skill_name: 'brand-review', occurred_at: NOW - DAY, invocation_type: 'agent_chained' },
    { id: 'k3', user_id: 'u1', session_id: 's1', skill_name: 'brand-review', occurred_at: NOW - 9 * DAY, invocation_type: 'user_typed' },
    { id: 'k4', user_id: 'u2', session_id: 'codex:s', skill_name: 'brand-review', occurred_at: NOW - DAY, invocation_type: 'user_typed', source: 'codex' },
    { id: 'k5', user_id: 'u1', session_id: 's1', skill_name: 'run', occurred_at: NOW - DAY, invocation_type: 'user_typed' },
    { id: 'k6', user_id: 'u2', session_id: 'chatgpt:s', skill_name: 'gpt-only', occurred_at: NOW - DAY, invocation_type: 'user_typed', source: 'chatgpt_work' },
  ]);
}, 120_000);
afterAll(async () => cleanup?.());

describe('S&C Board entry page', () => {
  it("counts a connector's connector uses, matching the Board, with ChatGPT and Codex shown", async () => {
    await setConfigValue('openaiShown', 'true');
    const list = await board();
    const jira = list.entries.find(e => e.name === 'jira')!;
    const body = await detail('jira');
    expect(jira.invocation_count).toBe(4);
    expect(body.stats.total_invocations).toBe(jira.invocation_count);
    expect(body.stats.distinct_users).toBe(jira.user_count);
    expect(body.stats.week_count).toBe(jira.week_count);
    expect(body.stats.prev_week_count).toBe(jira.prev_week_count);
    // How a connector was invoked is not recorded: not measured, never 0%.
    expect(body.stats.agent_chained_pct).toBeNull();
    expect(body.top_users.find((u: { user_id: string }) => u.user_id === 'u1').cnt).toBe(2);
  });

  it('leaves ChatGPT and Codex out of every figure, week counts included, while hidden', async () => {
    await setConfigValue('openaiShown', 'false');
    const list = await board();
    const jira = list.entries.find(e => e.name === 'jira')!;
    const jiraBody = await detail('jira');
    expect(jira).toMatchObject({ invocation_count: 3, week_count: 2, prev_week_count: 1 });
    expect(jiraBody.stats).toMatchObject({ total_invocations: 3, week_count: 2, prev_week_count: 1, distinct_users: 2 });
    expect(jiraBody.daily_counts.reduce((n: number, d: { cnt: number }) => n + d.cnt, 0)).toBe(2);

    const brand = list.entries.find(e => e.name === 'brand-review')!;
    const brandBody = await detail('brand-review');
    expect(brand).toMatchObject({ invocation_count: 2, week_count: 1, prev_week_count: 1 });
    expect(brandBody.stats).toMatchObject({ total_invocations: 2, week_count: 1, prev_week_count: 1, distinct_users: 1, agent_chained_pct: 50 });
  });

  it('still counts a skill from its skill uses', async () => {
    await setConfigValue('openaiShown', 'true');
    const list = await board();
    const brand = list.entries.find(e => e.name === 'brand-review')!;
    const body = await detail('brand-review');
    expect(brand.invocation_count).toBe(3);
    expect(body.stats.total_invocations).toBe(brand.invocation_count);
    expect(body.stats.week_count).toBe(brand.week_count);
    expect(body.stats.agent_chained_pct).toBe(Math.round((1 / 3) * 100));
  });
});

describe("Claude's own skills on the S&C Board", () => {
  it('knows them in any spelling, and not real ones', () => {
    for (const n of ['run', 'Verify', 'code-review', 'code_review', 'claude-api', 'security review']) expect(isBoardHiddenSkill(n)).toBe(true);
    for (const n of ['brand-review', 'anthropic-skills:xlsx', 'jira']) expect(isBoardHiddenSkill(n)).toBe(false);
  });

  it('are never listed or counted', async () => {
    await setConfigValue('openaiShown', 'true');
    const list = await board();
    const names = list.entries.map(e => e.name);
    expect(names).not.toContain('run');
    expect(names).not.toContain('verify');
    // Organisation skills: brand-review and gpt-only. Unclaimed: jira and gpt-only.
    expect(list.stats.skill_count).toBe(2);
    expect(list.unclaimed_count).toBe(2);
    const unclaimed = await board('&claimed=false');
    expect(unclaimed.entries.map(e => e.name).sort()).toEqual(['gpt-only', 'jira']);
  });
});

describe('S&C Board counts match its list while ChatGPT and Codex are hidden', () => {
  it('leaves out an entry used only in ChatGPT from the list, the unclaimed count and the stats', async () => {
    await setConfigValue('openaiShown', 'false');
    const list = await board();
    expect(list.entries.map(e => e.name)).not.toContain('gpt-only');
    expect(list.stats.skill_count).toBe(1); // brand-review
    const unclaimed = await board('&claimed=false');
    expect(unclaimed.entries.map(e => e.name)).toEqual(['jira']);
    expect(list.unclaimed_count).toBe(unclaimed.entries.length);
    await setConfigValue('openaiShown', 'true');
  });
});
