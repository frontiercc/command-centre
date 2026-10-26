// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Claude subagents on Postgres: the Cowork receiver keeps the subagent name
// (migration 0036) and the register reads both surfaces correctly.
//
// HARNESS RULE: library code reaches the database through getClient(), which
// binds to DATABASE_URL on first use, so modules are DYNAMIC-imported after
// createTestDbClient('postgres') has set DATABASE_URL and reset modules.
import { describe, it, expect } from 'vitest';

const DAY = 86400;
const NOW = 1_790_000_000;
const NANO = `${NOW - 3600}000000000`;

// Telemetry user ids are opaque hashes; none may reach the register.
const U_ANN = 'hash-ann-0000000000000000';
const U_BEN = 'hash-ben-1111111111111111';
const U_CARA = 'hash-cara-222222222222222';

function logsPayload(email: string, userId: string, records: Array<Record<string, string>>) {
  return {
    resourceLogs: [{
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: 'cowork' } },
          { key: 'user.email', value: { stringValue: email } },
          { key: 'user.id', value: { stringValue: userId } },
          { key: 'organization.id', value: { stringValue: 'org_test' } },
        ],
      },
      scopeLogs: [{
        logRecords: records.map(r => ({
          timeUnixNano: NANO,
          attributes: Object.entries(r).map(([key, value]) => ({ key, value: { stringValue: value } })),
        })),
      }],
    }],
  };
}

