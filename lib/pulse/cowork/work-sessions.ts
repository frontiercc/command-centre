// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Every Work Pulse session over a window, on every platform Work Pulse covers, with the measured
 * facts each platform gives: how long it took, the by-hand estimate where one was made, and
 * whether it produced something. One rule, so Team coaching, So What and the panels never count
 * a platform two ways.
 *
 *   Claude Cowork and Claude in Office/Google   cowork_session_stats (Claude's telemetry)
 *   Claude Chat                                 its prompts in cowork_messages (surface 'chat'),
 *                                               with chat_assistant_meta for what the replies made
 *                                               and when; its time is measured the way ChatGPT's
 *                                               is, from the gaps between prompts and replies
 *                                               (lib/pulse/session-active-time.ts)
 *   ChatGPT Chat and Work                       chatgpt_session_time, with openai_replies for the
 *                                               files OpenAI lists on its replies
 *
 * A fact a platform does not give is null, never 0. A Claude Chat conversation produced something
 * when a reply made an artifact or a generated file, a ChatGPT one when a reply listed a file; with
 * no reply record at all it is not measured, which is different from producing nothing.
 *
 * Each session also carries the names of what it produced, where the platform gave them: a Cowork
 * or Office output's file name (cowork_messages.output_name), a Claude Chat reply's artifact titles
 * and file names, a ChatGPT reply's file names (migration 0054). Names only, masked when stored.
 */
import { sql, type SQL } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { vendorClause } from '@/lib/dashboard/product-sql';
import { isWorkPulseSurface } from '@/lib/pulse/work-surfaces';
import { activeSecondsFromTimestamps } from '@/lib/pulse/session-active-time';
import type { Vendor } from '@/lib/dashboard/vendor';

/** Which platform a session came from, as the panels name them. */
export type WorkPlatform = 'claude_work' | 'claude_chat' | 'chatgpt';

export interface WorkSession {
  sessionId: string;
  userId: string;
  /** The person's department: the login account's first, then the monitored record's. */
  department: string | null;
  platform: WorkPlatform;
  /** Measured active time. Null where the platform gives none. */
  activeSecs: number | null;
  /** Claude's estimate of the time by hand. Judged, and null where none was made. */
  humanMinutes: number | null;
  /** Whether the session produced something. Null where it was not measured. */
  produced: boolean | null;
  /** When the session last had activity. */
  lastAt: number | null;
  /** The names of what it produced, comma-separated. Null where none were given. */
  outputs: string | null;
  /** For Claude in Office or Google, the app ('word', 'sheets' and so on); null otherwise. */
  product: string | null;
}

interface Row {
  session_id: string;
  user_id: string;
  department: string | null;
  platform: WorkPlatform;
  active_secs: number | string | null;
  human_minutes: number | string | null;
  produced: number | string | null;
  last_at: number | string | null;
  outputs: string | null;
  product: string | null;
}

const num = (v: number | string | null): number | null => (v === null || v === undefined ? null : Number(v));

/** A person's department, as everywhere else on these pages. Needs `u` and `au` joined. */
const DEPARTMENT = sql`COALESCE(NULLIF(au.department, ''), NULLIF(u.department, ''))`;

const people = (column: SQL) => sql`
  LEFT JOIN users u ON u.id = ${column}
  LEFT JOIN admin_users au ON au.linked_cowork_user_id = ${column}`;

/**
 * Sessions whose last activity falls in [since, until). The vendor narrows it the way the
 * All / Claude / ChatGPT switch does; a route passes the visible vendor, so ChatGPT is left
 * out whenever an admin has hidden it.
 */
export async function readWorkSessions(opts: { since: number; until?: number; vendor: Vendor; userIds?: string[] }): Promise<WorkSession[]> {
  if (opts.userIds && opts.userIds.length === 0) return [];
  const client = await getTypedClient();
  const run = async (q: SQL) =>
    (await (client as unknown as { execute: (query: SQL) => Promise<{ rows: unknown[] }> }).execute(q)).rows as Row[];
  const until = opts.until ?? Number.MAX_SAFE_INTEGER;
  const who = (column: SQL) => (opts.userIds ? sql`AND ${column} IN (${sql.join(opts.userIds.map(id => sql`${id}`), sql`, `)})` : sql``);
  const parts: SQL[] = [];

  if (opts.vendor !== 'openai') {
    // Claude Cowork and Claude in Office/Google: the session aggregator's rows, from telemetry.
    parts.push(sql`
      SELECT css.session_id, css.user_id, ${DEPARTMENT} AS department, 'claude_work' AS platform,
             css.active_secs, css.human_minutes_likely AS human_minutes, css.produced_output AS produced,
             css.last_event_at AS last_at,
             (SELECT STRING_AGG(DISTINCT cm.output_name, ', ') FROM cowork_messages cm
               WHERE cm.session_id = css.session_id AND cm.output_name IS NOT NULL) AS outputs,
             (SELECT MAX(cm.product) FROM cowork_messages cm WHERE cm.session_id = css.session_id) AS product
      FROM cowork_session_stats css ${people(sql`css.user_id`)}
      WHERE css.last_event_at >= ${opts.since} AND css.last_event_at < ${until} ${who(sql`css.user_id`)}`);
  }

  if (opts.vendor !== 'claude') {
    // ChatGPT Chat and Work: the conversation time rollup, and what its replies made: a reply OpenAI
    // lists files on made something. Replies stored before the count was kept are not measured.
    parts.push(sql`
      SELECT g.session_id, g.user_id, ${DEPARTMENT} AS department, 'chatgpt' AS platform,
             g.active_secs, g.human_minutes_likely AS human_minutes,
             (SELECT CASE WHEN COUNT(r.files_count) = 0 THEN NULL
                          WHEN SUM(r.files_count) > 0 THEN 1 ELSE 0 END
              FROM openai_replies r WHERE r.session_id = g.session_id) AS produced,
             g.last_at,
             (SELECT STRING_AGG(DISTINCT r.file_names, ', ') FROM openai_replies r
               WHERE r.session_id = g.session_id AND r.file_names IS NOT NULL) AS outputs,
             NULL AS product
      FROM chatgpt_session_time g ${people(sql`g.user_id`)}
      WHERE g.last_at >= ${opts.since} AND g.last_at < ${until} ${who(sql`g.user_id`)}`);
  }

  const rows = parts.length === 0 ? [] : await run(sql.join(parts, sql` UNION ALL `));
  const out: WorkSession[] = rows.map(r => {
    const produced = num(r.produced);
    return {
      sessionId: r.session_id,
      userId: r.user_id,
      department: r.department,
      platform: r.platform,
      activeSecs: num(r.active_secs),
      humanMinutes: num(r.human_minutes),
      produced: produced === null ? null : produced > 0,
      lastAt: num(r.last_at),
      outputs: r.outputs,
      product: r.product,
    };
  });

  if (opts.vendor !== 'openai') {
    // Claude Chat: one session per conversation, from the person's own prompts, with the times of
    // their prompts and of the replies, and what the replies made. No by-hand estimate is made.
    const chats = (await (client as unknown as { execute: (query: SQL) => Promise<{ rows: unknown[] }> }).execute(sql`
      SELECT c.session_id, c.user_id, ${DEPARTMENT} AS department, c.prompt_times,
             (SELECT array_agg(m.occurred_at) FROM chat_assistant_meta m WHERE m.conversation_id = c.session_id) AS reply_times,
             (SELECT CASE WHEN COUNT(*) = 0 THEN NULL
                          WHEN SUM(m.artifacts_count + m.generated_files_count) > 0 THEN 1 ELSE 0 END
              FROM chat_assistant_meta m WHERE m.conversation_id = c.session_id) AS produced,
             (SELECT STRING_AGG(DISTINCT m.output_names, ', ') FROM chat_assistant_meta m
               WHERE m.conversation_id = c.session_id AND m.output_names IS NOT NULL) AS outputs
      FROM (
        SELECT cm.session_id, MAX(cm.user_id) AS user_id, array_agg(cm.occurred_at) AS prompt_times
        FROM cowork_messages cm
        WHERE cm.surface = 'chat' AND cm.message_type = 'cowork_user_message'
          AND cm.session_id IS NOT NULL AND cm.user_id IS NOT NULL
          -- Only conversations with a prompt in the window (the surface and time index finds them),
          -- so the grouping below reads those, not every conversation ever held. A conversation
          -- whose last prompt is in the window always has one there, so the answer is the same.
          AND cm.session_id IN (
            SELECT w.session_id FROM cowork_messages w
            WHERE w.surface = 'chat' AND w.message_type = 'cowork_user_message'
              AND w.occurred_at >= ${opts.since} AND w.occurred_at < ${until}
          )
        GROUP BY cm.session_id
        HAVING MAX(cm.occurred_at) >= ${opts.since} AND MAX(cm.occurred_at) < ${until}
      ) c ${people(sql`c.user_id`)}
      WHERE TRUE ${who(sql`c.user_id`)}
    `)).rows as Array<{
      session_id: string; user_id: string; department: string | null;
      prompt_times: Array<number | string>; reply_times: Array<number | string> | null; produced: number | string | null;
      outputs: string | null;
    }>;
    for (const c of chats) {
      const times = [...c.prompt_times, ...(c.reply_times ?? [])].map(Number).filter(Number.isFinite);
      const produced = num(c.produced);
      out.push({
        sessionId: c.session_id,
        userId: c.user_id,
        department: c.department,
        platform: 'claude_chat',
        // Measured from the gaps between events; a conversation with one event has no measured span.
        activeSecs: times.length > 1 ? activeSecondsFromTimestamps(times) : null,
        humanMinutes: null,
        produced: produced === null ? null : produced > 0,
        lastAt: times.length > 0 ? Math.max(...times) : null,
        outputs: c.outputs,
        product: null,
      });
    }
  }
  return out;
}

/** How many conversations each person had in the window, on every platform the vendor covers. */
export async function readSessionsPerPerson(opts: { since: number; until?: number; vendor: Vendor }): Promise<Map<string, number>> {
  const client = await getTypedClient();
  const until = opts.until ?? Number.MAX_SAFE_INTEGER;
  const rows = (await (client as unknown as { execute: (query: SQL) => Promise<{ rows: unknown[] }> }).execute(sql`
    SELECT cm.user_id, COUNT(DISTINCT cm.session_id) AS sessions
    FROM cowork_messages cm
    WHERE cm.message_type = 'cowork_user_message' AND ${isWorkPulseSurface(sql`cm.surface`, true)}
      AND cm.session_id IS NOT NULL AND cm.user_id IS NOT NULL
      AND cm.occurred_at >= ${opts.since} AND cm.occurred_at < ${until}
      AND ${sql.raw(vendorClause(opts.vendor, 'cm.'))}
    GROUP BY cm.user_id
  `)).rows as Array<{ user_id: string; sessions: number | string }>;
  return new Map(rows.map(r => [r.user_id, Number(r.sessions)]));
}
