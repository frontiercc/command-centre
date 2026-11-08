// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Working time for ChatGPT conversations (OpenAI Compliance API), into
// chatgpt_session_time (migration 0046), for Work Pulse's human time card.
// A conversation's time is measured the way Claude Cowork's is: the gaps
// between consecutive events, counting gaps up to 30 minutes
// (lib/pulse/session-active-time.ts). ChatGPT's events are the person's
// prompts and ChatGPT's replies; the export gives no other timings.
//
// Recomputed for every conversation with a prompt in the window, so late
// replies are picked up; an estimate already written is kept.
import { sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { activeSecondsFromTimestamps } from '@/lib/pulse/session-active-time';

interface RawFacade {
  execute: (q: unknown) => Promise<{ rows: unknown[] }>;
}

export const WINDOW_DAYS = 30;

/** Rolls up the last WINDOW_DAYS of ChatGPT conversations; returns how many were written. */
export async function rollupChatgptSessionTime(nowS = Math.floor(Date.now() / 1000)): Promise<number> {
  const client = await getTypedClient();
  const raw = client as unknown as RawFacade;
  const since = nowS - WINDOW_DAYS * 86400;
  const res = await raw.execute(sql`
    SELECT p.session_id, MAX(p.user_id) AS user_id, MAX(p.source) AS source,
           array_agg(p.occurred_at) AS prompt_times,
           (SELECT array_agg(r.occurred_at) FROM openai_replies r WHERE r.session_id = p.session_id) AS reply_times
    FROM cowork_messages p
    WHERE p.source IN ('chatgpt_chat', 'chatgpt_work')
      AND p.message_type = 'cowork_user_message'
      AND p.session_id LIKE 'chatgpt:%'
      AND p.user_id IS NOT NULL
      AND p.session_id IN (
        SELECT DISTINCT session_id FROM cowork_messages
        WHERE source IN ('chatgpt_chat', 'chatgpt_work') AND occurred_at >= ${since}
      )
    GROUP BY p.session_id
  `);
  const t = schema.chatgptSessionTime;
  let written = 0;
  for (const row of res.rows as Array<{ session_id: string; user_id: string; source: string; prompt_times: Array<number | string>; reply_times: Array<number | string> | null }>) {
    const times = [...row.prompt_times, ...(row.reply_times ?? [])].map(Number).filter(Number.isFinite);
    if (times.length === 0) continue;
    const values = {
      user_id: row.user_id,
      source: row.source,
      first_at: Math.min(...times),
      last_at: Math.max(...times),
      active_secs: activeSecondsFromTimestamps(times),
      computed_at: nowS,
    };
    await client.insert(t).values({ session_id: row.session_id, ...values })
      .onConflictDoUpdate({ target: t.session_id, set: values });
    written++;
  }
  return written;
}
