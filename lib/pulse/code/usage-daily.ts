// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Claude Code use per session, UTC day and model (table code_usage_daily, migration 0063).
 *
 * Pages that add up Claude Code model calls (Developer Pulse, FinOps, Spend Review, Sub Agents,
 * Value, Model Efficiency) read this table for whole days and the raw calls only for the part-days
 * at the ends of their window, so they no longer add up millions of model calls on each visit.
 *
 * Kept current by the scheduler (job code_usage_daily): each run reads the calls that arrived since
 * its cursor (keyset on ingested_at, id), notes each session and day they touch, and recomputes
 * each of those session-days whole from code_assistant_meta. Recomputing is idempotent; calls that
 * arrived in the last SETTLE_SECONDS wait for the next run. The first run builds every day.
 *
 * Prompt counts: each (prompt, model) pair is counted once, in the row of its first call with that
 * model (model_prompts); likewise (prompt, skill, model) and (prompt, subagent, model). A day looks
 * back over the day before, so a prompt that runs past midnight UTC counts on the day it started.
 * Summing a column over rows then gives distinct prompts for that grouping; codeUsageIn reads each
 * window's first day from the raw calls, so a prompt already running when a window starts counts.
 */
import { sql, type SQL } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { withTx } from '@/lib/db/with-tx';
import { getConfigValue, setConfigValue } from '@/lib/config';

export const DAY = 86_400;
const SETTLE_SECONDS = 60;
const PAGE = 5000;
const PAIRS_PER_FLUSH = 500;
const MAX_PENDING = 20_000;
const BUDGET_MS = 240_000;
const CURSOR_KEY = 'codeUsageDailyCursor';

/** The start of the UTC day containing `s`. */
export const dayStart = (s: number) => s - (((s % DAY) + DAY) % DAY);

interface RawFacade { execute: (q: unknown) => Promise<{ rows: unknown[] }> }

/**
 * The summary columns worked out from `source`: code_assistant_meta rows with `day` (the day the row
 * is counted on), `counted` (false for rows read only to see whether a prompt started earlier) and
 * `grp` (rows read for one day's rebuild, kept apart from another day's in the same statement),
 * grouped by the summary's key.
 */
function aggregateFrom(source: SQL): SQL {
  return sql`
    SELECT session_id, day,
           COALESCE(user_id, '') AS user_id, COALESCE(model, '') AS model,
           COALESCE(agent_name, '') AS agent_name, COALESCE(skill_name, '') AS skill_name,
           COALESCE(effort, '') AS effort, (CASE WHEN query_source IS NOT NULL THEN 1 ELSE 0 END) AS recorded,
           COALESCE(source, '') AS source,
           COUNT(*) AS calls,
           COUNT(*) FILTER (WHERE rn_m = 1) AS model_prompts,
           COUNT(*) FILTER (WHERE rn_s = 1) AS skill_prompts,
           COUNT(*) FILTER (WHERE rn_a = 1) AS agent_prompts,
           COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens,
           COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens, COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
           COALESCE(SUM(commit_count), 0) AS commit_count, COALESCE(SUM(error_count), 0) AS error_count,
           COALESCE(SUM(tool_use_count), 0) AS tool_use_count,
           MIN(occurred_at) AS first_at, MAX(occurred_at) AS last_at
      FROM (
        SELECT c.*,
               ROW_NUMBER() OVER (PARTITION BY c.session_id, c.grp, COALESCE(c.prompt_id, c.id), COALESCE(c.model, '')
                                  ORDER BY c.occurred_at, c.id) AS rn_m,
               ROW_NUMBER() OVER (PARTITION BY c.session_id, c.grp, COALESCE(c.prompt_id, c.id), COALESCE(c.skill_name, ''), COALESCE(c.model, '')
                                  ORDER BY c.occurred_at, c.id) AS rn_s,
               ROW_NUMBER() OVER (PARTITION BY c.session_id, c.grp, COALESCE(c.prompt_id, c.id), COALESCE(c.agent_name, ''), COALESCE(c.model, '')
                                  ORDER BY c.occurred_at, c.id) AS rn_a
          FROM (${source}) c
      ) r
     WHERE counted
     GROUP BY session_id, day, COALESCE(user_id, ''), COALESCE(model, ''), COALESCE(agent_name, ''), COALESCE(skill_name, ''),
              COALESCE(effort, ''), (CASE WHEN query_source IS NOT NULL THEN 1 ELSE 0 END), COALESCE(source, '')`;
}

