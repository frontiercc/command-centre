// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Each person's OpenAI activity, as counts only, for the AI anomaly detector
// (lib/anthropic/ai.ts). Codex turns carry token counts (codex_turns); ChatGPT
// replies carry none, so their number stands in (openai_replies). No prompt or
// reply text is read: only ids, times and numbers leave this module.
import { and, gte, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';

const DAY = 86400;
/** People listed at most, busiest Codex output first: keeps the prompt bounded. */
export const OPENAI_ACTIVITY_MAX_PEOPLE = 200;

export interface OpenAiPersonActivity {
  user_id: string;
  codex_turns_24h: number;
  codex_turns_7d: number;
  codex_input_tokens_24h: number;
  codex_input_tokens_7d: number;
  codex_output_tokens_24h: number;
  codex_output_tokens_7d: number;
  chatgpt_chat_replies_24h: number;
  chatgpt_chat_replies_7d: number;
  chatgpt_work_replies_24h: number;
  chatgpt_work_replies_7d: number;
  /** Latest Codex turn or ChatGPT reply, epoch seconds. */
  last_at: number;
}

function blank(userId: string): OpenAiPersonActivity {
  return {
    user_id: userId,
    codex_turns_24h: 0, codex_turns_7d: 0,
    codex_input_tokens_24h: 0, codex_input_tokens_7d: 0,
    codex_output_tokens_24h: 0, codex_output_tokens_7d: 0,
    chatgpt_chat_replies_24h: 0, chatgpt_chat_replies_7d: 0,
    chatgpt_work_replies_24h: 0, chatgpt_work_replies_7d: 0,
    last_at: 0,
  };
}

/**
 * Per person, the last 24 hours and the last 7 days. Input tokens are
 * uncached plus cached input, as Developer Pulse counts Codex input.
 */
export async function getOpenAiActivityByPerson(nowS: number = Math.floor(Date.now() / 1000)): Promise<OpenAiPersonActivity[]> {
  const client = await getTypedClient();
  const weekAgo = nowS - 7 * DAY;
  const dayAgo = nowS - DAY;
  const ct = schema.codexTurns;
  const rp = schema.openaiReplies;

  const turns = await client
    .select({
      user_id: ct.user_id,
      turns24: sql<number | string>`SUM(CASE WHEN ${ct.started_at} >= ${dayAgo} THEN 1 ELSE 0 END)`,
      turns7: sql<number | string>`COUNT(*)`,
      in24: sql<number | string>`SUM(CASE WHEN ${ct.started_at} >= ${dayAgo} THEN ${ct.uncached_input_tokens} + ${ct.cached_input_tokens} ELSE 0 END)`,
      in7: sql<number | string>`SUM(${ct.uncached_input_tokens} + ${ct.cached_input_tokens})`,
      out24: sql<number | string>`SUM(CASE WHEN ${ct.started_at} >= ${dayAgo} THEN ${ct.output_tokens} ELSE 0 END)`,
      out7: sql<number | string>`SUM(${ct.output_tokens})`,
      last: sql<number | string>`MAX(${ct.started_at})`,
    })
    .from(ct)
    .where(gte(ct.started_at, weekAgo))
    .groupBy(ct.user_id);

  const replies = await client
    .select({
      user_id: rp.user_id,
      source: rp.source,
      r24: sql<number | string>`SUM(CASE WHEN ${rp.occurred_at} >= ${dayAgo} THEN 1 ELSE 0 END)`,
      r7: sql<number | string>`COUNT(*)`,
      last: sql<number | string>`MAX(${rp.occurred_at})`,
    })
    .from(rp)
    .where(and(gte(rp.occurred_at, weekAgo), sql`${rp.source} IN ('chatgpt_chat', 'chatgpt_work')`))
    .groupBy(rp.user_id, rp.source);

  const byUser = new Map<string, OpenAiPersonActivity>();
  const get = (id: string) => {
    let e = byUser.get(id);
    if (!e) { e = blank(id); byUser.set(id, e); }
    return e;
  };
  for (const t of turns) {
    const e = get(t.user_id);
    e.codex_turns_24h = Number(t.turns24) || 0;
    e.codex_turns_7d = Number(t.turns7) || 0;
    e.codex_input_tokens_24h = Number(t.in24) || 0;
    e.codex_input_tokens_7d = Number(t.in7) || 0;
    e.codex_output_tokens_24h = Number(t.out24) || 0;
    e.codex_output_tokens_7d = Number(t.out7) || 0;
    e.last_at = Math.max(e.last_at, Number(t.last) || 0);
  }
  for (const r of replies) {
    const e = get(r.user_id);
    if (r.source === 'chatgpt_chat') {
      e.chatgpt_chat_replies_24h = Number(r.r24) || 0;
      e.chatgpt_chat_replies_7d = Number(r.r7) || 0;
    } else {
      e.chatgpt_work_replies_24h = Number(r.r24) || 0;
      e.chatgpt_work_replies_7d = Number(r.r7) || 0;
    }
    e.last_at = Math.max(e.last_at, Number(r.last) || 0);
  }

  return [...byUser.values()]
    .sort((a, b) => b.codex_output_tokens_7d - a.codex_output_tokens_7d
      || (b.chatgpt_chat_replies_7d + b.chatgpt_work_replies_7d) - (a.chatgpt_chat_replies_7d + a.chatgpt_work_replies_7d)
      || a.user_id.localeCompare(b.user_id))
    .slice(0, OPENAI_ACTIVITY_MAX_PEOPLE);
}
