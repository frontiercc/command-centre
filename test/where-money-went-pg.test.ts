// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Where the money went on Postgres: the Audit Log's per-conversation and
// per-prompt figures, Spend Review's per-kind-of-work split, and the Cowork
// receiver keeping the running skill (migration 0037).
//
// HARNESS RULE: library code binds to DATABASE_URL on first use, so modules are
// DYNAMIC-imported after createTestDbClient('postgres').
import { describe, it, expect } from 'vitest';

const NOW = Math.floor(Date.now() / 1000);
const AT = NOW - 3600;
const PERIOD = new Date(AT * 1000).toISOString().slice(0, 7);
const USER = 'hash-wmw-user-000000000000';

describe('where the money went (postgres)', () => {
  it('Audit Log conversation and prompt, and Spend Review per kind of work', async () => {
    const { createTestDbClient } = await import('./helpers/db');
    const { client, cleanup } = await createTestDbClient('postgres');
    try {
      const { schema } = await import('@/lib/db/schema');
      const { setConfigValue } = await import('@/lib/config');
      const { buildSessionSpend } = await import('@/lib/finance/session-spend');
      const { buildSpendReview } = await import('@/lib/finance/spend-review');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = client as any;

      // $1 per million input tokens, so 1,000,000 tokens = $1.
      await setConfigValue('codeModelRates', JSON.stringify({ 'test-model': { in: 1, out: 0, cacheWrite: 0, cacheRead: 0 } }));
      await db.insert(schema.users).values({ id: USER, email: 'wmw@test.local', display_name: 'Wendy Money', department: 'Finance' });

      let n = 0;
      const code = (v: { prompt: string; agent: string | null; skill: string | null; qs: string | null; tokens: number; model?: string }) =>
        db.insert(schema.codeAssistantMeta).values({
          id: `wmw-cam-${n++}`, user_id: USER, session_id: 'wmw-code-1', prompt_id: v.prompt, model: v.model ?? 'test-model',
          input_tokens: v.tokens, agent_name: v.agent, skill_name: v.skill, query_source: v.qs, occurred_at: AT, source: 'otel',
        });
      await code({ prompt: 'p1', agent: null, skill: null, qs: 'repl_main_thread', tokens: 1_000_000 });
      await code({ prompt: 'p1', agent: 'general-purpose', skill: null, qs: 'agent:builtin:general-purpose', tokens: 2_000_000 });
      await code({ prompt: 'p2', agent: 'explore', skill: 'pdf', qs: 'agent:builtin:explore', tokens: 500_000 });
      await code({ prompt: 'p2', agent: null, skill: null, qs: null, tokens: 250_000 }); // before capture: not recorded
      await code({ prompt: 'p2', agent: 'explore', skill: null, qs: 'agent:builtin:explore', tokens: 100, model: 'mystery-model' });

      await db.insert(schema.coworkSessions).values({ id: 'wmw-cw-1', conversation_id: 'wmw-cw-1', user_id: USER, started_at: AT });
      let m = 0;
      const cw = (v: { prompt: string; agent: string | null; skill: string | null; qs: string | null; cost: string }) =>
        db.insert(schema.coworkMessages).values({
          id: `wmw-cw-${m++}`, session_id: 'wmw-cw-1', user_id: USER, message_type: 'cowork_api_request', surface: 'cowork',
          source: 'otel', prompt_id: v.prompt, model: 'claude-sonnet-5', cost_usd: v.cost, agent_name: v.agent, skill_name: v.skill,
          query_source: v.qs, occurred_at: AT,
        });
      await cw({ prompt: 'c1', agent: null, skill: 'xlsx', qs: 'sdk', cost: '0.40' });
      await cw({ prompt: 'c1', agent: 'contract-reviewer', skill: null, qs: 'agent:custom', cost: '0.60' });

      // ── Audit Log: one conversation, one prompt ──
      const codeSpend = await buildSessionSpend('wmw-code-1', 'p2');
      expect(codeSpend.surface).toBe('code');
      expect(codeSpend.userId).toBe(USER);
      const c = codeSpend.conversation;
      expect(c.totalUsd).toBeCloseTo(3.75, 9);
      expect(c.mainUsd).toBeCloseTo(1, 9);
      expect(c.subagentUsd).toBeCloseTo(2.5, 9);
      expect(c.notRecordedUsd).toBeCloseTo(0.25, 9);
      expect(c.bySubagent.map(x => x.name)).toEqual(['general-purpose', 'explore']);
      expect(c.bySkill).toEqual([{ name: 'pdf', usd: 0.5, calls: 1 }]);
      expect(c.unpricedModels).toEqual(['mystery-model']);
      expect(codeSpend.prompt!.totalUsd).toBeCloseTo(0.75, 9);
      expect(codeSpend.prompt!.calls).toBe(3);

      const coworkSpend = await buildSessionSpend('wmw-cw-1', null);
      expect(coworkSpend.surface).toBe('cowork');
      expect(coworkSpend.prompt).toBeNull();
      expect(coworkSpend.conversation.totalUsd).toBeCloseTo(1, 9);
      expect(coworkSpend.conversation.subagentUsd).toBeCloseTo(0.6, 9);
      expect(coworkSpend.conversation.bySkill).toEqual([{ name: 'xlsx', usd: 0.4, calls: 1 }]);

      // ── Spend Review: per kind of work (both unclassified here) ──
      const review = await buildSpendReview(USER, PERIOD, NOW);
      const codeWork = review.work.find(w => w.surface === 'code')!;
      expect(codeWork.split.totalUsd).toBeCloseTo(3.75, 9);
      expect(codeWork.split.subagentUsd).toBeCloseTo(2.5, 9);
      expect(codeWork.split.bySkill.map(x => x.name)).toEqual(['pdf']);
      const coworkWork = review.work.find(w => w.surface === 'cowork')!;
      expect(coworkWork.split.bySubagent).toEqual([{ name: 'contract-reviewer', usd: 0.6, calls: 1 }]);
      // The split sums to the work's own spend figure.
      expect(codeWork.split.totalUsd).toBeCloseTo(codeWork.spendUsd, 9);
      expect(coworkWork.split.totalUsd).toBeCloseTo(coworkWork.spendUsd, 9);
      const session = review.sessions.find(s => s.sessionId === 'wmw-code-1')!;
      expect(session.subagents).toEqual(['explore', 'general-purpose']);
    } finally {
      await cleanup();
    }
  });

  it('the Cowork receiver keeps the running skill on a model call', async () => {
    const { createTestDbClient } = await import('./helpers/db');
    const { client, cleanup } = await createTestDbClient('postgres');
    try {
      const { schema } = await import('@/lib/db/schema');
      const { processOtlpLogs } = await import('@/lib/otel/cowork-receiver');
      const { eq } = await import('drizzle-orm');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = client as any;
      const attrs = (o: Record<string, string>) => Object.entries(o).map(([key, value]) => ({ key, value: { stringValue: value } }));
      const result = await processOtlpLogs({
        resourceLogs: [{
          resource: { attributes: attrs({ 'service.name': 'cowork', 'user.email': 'skill@test.local', 'user.id': 'u_skill', 'organization.id': 'org_test' }) },
          scopeLogs: [{ logRecords: [{
            timeUnixNano: `${AT}000000000`,
            attributes: attrs({ 'event.name': 'api_request', 'session.id': 's_skill', 'prompt.id': 'p_skill', model: 'claude-sonnet-5', cost_usd: '0.1', 'skill.name': 'anthropic-skills:xlsx', query_source: 'sdk' }),
          }] }],
        }],
      });
      expect(result.errors).toEqual([]);
      const row = (await db.select().from(schema.coworkMessages).where(eq(schema.coworkMessages.prompt_id, 'p_skill')))[0];
      expect(row.skill_name).toBe('anthropic-skills:xlsx');
    } finally {
      await cleanup();
    }
  });
});