/** Recomputes the given session-days from code_assistant_meta. Returns the rows written. */
export async function recomputeCodeUsageDays(pairs: Array<{ sid: string; day: number }>): Promise<number> {
  if (pairs.length === 0) return 0;
  const db = await getTypedClient();
  const values = sql.join(pairs.map(p => sql`(${p.sid}::text, ${p.day}::bigint)`), sql`, `);
  return withTx(db, async (tx) => {
    const t = tx as unknown as RawFacade;
    await t.execute(sql`DELETE FROM code_usage_daily WHERE (session_id, day_start) IN (SELECT sid, day FROM (VALUES ${values}) AS v(sid, day))`);
    const written = await t.execute(sql`
      INSERT INTO code_usage_daily (session_id, day_start, user_id, model, agent_name, skill_name, effort, recorded, source,
        calls, model_prompts, skill_prompts, agent_prompts, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
        commit_count, error_count, tool_use_count, first_at, last_at)
      ${aggregateFrom(sql`
        SELECT m.*, p.day, p.day AS grp, (m.occurred_at >= p.day) AS counted FROM (VALUES ${values}) AS p(sid, day)
          JOIN code_assistant_meta m ON m.session_id = p.sid AND m.occurred_at >= p.day - ${DAY} AND m.occurred_at < p.day + ${DAY}`)}
      RETURNING 1`);
    return written.rows.length;
  });
}

/**
 * Retention: drops the days before the cutoff's day and rebuilds the cutoff's own day from the calls
 * still kept, so the summary never holds calls that retention has deleted. Runs inside the
 * retention transaction (`tx`).
 */
export async function pruneCodeUsageDaily(tx: unknown, cutoff: number): Promise<void> {
  const t = tx as RawFacade;
  const day = dayStart(cutoff);
  await t.execute(sql`DELETE FROM code_usage_daily WHERE day_start <= ${day}`);
  await t.execute(sql`
    INSERT INTO code_usage_daily (session_id, day_start, user_id, model, agent_name, skill_name, effort, recorded, source,
      calls, model_prompts, skill_prompts, agent_prompts, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
      commit_count, error_count, tool_use_count, first_at, last_at)
    ${aggregateFrom(sql`SELECT m.*, ${day}::bigint AS day, 0 AS grp, TRUE AS counted FROM code_assistant_meta m WHERE m.occurred_at >= ${day} AND m.occurred_at < ${day + DAY}`)}`);
}

function parseCursor(raw: string): { ts: number; id: string } {
  const [ts, ...rest] = (raw || '').split('|');
  const n = Number(ts);
  return { ts: Number.isFinite(n) ? n : -1, id: rest.join('|') };
}

