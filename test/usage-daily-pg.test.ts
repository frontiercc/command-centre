// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The Claude Code and Cowork daily totals (lib/pulse/code/usage-daily.ts, lib/pulse/cowork/usage-daily.ts)
// must give exactly what adding up the raw model calls gives, for any window: before the first build
// (readers fall back to the raw calls), after it, and after more calls arrive, including a prompt whose
// calls run past midnight UTC and a call that arrives late for an earlier day.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDatabase } from './helpers/db';

const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const TODAY = NOW - (NOW % DAY);
let cleanup: () => Promise<void>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;

type Rows = Array<Record<string, string | null>>;
const rows = async (q: unknown): Promise<Rows> => (await db.execute(q)).rows as Rows;

let seq = 0;
function codeCall(o: { session: string; user: string; at: number; model: string; prompt: string; agent?: string; skill?: string; ingested?: number }) {
  seq += 1;
  return {
    id: `cc-${seq}`, user_id: o.user, session_id: o.session, model: o.model,
    input_tokens: 100 + seq, output_tokens: 50 + seq, cache_creation_tokens: 10 * seq, cache_read_tokens: 1000 + seq,
    commit_count: seq % 3 === 0 ? 1 : 0, error_count: seq % 5 === 0 ? 1 : 0,
    occurred_at: o.at, ingested_at: o.ingested ?? o.at, source: 'otel', prompt_id: o.prompt,
    query_source: o.agent ? `agent:custom:${o.agent}` : 'repl_main_thread', agent_name: o.agent ?? null, skill_name: o.skill ?? null,
  };
}
function coworkCall(o: { session: string; user: string; at: number; model: string; cost: string | null; usage: unknown; product?: string; agent?: string; ingested?: number }) {
  seq += 1;
  return {
    id: `wc-${seq}`, session_id: o.session, user_id: o.user, message_type: 'cowork_api_request', model: o.model,
    cost_usd: o.cost, token_usage: o.usage, occurred_at: o.at, ingested_at: o.ingested ?? o.at, surface: 'cowork', source: 'otel',
    product: o.product ?? null, agent_name: o.agent ?? null,
  };
}

const codeRaw = (start: number, end: number) => rows(sql`
  SELECT model, user_id, SUM(input_tokens)::text AS i, SUM(cache_read_tokens)::text AS cr, COUNT(*)::text AS calls,
         COUNT(DISTINCT COALESCE(prompt_id, id))::text AS prompts, SUM(commit_count)::text AS commits
    FROM code_assistant_meta WHERE occurred_at >= ${start} AND occurred_at < ${end} AND model <> ''
   GROUP BY model, user_id ORDER BY model, user_id`);
const codeSummary = async (start: number, end: number) => {
  const { codeUsageIn } = await import('@/lib/pulse/code/usage-daily');
  return rows(sql`
    SELECT model, user_id, SUM(input_tokens)::text AS i, SUM(cache_read_tokens)::text AS cr, SUM(calls)::text AS calls,
           SUM(model_prompts)::text AS prompts, SUM(commit_count)::text AS commits
      FROM (${codeUsageIn(start, end, { nowS: NOW, prompts: true })}) u WHERE model <> ''
     GROUP BY model, user_id ORDER BY model, user_id`);
};
const coworkRaw = (start: number, end: number) => rows(sql`
  SELECT model, COALESCE(product, '') AS product, COUNT(*)::text AS calls, COALESCE(SUM(cost_usd), 0)::text AS cost, COUNT(cost_usd)::text AS costed,
         COALESCE(SUM(CASE WHEN jsonb_typeof(token_usage) = 'object' THEN COALESCE((token_usage ->> 'inputTokens')::numeric, 0) ELSE 0 END), 0)::text AS i
    FROM cowork_messages WHERE message_type = 'cowork_api_request' AND occurred_at >= ${start} AND occurred_at < ${end}
   GROUP BY model, COALESCE(product, '') ORDER BY model, 2`);
const coworkSummary = async (start: number, end: number) => {
  const { coworkUsageIn } = await import('@/lib/pulse/cowork/usage-daily');
  return rows(sql`
    SELECT model, product, SUM(calls)::text AS calls, COALESCE(SUM(cost_usd), 0)::text AS cost, SUM(costed)::text AS costed, SUM(input_tokens)::text AS i
      FROM (${coworkUsageIn(start, end, { nowS: NOW })}) u
     GROUP BY model, product ORDER BY model, 2`);
};

const WINDOWS: Array<[string, number, number]> = [
  ['last 3 days', NOW - 3 * DAY, NOW + 1],
  ['from midnight 4 days ago', TODAY - 4 * DAY, NOW + 1],
  ['two whole days in the past', TODAY - 3 * DAY, TODAY - DAY],
  ['open-ended', NOW - 6 * DAY, 32_503_680_000],
];

async function expectSame() {
  for (const [label, start, end] of WINDOWS) {
    expect(await codeSummary(start, end), `Claude Code, ${label}`).toEqual(await codeRaw(start, end));
    expect(await coworkSummary(start, end), `Cowork, ${label}`).toEqual(await coworkRaw(start, end));
  }
}

