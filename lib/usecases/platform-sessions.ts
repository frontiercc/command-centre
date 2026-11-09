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

export interface PlatformHours {
  /** Measured hours on Claude's sessions (Cowork and Claude Code); null when none carries measured time. */
  claude: number | null;
  /** ChatGPT and Codex together; null when none carries measured time, or when ChatGPT and Codex are hidden. */
  openai: number | null;
}

interface HoursRow {
  use_case_id: string;
  claude_n: number | string; claude_s: number | string | null;
  openai_n: number | string; openai_s: number | string | null;
}

function toHours(n: number | string, s: number | string | null): number | null {
  if (Number(n) === 0) return null;
  return Math.round((Number(s ?? 0) / 3600) * 10) / 10;
}

/**
 * Measured hours per vendor for every use case, over the same window and
 * session-id rules as getUseCasePlatformSessions (each session in its
 * earliest matched week, as the headline hours count it), summing active time the way
 * buildUseCaseImpact's per-product lines do: Claude = cowork_session_stats +
 * code_session_stats, ChatGPT = chatgpt_session_time, Codex = its
 * code_session_stats rows. Null-aware: a vendor with no measured active time
 * is null (not measured), never 0.
 */
export async function getUseCasePlatformHours(
  nowS: number,
  opts: { openaiShown: boolean },
): Promise<Map<string, PlatformHours>> {
  const windowStarts = weekStarts(nowS - WEEK, WINDOW_WEEKS);
  const client = await getTypedClient();
  // Each session counts in the earliest week it matched, the rule the weekly
  // measured hours use (lib/usecases/impact-rollup.ts), so the two parts add
  // up to the headline hours: a session first matched before the window is
  // left out here exactly as it is there.
  const res = await (client as unknown as { execute: (q: unknown) => Promise<{ rows: HoursRow[] }> }).execute(sql`
    WITH firsts AS (
      SELECT use_case_id, session_id, MIN(week_start) AS first_week
        FROM use_case_week_matches
       WHERE session_id <> ''
       GROUP BY use_case_id, session_id
    ),
    s AS (
      SELECT use_case_id, session_id
        FROM firsts
       WHERE first_week IN (${sql.join(windowStarts.map(w => sql`${w}`), sql`, `)})
    ),
    t AS (
      SELECT s.use_case_id, 'claude' AS v, c.active_secs
        FROM s JOIN cowork_session_stats c ON c.session_id = s.session_id
       WHERE s.session_id NOT LIKE 'chatgpt:%' AND s.session_id NOT LIKE 'codex:%'
      UNION ALL
      SELECT s.use_case_id, 'claude', d.active_secs
        FROM s JOIN code_session_stats d ON d.session_id = s.session_id
       WHERE s.session_id NOT LIKE 'chatgpt:%' AND s.session_id NOT LIKE 'codex:%'
      UNION ALL
      SELECT s.use_case_id, 'openai', g.active_secs
        FROM s JOIN chatgpt_session_time g ON g.session_id = s.session_id
       WHERE s.session_id LIKE 'chatgpt:%'
      UNION ALL
      SELECT s.use_case_id, 'openai', d.active_secs
        FROM s JOIN code_session_stats d ON d.session_id = s.session_id
       WHERE s.session_id LIKE 'codex:%'
    )
    SELECT use_case_id,
           COUNT(active_secs) FILTER (WHERE v = 'claude') AS claude_n,
           SUM(active_secs) FILTER (WHERE v = 'claude') AS claude_s,
           COUNT(active_secs) FILTER (WHERE v = 'openai') AS openai_n,
           SUM(active_secs) FILTER (WHERE v = 'openai') AS openai_s
      FROM t
     GROUP BY use_case_id`);
  const out = new Map<string, PlatformHours>();
  for (const r of res.rows) {
    out.set(r.use_case_id, {
      claude: toHours(r.claude_n, r.claude_s),
      openai: opts.openaiShown ? toHours(r.openai_n, r.openai_s) : null,
    });
  }
  return out;
}
