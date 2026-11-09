// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Sessions per vendor for every use case, over the same 13 completed weeks
 * the use case page's Workflow Impact panel counts, so the register's
 * "Claude 12 · OpenAI 4" adds up to that panel's per-product lines.
 *
 * A session is the vendor's when its id says so (`chatgpt:` ChatGPT,
 * `codex:` Codex, anything else Claude) and it has a row in that product's
 * session table, the same two rules buildUseCaseImpact applies. One query
 * for the whole register; measured, no model.
 */
import { sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { weekStarts } from '@/lib/pulse/period';

const WEEK = 7 * 86400;
const WINDOW_WEEKS = 13;

export interface PlatformSessions {
  claude: number;
  /** ChatGPT and Codex together; null when ChatGPT and Codex are hidden. */
  openai: number | null;
}

interface Row { use_case_id: string; claude: number | string; openai: number | string }

export async function getUseCasePlatformSessions(
  nowS: number,
  opts: { openaiShown: boolean },
): Promise<Map<string, PlatformSessions>> {
  const windowStarts = weekStarts(nowS - WEEK, WINDOW_WEEKS);
  const client = await getTypedClient();
  const res = await (client as unknown as { execute: (q: unknown) => Promise<{ rows: Row[] }> }).execute(sql`
    WITH s AS (
      SELECT DISTINCT use_case_id, session_id
        FROM use_case_week_matches
       WHERE session_id <> ''
         AND week_start IN (${sql.join(windowStarts.map(w => sql`${w}`), sql`, `)})
    )
    SELECT s.use_case_id,
           COUNT(*) FILTER (
             WHERE s.session_id NOT LIKE 'chatgpt:%' AND s.session_id NOT LIKE 'codex:%'
               AND (EXISTS (SELECT 1 FROM cowork_session_stats c WHERE c.session_id = s.session_id)
                 OR EXISTS (SELECT 1 FROM code_session_stats d WHERE d.session_id = s.session_id))
           ) AS claude,
           COUNT(*) FILTER (
             WHERE (s.session_id LIKE 'chatgpt:%'
                    AND EXISTS (SELECT 1 FROM chatgpt_session_time t WHERE t.session_id = s.session_id))
                OR (s.session_id LIKE 'codex:%'
                    AND EXISTS (SELECT 1 FROM code_session_stats d WHERE d.session_id = s.session_id))
           ) AS openai
      FROM s
     GROUP BY s.use_case_id`);
  const out = new Map<string, PlatformSessions>();
  for (const r of res.rows) {
    out.set(r.use_case_id, {
      claude: Number(r.claude),
      openai: opts.openaiShown ? Number(r.openai) : null,
    });
  }
  return out;
}
