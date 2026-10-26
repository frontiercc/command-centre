// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Where the money went for one conversation, and for one prompt inside it
 * (the Audit Log's Session stats). Reads the session's model calls directly,
 * so the conversation total always equals the sum of its parts.
 */
import { sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { getCodeModelRates, priceTokens } from '@/lib/pulse/code/rates';
import { SpendSplitAcc, type SpendSplit } from './where-money-went';

export interface SessionSpend {
  surface: 'code' | 'cowork' | null;
  /** The person the session belongs to (for the caller's department check). */
  userId: string | null;
  conversation: SpendSplit;
  /** Null when no prompt id was asked for, or the prompt made no model call. */
  prompt: SpendSplit | null;
}

type Row = Record<string, unknown>;

async function rows(query: ReturnType<typeof sql>): Promise<Row[]> {
  const client = await getTypedClient();
  const res = await client.execute(query);
  return (res as unknown as { rows: Row[] }).rows;
}

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

export async function buildSessionSpend(sessionId: string, promptId: string | null): Promise<SessionSpend> {
  const conversation = new SpendSplitAcc();
  const prompt = new SpendSplitAcc();
  let promptCalls = 0;
  let surface: SessionSpend['surface'] = null;
  let userId: string | null = null;

  // Claude Code: priced from tokens at the admin model rates.
  const code = await rows(sql`
    SELECT user_id, model, agent_name, skill_name, (query_source IS NOT NULL) AS recorded,
           (${promptId}::text IS NOT NULL AND prompt_id = ${promptId}) AS this_prompt,
           COUNT(*) AS calls,
           SUM(input_tokens) AS inp, SUM(output_tokens) AS outp,
           SUM(cache_creation_tokens) AS cw, SUM(cache_read_tokens) AS cr
      FROM code_assistant_meta
     WHERE session_id = ${sessionId} AND model IS NOT NULL AND model <> ''
     GROUP BY user_id, model, agent_name, skill_name, (query_source IS NOT NULL), this_prompt`);
  if (code.length > 0) {
    surface = 'code';
    const rates = await getCodeModelRates();
    for (const r of code) {
      userId ??= text(r.user_id);
      const model = String(r.model);
      const usd = priceTokens(model, {
        inputTokens: num(r.inp), outputTokens: num(r.outp),
        cacheCreationTokens: num(r.cw), cacheReadTokens: num(r.cr),
      }, rates);
      const subagent = text(r.agent_name);
      const fact = { model, subagent, skill: text(r.skill_name), sourceRecorded: r.recorded === true || !!subagent, usd, calls: num(r.calls) };
      conversation.add(fact);
      if (r.this_prompt === true) { prompt.add(fact); promptCalls += fact.calls; }
    }
  }

  // Cowork: the cost Claude reports on each model call.
  const cowork = await rows(sql`
    SELECT user_id, model, agent_name, skill_name, (query_source IS NOT NULL) AS recorded,
           (${promptId}::text IS NOT NULL AND prompt_id = ${promptId}) AS this_prompt,
           COUNT(*) AS calls, SUM(cost_usd) AS cost, COUNT(cost_usd) AS costed
      FROM cowork_messages
     WHERE session_id = ${sessionId} AND message_type = 'cowork_api_request'
     GROUP BY user_id, model, agent_name, skill_name, (query_source IS NOT NULL), this_prompt`);
  if (cowork.length > 0) {
    surface ??= 'cowork';
    for (const r of cowork) {
      userId ??= text(r.user_id);
      const subagent = text(r.agent_name);
      const fact = {
        model: text(r.model), subagent, skill: text(r.skill_name),
        sourceRecorded: r.recorded === true || !!subagent,
        usd: num(r.costed) > 0 ? num(r.cost) : null,
        calls: num(r.calls),
      };
      conversation.add(fact);
      if (r.this_prompt === true) { prompt.add(fact); promptCalls += fact.calls; }
    }
  }

  return {
    surface,
    userId,
    conversation: conversation.result(),
    prompt: promptId && promptCalls > 0 ? prompt.result() : null,
  };
}