beforeAll(async () => {
  const t = await createTestDatabase();
  cleanup = t.cleanup;
  const { schema } = await import('@/lib/db/schema');
  const { getClient } = await import('@/lib/db/client');
  db = await getClient();
  await db.insert(schema.users).values([
    { id: 'u1', email: 'u1@test.local', display_name: 'U1', source: 'otel' },
    { id: 'u2', email: 'u2@test.local', display_name: 'U2', source: 'otel' },
  ]);
  const calls = [];
  for (let d = 5; d >= 1; d--) {
    const day = TODAY - d * DAY;
    calls.push(
      codeCall({ session: `s${d}`, user: 'u1', at: day + 3600, model: 'claude-sonnet-4-5', prompt: `p${d}a` }),
      codeCall({ session: `s${d}`, user: 'u1', at: day + 3660, model: 'claude-sonnet-4-5', prompt: `p${d}a`, agent: 'Explore' }),
      codeCall({ session: `s${d}`, user: 'u1', at: day + 3700, model: 'claude-haiku-4-5', prompt: `p${d}a`, skill: 'pdf' }),
      codeCall({ session: `t${d}`, user: 'u2', at: day + 7200, model: 'claude-opus-4-1', prompt: `q${d}` }),
    );
  }
  // A prompt that runs past midnight into today's first hour.
  calls.push(
    codeCall({ session: 'night', user: 'u2', at: TODAY - 120, model: 'claude-sonnet-4-5', prompt: 'late' }),
    codeCall({ session: 'night', user: 'u2', at: TODAY + 60, model: 'claude-sonnet-4-5', prompt: 'late' }),
    codeCall({ session: 'night', user: 'u2', at: TODAY - DAY - 60, model: 'claude-sonnet-4-5', prompt: 'earlier' }),
    codeCall({ session: 'night', user: 'u2', at: TODAY - DAY + 30, model: 'claude-sonnet-4-5', prompt: 'earlier' }),
  );
  await db.insert(schema.codeAssistantMeta).values(calls);
  const wc = [];
  for (let d = 5; d >= 0; d--) {
    const day = TODAY - d * DAY;
    wc.push(
      coworkCall({ session: `w${d}`, user: 'u1', at: day + 1800, model: 'claude-sonnet-4-5', cost: '0.125', usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheCreationTokens: 40 } }),
      coworkCall({ session: `w${d}`, user: 'u1', at: day + 1900, model: 'claude-sonnet-4-5', cost: null, usage: null, agent: 'general-purpose' }),
      coworkCall({ session: `w${d}`, user: 'u1', at: day + 2000, model: 'claude-opus-4-1', cost: '0.5', usage: { inputTokens: '700', outputTokens: true } }),
      coworkCall({ session: `x${d}`, user: 'u2', at: day + 2100, model: 'claude-sonnet-4-5', cost: null, usage: { inputTokens: 90 }, product: 'excel' }),
    );
  }
  await db.insert(schema.coworkMessages).values(wc);
});

afterAll(async () => { await cleanup(); });

describe('daily totals', () => {
  it('match the raw calls before the first build (readers add up the raw calls)', async () => {
    await expectSame();
  });

  it('match the raw calls after the first build, and the build reads only the summary for whole days', async () => {
    const { runCodeUsageDaily } = await import('@/lib/pulse/code/usage-daily');
    const { runCoworkUsageDaily } = await import('@/lib/pulse/cowork/usage-daily');
    expect((await runCodeUsageDaily(NOW + 120)).done).toBe(true);
    expect((await runCoworkUsageDaily(NOW + 120)).done).toBe(true);
    const ready = await rows(sql`SELECT key, value FROM config WHERE key IN ('code_usage_daily_ready', 'cowork_usage_daily_ready') ORDER BY key`);
    expect(ready).toEqual([{ key: 'code_usage_daily_ready', value: 'true' }, { key: 'cowork_usage_daily_ready', value: 'true' }]);
    expect(Number((await rows(sql`SELECT COUNT(*) AS n FROM code_usage_daily`))[0].n)).toBeGreaterThan(0);
    await expectSame();
  });

  it('pick up calls that arrive later, including one for an earlier day', async () => {
    const { schema } = await import('@/lib/db/schema');
    await db.insert(schema.codeAssistantMeta).values([
      codeCall({ session: 's3', user: 'u1', at: TODAY - 3 * DAY + 5000, model: 'claude-sonnet-4-5', prompt: 'p3b', ingested: NOW + 200 }),
      codeCall({ session: 's3', user: 'u1', at: TODAY - 3 * DAY + 5100, model: 'claude-opus-4-1', prompt: 'p3a', ingested: NOW + 200 }),
    ]);
    await db.insert(schema.coworkMessages).values([
      coworkCall({ session: 'w4', user: 'u1', at: TODAY - 4 * DAY + 9000, model: 'claude-sonnet-4-5', cost: '1.5', usage: { inputTokens: 3 }, ingested: NOW + 200 }),
    ]);
    const { runCodeUsageDaily } = await import('@/lib/pulse/code/usage-daily');
    const { runCoworkUsageDaily } = await import('@/lib/pulse/cowork/usage-daily');
    await runCodeUsageDaily(NOW + 400);
    await runCoworkUsageDaily(NOW + 400);
    await expectSame();
  });
});
