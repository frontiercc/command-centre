// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Where the money went for one conversation, and for one prompt inside it
 * (the Audit Log's Session stats). Reads the session's model calls directly,
 * so the conversation total always equals the sum of its parts.
 *
 * ChatGPT and Codex calls carry no prompt id, so each reply (ChatGPT) or turn
 * (Codex) counts towards the person's latest prompt before it. A ChatGPT
 * reply's cost is its share of its hour's cost (OpenAI reports cost per hour),
 * so a ChatGPT figure is an estimate; a Codex turn's tokens are priced exactly.
 */
import { sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { getCodeModelRates, priceTokens } from '@/lib/pulse/code/rates';
import { SpendSplitAcc, type SpendSplit } from './where-money-went';
import { chatgptConversationReplies } from './spend-review-openai';

export interface SessionSpend {
  surface: 'code' | 'cowork' | 'chatgpt' | 'codex' | null;
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

/**
 * The prompt each call belongs to when calls carry no prompt id: the latest
 * prompt at or before the call, or the first prompt for a call before any.
 */
export function promptAt(prompts: Array<{ id: string; at: number }>, at: number): string | null {
  let pick: string | null = prompts[0]?.id ?? null;
  for (const p of prompts) if (p.at <= at) pick = p.id;
  return pick;
}

async function sessionPrompts(sessionId: string): Promise<Array<{ id: string; at: number }>> {
  const r = await rows(sql`
    SELECT id, occurred_at FROM cowork_messages
     WHERE session_id = ${sessionId} AND message_type IN ('cowork_user_message', 'code_user_message')
     ORDER BY occurred_at, id`);
  return r.map(x => ({ id: String(x.id), at: num(x.occurred_at) }));
}

export async function buildSessionSpend(sessionId: string, promptId: string | null): Promise<SessionSpend> {
  const conversation = new SpendSplitAcc();
  const prompt = new SpendSplitAcc();
  let promptCalls = 0;
  let surface: SessionSpend['surface'] = null;
  let userId: string | null = null;

  if (sessionId.startsWith('codex:') || sessionId.startsWith('chatgpt:')) {
    const rates = await getCodeModelRates();
    const prompts = await sessionPrompts(sessionId);
    const add = (model: string | null, usd: number | null, calls: number, at: number) => {
      const fact = { model, subagent: null, skill: null, sourceRecorded: true, usd, calls };
      conversation.add(fact);
      if (promptId && promptAt(prompts, at) === promptId) { prompt.add(fact); promptCalls += calls; }
    };
    if (sessionId.startsWith('codex:')) {
      surface = 'codex';
      const turns = await rows(sql`
        SELECT user_id, model, started_at, uncached_input_tokens AS inp, cached_input_tokens AS cached, output_tokens AS outp
          FROM codex_turns WHERE session_id = ${sessionId}`);
      for (const t of turns) {
        userId ??= text(t.user_id);
        const model = text(t.model);
        const usd = model === null ? null : priceTokens(model, {
          inputTokens: num(t.inp), outputTokens: num(t.outp), cacheReadTokens: num(t.cached), cacheCreationTokens: 0,
        }, rates);
        add(model, usd, 1, num(t.started_at));
      }
    } else {
      surface = 'chatgpt';
      const client = await getTypedClient();
      const conv = await chatgptConversationReplies(client, rates, sessionId);
      userId = conv.userId;
      for (const r of conv.replies) {
        // No cost record for its hour yet (OpenAI's export lags): nothing to count.
        if (r.parts.length === 0) continue;
        // One reply can carry shares of more than one cost record; it is one call.
        r.parts.forEach((p, i) => add(p.model, p.usd, i === 0 ? 1 : 0, r.occurredAt));
      }
    }
    return {
      surface,
      userId,
      conversation: conversation.result(),
      prompt: promptId && promptCalls > 0 ? prompt.result() : null,
    };
  }

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