/** Brings code_usage_daily up to date with the model calls that arrived since the last run. */
export async function runCodeUsageDaily(nowS = Math.floor(Date.now() / 1000)): Promise<{ calls: number; days: number; done: boolean }> {
  const db = (await getTypedClient()) as unknown as RawFacade;
  const settled = nowS - SETTLE_SECONDS;
  const started = Date.now();
  const pending = new Map<string, { sid: string; day: number }>();
  let cursor = parseCursor(await getConfigValue(CURSOR_KEY));
  let calls = 0;
  let days = 0;
  let done = false;

  const flush = async () => {
    const pairs = [...pending.values()];
    pending.clear();
    for (let i = 0; i < pairs.length; i += PAIRS_PER_FLUSH) {
      await recomputeCodeUsageDays(pairs.slice(i, i + PAIRS_PER_FLUSH));
      days += Math.min(PAIRS_PER_FLUSH, pairs.length - i);
    }
    // The cursor moves only once every day its calls touch is written.
    await setConfigValue(CURSOR_KEY, `${cursor.ts}|${cursor.id}`);
  };

  for (;;) {
    const page = (await db.execute(sql`
      SELECT id, session_id, occurred_at, ingested_at FROM code_assistant_meta
       WHERE ingested_at <= ${settled} AND (ingested_at, id) > (${cursor.ts}, ${cursor.id})
       ORDER BY ingested_at, id LIMIT ${PAGE}
    `)).rows as Array<{ id: string; session_id: string; occurred_at: number | string; ingested_at: number | string }>;
    if (page.length === 0) { done = true; break; }
    for (const r of page) {
      const day = dayStart(Number(r.occurred_at));
      pending.set(`${day}|${r.session_id}`, { sid: r.session_id, day });
      // The next day's prompt counts look back at this one.
      if (day + DAY <= dayStart(nowS)) pending.set(`${day + DAY}|${r.session_id}`, { sid: r.session_id, day: day + DAY });
    }
    calls += page.length;
    const last = page[page.length - 1];
    cursor = { ts: Number(last.ingested_at), id: last.id };
    if (pending.size >= MAX_PENDING) await flush();
    if (page.length < PAGE) { done = true; break; }
    if (Date.now() - started > BUDGET_MS) break;
  }
  await flush();
  return { calls, days, done };
}

/** The whole UTC days inside [start, end) that come from the summary; the rest come from raw calls. */
export function wholeDays(start: number, end: number, nowS: number): { from: number; to: number } | null {
  // The first day always comes from the raw calls too, even when the window starts at midnight:
  // a prompt already running at the window's start counts in the window, as it does in the raw calls.
  const from = dayStart(start) + DAY;
  // Today always comes from the raw calls: the summary can be a few minutes behind.
  const to = Math.min(dayStart(end), dayStart(nowS));
  return to > from ? { from, to } : null;
}

/**
 * Claude Code use in [start, end) in the summary's shape: whole days from code_usage_daily and the
 * part-days at either end (and today) added up from code_assistant_meta. Use as a FROM source and
 * group or filter it like the summary table. `rawWhere` narrows the raw calls (column names of
 * code_assistant_meta) and `summaryWhere` the summary rows the same way.
 */
export function codeUsageIn(start: number, end: number, opts: { nowS?: number; rawWhere?: SQL; summaryWhere?: SQL } = {}): SQL {
  const nowS = opts.nowS ?? Math.floor(Date.now() / 1000);
  const whole = wholeDays(start, end, nowS);
  const rawWhere = opts.rawWhere ? sql` AND ${opts.rawWhere}` : sql``;
  const summaryWhere = opts.summaryWhere ? sql` AND ${opts.summaryWhere}` : sql``;
  // Raw calls in [a, b), looking back to `lookFrom` so a prompt already counted on an earlier
  // summary day is not counted again.
  const raw = (a: number, b: number, lookFrom: number) => aggregateFrom(sql`
    SELECT m.*, ${sql.raw(`(m.occurred_at - (((m.occurred_at % ${DAY}) + ${DAY}) % ${DAY}))`)} AS day, 0 AS grp, (m.occurred_at >= ${a}) AS counted
      FROM code_assistant_meta m WHERE m.occurred_at >= ${lookFrom} AND m.occurred_at < ${b}${rawWhere}`);
  const cols = sql`session_id, day_start, user_id, model, agent_name, skill_name, effort, recorded, source,
    calls, model_prompts, skill_prompts, agent_prompts, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
    commit_count, error_count, tool_use_count, first_at, last_at`;
  if (!whole) return sql`SELECT * FROM (${raw(start, end, start)}) r0`;
  const parts: SQL[] = [sql`SELECT ${cols} FROM code_usage_daily WHERE day_start >= ${whole.from} AND day_start < ${whole.to}${summaryWhere}`];
  if (start < whole.from) parts.push(sql`SELECT * FROM (${raw(start, whole.from, start)}) r1`);
  if (whole.to < end) parts.push(sql`SELECT * FROM (${raw(whole.to, end, Math.max(start, whole.to - DAY))}) r2`);
  return sql.join(parts, sql` UNION ALL `);
}