describe('Claude subagents (postgres)', () => {
  it('Cowork ingest keeps the subagent name on model calls and launches, never the prompt', async () => {
    const { createTestDbClient } = await import('./helpers/db');
    const { client, cleanup } = await createTestDbClient('postgres');
    try {
      const { schema } = await import('@/lib/db/schema');
      const { processOtlpLogs } = await import('@/lib/otel/cowork-receiver');
      const { eq } = await import('drizzle-orm');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = client as any;

      const result = await processOtlpLogs(logsPayload('sub@test.local', 'u_sub', [
        {
          'event.name': 'api_request', 'session.id': 'sess_sub', 'prompt.id': 'p_sub_call',
          model: 'claude-sonnet-5', input_tokens: '10', output_tokens: '5', cost_usd: '0.25',
          'agent.name': 'Explore', query_source: 'agent:builtin:Explore',
        },
        {
          'event.name': 'api_request', 'session.id': 'sess_sub', 'prompt.id': 'p_main_call',
          model: 'claude-sonnet-5', input_tokens: '10', output_tokens: '5', cost_usd: '0.75',
          query_source: 'repl_main_thread',
        },
        {
          'event.name': 'tool_result', 'session.id': 'sess_sub', 'prompt.id': 'p_launch',
          tool_name: 'Agent', success: 'true', duration_ms: '1200',
          tool_parameters: JSON.stringify({ subagent_type: 'claim-verifier' }),
          tool_input: JSON.stringify({ subagent_type: 'claim-verifier', prompt: 'SECRET-PROMPT-TEXT check these claims' }),
        },
        {
          'event.name': 'tool_result', 'session.id': 'sess_sub', 'prompt.id': 'p_bash',
          tool_name: 'Bash', success: 'true',
          tool_parameters: JSON.stringify({ subagent_type: 'not-a-launch', bash_command: 'ls' }),
        },
      ]));
      expect(result.errors).toEqual([]);

      const byPrompt = async (promptId: string) =>
        (await db.select().from(schema.coworkMessages).where(eq(schema.coworkMessages.prompt_id, promptId)))[0];

      const subCall = await byPrompt('p_sub_call');
      expect(subCall.agent_name).toBe('Explore');
      expect(subCall.query_source).toBe('agent:builtin:Explore');

      const mainCall = await byPrompt('p_main_call');
      expect(mainCall.agent_name).toBeNull();
      expect(mainCall.query_source).toBe('repl_main_thread');

      const launch = await byPrompt('p_launch');
      expect(launch.content_preview).toBe('Agent');
      expect(launch.agent_name).toBe('claim-verifier');

      // Only a launch tool carries a subagent name.
      expect((await byPrompt('p_bash')).agent_name).toBeNull();

      // The prompt handed to the subagent is stored nowhere.
      const all = await db.select().from(schema.coworkMessages);
      expect(JSON.stringify(all)).not.toContain('SECRET-PROMPT-TEXT');
    } finally {
      await cleanup();
    }
  });

  it('builds the register across Claude Code and Cowork', async () => {
    const { createTestDbClient } = await import('./helpers/db');
    const { client, cleanup } = await createTestDbClient('postgres');
    try {
      const { schema } = await import('@/lib/db/schema');
      const { setConfigValue } = await import('@/lib/config');
      const { buildSubagentRegister } = await import('@/lib/subagents/register');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = client as any;

      // $3 per million input tokens; nothing else charged.
      await setConfigValue('codeModelRates', JSON.stringify({
        'test-model': { in: 3, out: 0, cacheWrite: 0, cacheRead: 0 },
      }));

      await db.insert(schema.users).values([
        { id: U_ANN, email: 'ann@test.local', display_name: null, department: null },
        { id: U_BEN, email: 'ben@test.local', display_name: 'Ben Telemetry', department: 'Engineering' },
        { id: U_CARA, email: 'cara@test.local', display_name: null, department: null },
      ]);
      await db.insert(schema.adminUsers).values({
        id: 'admin-ann', email: 'ann@test.local', password_hash: 'x', role: 'pulse',
        display_name: 'Ann Admin', department: 'Sales', linked_cowork_user_id: U_ANN,
      });

      let n = 0;
      const code = (agent: string | null, qs: string | null, userId: string, model: string, input: number, session: string, at: number) =>
        db.insert(schema.codeAssistantMeta).values({
          id: `cam-${n++}`, user_id: userId, session_id: session, model, input_tokens: input,
          agent_name: agent, query_source: qs, occurred_at: at, source: 'otel',
        });

      await code('general-purpose', 'agent:builtin:general-purpose', U_ANN, 'test-model', 1_000_000, 's1', NOW - 1 * DAY);
      await code('general-purpose', 'agent:builtin:general-purpose', U_BEN, 'test-model', 1_000_000, 's2', NOW - 1 * DAY);
      await code(null, 'repl_main_thread', U_ANN, 'test-model', 2_000_000, 's1', NOW - 1 * DAY);
      await code('nay-sayer', 'agent:custom', U_ANN, 'mystery-model', 500, 's1', NOW - 2 * DAY);
      await code('reviewer', 'agent:custom', U_BEN, 'test-model', 1_000_000, 's0', NOW - 40 * DAY);
      await code('reviewer', 'agent:custom', U_BEN, 'test-model', 1_000_000, 's3', NOW - 10 * DAY);
      await code('custom', 'agent:custom', U_CARA, 'test-model', 1_000_000, 's4', NOW - 20 * DAY);
      await code('pr-review-toolkit:code-reviewer', 'agent:custom', U_BEN, 'test-model', 1_000_000, 's5', NOW - 15 * DAY);

      for (const id of ['c1', 'c2', 'c9']) {
        await db.insert(schema.coworkSessions).values({ id, conversation_id: id, user_id: id === 'c1' ? U_BEN : U_CARA, started_at: NOW - 5 * DAY });
      }
      let m = 0;
      const cw = (values: Record<string, unknown>) =>
        db.insert(schema.coworkMessages).values({ id: `cw-${m++}`, surface: 'cowork', source: 'otel', ...values });

      await cw({ session_id: 'c1', user_id: U_BEN, message_type: 'cowork_api_request', model: 'claude-sonnet-5', cost_usd: '0.5', agent_name: 'Explore', query_source: 'agent:builtin:Explore', occurred_at: NOW - 5 * DAY });
      await cw({ session_id: 'c1', user_id: U_BEN, message_type: 'cowork_api_request', model: 'claude-sonnet-5', cost_usd: '1.5', occurred_at: NOW - 5 * DAY });
      await cw({ session_id: 'c1', user_id: U_BEN, message_type: 'cowork_tool_metadata', content_preview: 'Agent', agent_name: 'Explore', occurred_at: NOW - 5 * DAY });
      await cw({ session_id: 'c2', user_id: U_CARA, message_type: 'cowork_tool_metadata', content_preview: 'Agent', occurred_at: NOW - 6 * DAY });
      await cw({ session_id: 'c2', user_id: U_CARA, message_type: 'cowork_tool_metadata', content_preview: 'Task', occurred_at: NOW - 6 * DAY });
      // Outside the window: ignored.
      await cw({ session_id: 'c9', user_id: U_CARA, message_type: 'cowork_tool_metadata', content_preview: 'Agent', occurred_at: NOW - 45 * DAY });

      const reg = await buildSubagentRegister(NOW);
      const row = (name: string) => reg.rows.find(r => r.name === name)!;

      expect(reg.rows.map(r => r.name).sort()).toEqual(
        ['Explore', 'custom', 'general-purpose', 'nay-sayer', 'pr-review-toolkit:code-reviewer', 'reviewer'].sort());

      // New custom subagents lead the list.
      expect(reg.rows[0].name).toBe('nay-sayer');
      expect(row('nay-sayer')).toMatchObject({ kind: 'custom', source: 'own', isNew: true, spendUsd: null, people: 1 });
      expect(reg.unpricedModels).toEqual(['mystery-model']);

      // First seen counts all history, so an old custom subagent is not New.
      expect(row('reviewer')).toMatchObject({ isNew: false, firstSeen: NOW - 40 * DAY, sessions: 1 });
      expect(row('reviewer').spendUsd).toBeCloseTo(3, 6);

      const gp = row('general-purpose');
      expect(gp).toMatchObject({ kind: 'built_in', source: 'built_in', people: 2, sessions: 2, surfaces: ['code'], isNew: false });
      expect(gp.spendUsd).toBeCloseTo(6, 6);
      expect(gp.byPerson.map(p => p.name).sort()).toEqual(['Ann Admin', 'Ben Telemetry']);
      expect(gp.byPerson.find(p => p.name === 'Ann Admin')!.department).toBe('Sales');

      expect(row('custom')).toMatchObject({ kind: 'custom', source: 'withheld' });
      expect(row('custom').byPerson[0].name).toBe('cara@test.local');
      expect(row('pr-review-toolkit:code-reviewer')).toMatchObject({ source: 'plugin', plugin: 'pr-review-toolkit' });

      const ex = row('Explore');
      expect(ex).toMatchObject({ kind: 'built_in', surfaces: ['cowork'], calls: 1, launches: 1, sessions: 1, people: 1 });
      expect(ex.spendUsd).toBeCloseTo(0.5, 6);

      // Shares: Code subagent spend 3+3+3+3+3 of 3+3+6+3+3+3 (all priced, in window).
      expect(reg.totals.codeSubagentSpendUsd).toBeCloseTo(15, 6);
      expect(reg.totals.codeTotalSpendUsd).toBeCloseTo(21, 6);
      expect(reg.totals.coworkSubagentSpendUsd).toBeCloseTo(0.5, 6);
      expect(reg.totals.coworkTotalSpendUsd).toBeCloseTo(2, 6);
      expect(reg.totals).toMatchObject({ subagents: 6, custom: 4, builtIn: 2, newCustom: 1, coworkLaunches: 3, coworkLaunchPeople: 2 });

      // Launches with no name count in the headline only; they never make a row.
      expect(reg.rows.some(r => r.byPerson.some(p => p.name === 'cara@test.local' && p.launches > 0))).toBe(false);

      // Raw telemetry ids never leave the register.
      const json = JSON.stringify(reg);
      for (const id of [U_ANN, U_BEN, U_CARA]) expect(json).not.toContain(id);
    } finally {
      await cleanup();
    }
  });
});
