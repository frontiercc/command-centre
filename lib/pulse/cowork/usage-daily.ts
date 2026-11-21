// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Cowork (and Claude in Office and Google) model calls per session, UTC day and model (table
 * cowork_usage_daily, migration 0064): the calls, the cost Claude reported, how many calls carried a
 * cost, and the tokens from each call's token_usage.
 *
 * Pages that add up Cowork model calls (FinOps, Spend Review, Sub Agents, Model Efficiency, Work
 * Pulse) read this table for whole days and the raw calls only for the part-days at the ends of
 * their window. Kept current by the scheduler (job cowork_usage_daily), like the Claude Code daily
 * totals (lib/pulse/code/usage-daily.ts): each run recomputes the session-days its newly arrived
 * calls touch. The first run builds every day.
 *
 * with_usage counts the calls whose token_usage is a JSON object (the rest have no token figures).
 * Tokens are read exactly as parseCoworkTokenUsage reads them: a JSON object's inputTokens,
 * outputTokens, cacheCreationTokens and cacheReadTokens, each as a number or 0.
 */
import { sql, type SQL } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { withTx } from '@/lib/db/with-tx';
import { getConfigValue, setConfigValue } from '@/lib/config';
import { DAY, dayStart, wholeDays } from '@/lib/pulse/code/usage-daily';

export { OPEN_END } from '@/lib/pulse/code/usage-daily';

const SETTLE_SECONDS = 60;
const PAGE = 5000;
const PAIRS_PER_FLUSH = 500;
const MAX_PENDING = 20_000;
const BUDGET_MS = 240_000;
const CURSOR_KEY = 'coworkUsageDailyCursor';

interface RawFacade { execute: (q: unknown) => Promise<{ rows: unknown[] }> }

/** One token_usage field as JavaScript's Number(value) || 0 reads it. */
const tokenField = (key: string) => sql.raw(`
  CASE jsonb_typeof(c.token_usage -> '${key}')
    WHEN 'number' THEN (c.token_usage ->> '${key}')::numeric
    WHEN 'string' THEN CASE WHEN btrim(c.token_usage ->> '${key}') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN btrim(c.token_usage ->> '${key}')::numeric ELSE 0 END
    WHEN 'boolean' THEN CASE WHEN (c.token_usage ->> '${key}') = 'true' THEN 1 ELSE 0 END
    ELSE 0 END`);
const tokens = (key: string) => sql`COALESCE(SUM(CASE WHEN jsonb_typeof(c.token_usage) = 'object' THEN ${tokenField(key)} ELSE 0 END), 0)`;

/** The summary columns from `source` (cowork_messages model-call rows with `day`), grouped by its key. */
function aggregateFrom(source: SQL): SQL {
  return sql`
    SELECT c.session_id, c.day AS day_start,
           COALESCE(c.user_id, '') AS user_id, COALESCE(c.model, '') AS model,
           COALESCE(c.agent_name, '') AS agent_name, COALESCE(c.skill_name, '') AS skill_name,
           COALESCE(c.query_source, '') AS query_source, COALESCE(c.product, '') AS product,
           COALESCE(c.surface, '') AS surface, COALESCE(c.source, '') AS source,
           COUNT(*) AS calls, SUM(c.cost_usd) AS cost_usd, COUNT(c.cost_usd) AS costed,
           COUNT(*) FILTER (WHERE jsonb_typeof(c.token_usage) = 'object') AS with_usage,
           ${tokens('inputTokens')} AS input_tokens, ${tokens('outputTokens')} AS output_tokens,
           ${tokens('cacheCreationTokens')} AS cache_creation_tokens, ${tokens('cacheReadTokens')} AS cache_read_tokens,
           MIN(c.occurred_at) AS first_at, MAX(c.occurred_at) AS last_at
      FROM (${source}) c
     GROUP BY c.session_id, c.day, COALESCE(c.user_id, ''), COALESCE(c.model, ''), COALESCE(c.agent_name, ''),
              COALESCE(c.skill_name, ''), COALESCE(c.query_source, ''), COALESCE(c.product, ''), COALESCE(c.surface, ''),
              COALESCE(c.source, '')`;
}

const COLUMNS = sql`session_id, day_start, user_id, model, agent_name, skill_name, query_source, product, surface, source,
  calls, cost_usd, costed, with_usage, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, first_at, last_at`;

/** Recomputes the given session-days from cowork_messages. */
export async function recomputeCoworkUsageDays(pairs: Array<{ sid: string; day: number }>): Promise<void> {
  if (pairs.length === 0) return;
  const db = await getTypedClient();
  const values = sql.join(pairs.map(p => sql`(${p.sid}::text, ${p.day}::bigint)`), sql`, `);
  await withTx(db, async (tx) => {
    const t = tx as unknown as RawFacade;
    await t.execute(sql`DELETE FROM cowork_usage_daily WHERE (session_id, day_start) IN (SELECT sid, day FROM (VALUES ${values}) AS v(sid, day))`);
    await t.execute(sql`
      INSERT INTO cowork_usage_daily (${COLUMNS})
      ${aggregateFrom(sql`
        SELECT m.*, p.day FROM (VALUES ${values}) AS p(sid, day)
          JOIN cowork_messages m ON m.session_id = p.sid AND m.message_type = 'cowork_api_request'
           AND m.occurred_at >= p.day AND m.occurred_at < p.day + ${DAY}`)}`);
  });
}

/**
 * Retention, delete mode: drops the Cowork-surface days before the cutoff's day and rebuilds the
 * cutoff's own day from the calls still kept. Runs inside the retention transaction (`tx`). In strip
 * mode model calls are kept (they carry no content), so the summary is left alone.
 */
export async function pruneCoworkUsageDaily(tx: unknown, cutoff: number): Promise<void> {
  const t = tx as RawFacade;
  const day = dayStart(cutoff);
  await t.execute(sql`DELETE FROM cowork_usage_daily WHERE day_start <= ${day} AND surface IN ('cowork', '')`);
  await t.execute(sql`
    INSERT INTO cowork_usage_daily (${COLUMNS})
    ${aggregateFrom(sql`
      SELECT m.*, ${day}::bigint AS day FROM cowork_messages m
       WHERE m.message_type = 'cowork_api_request' AND (m.surface = 'cowork' OR m.surface IS NULL)
         AND m.occurred_at >= ${day} AND m.occurred_at < ${day + DAY}`)}`);
}

function parseCursor(raw: string): { ts: number; id: string } | null {
  if (!raw) return null;
  const [ts, ...rest] = raw.split('|');
  const n = Number(ts);
  return Number.isFinite(n) ? { ts: n, id: rest.join('|') } : null;
}

/** Brings cowork_usage_daily up to date with the model calls that arrived since the last run. */
export async function runCoworkUsageDaily(nowS = Math.floor(Date.now() / 1000)): Promise<{ calls: number; days: number; done: boolean }> {
  const db = (await getTypedClient()) as unknown as RawFacade;
  const settled = nowS - SETTLE_SECONDS;
  const started = Date.now();
  let cursor = parseCursor(await getConfigValue(CURSOR_KEY));
  let calls = 0;
  let days = 0;

  // First run: every session-day there is (older rows may have no arrival time), then carry on
  // from the newest arrival time.
  if (!cursor) {
    const top = (await db.execute(sql`
      SELECT COALESCE(MAX(ingested_at), 0) AS ts FROM cowork_messages WHERE message_type = 'cowork_api_request' AND ingested_at <= ${settled}`)).rows[0] as { ts: number | string };
    const pairs = (await db.execute(sql`
      SELECT DISTINCT session_id AS sid, (occurred_at - (((occurred_at % ${DAY}) + ${DAY}) % ${DAY})) AS day
        FROM cowork_messages WHERE message_type = 'cowork_api_request'`)).rows as Array<{ sid: string; day: number | string }>;
    for (let i = 0; i < pairs.length; i += PAIRS_PER_FLUSH) {
      await recomputeCoworkUsageDays(pairs.slice(i, i + PAIRS_PER_FLUSH).map(p => ({ sid: p.sid, day: Number(p.day) })));
    }
    days += pairs.length;
    cursor = { ts: Number(top.ts), id: '￿' };
    await setConfigValue(CURSOR_KEY, `${cursor.ts}|${cursor.id}`);
    return { calls, days, done: true };
  }

  const pending = new Map<string, { sid: string; day: number }>();
  const flush = async () => {
    const pairs = [...pending.values()];
    pending.clear();
    for (let i = 0; i < pairs.length; i += PAIRS_PER_FLUSH) await recomputeCoworkUsageDays(pairs.slice(i, i + PAIRS_PER_FLUSH));
    days += pairs.length;
    await setConfigValue(CURSOR_KEY, `${cursor!.ts}|${cursor!.id}`);
  };
  let done = false;
  for (;;) {
    const page = (await db.execute(sql`
      SELECT id, session_id, occurred_at, ingested_at FROM cowork_messages
       WHERE message_type = 'cowork_api_request' AND ingested_at <= ${settled} AND (ingested_at, id) > (${cursor.ts}, ${cursor.id})
       ORDER BY ingested_at, id LIMIT ${PAGE}
    `)).rows as Array<{ id: string; session_id: string; occurred_at: number | string; ingested_at: number | string }>;
    if (page.length === 0) { done = true; break; }
    for (const r of page) {
      const day = dayStart(Number(r.occurred_at));
      pending.set(`${day}|${r.session_id}`, { sid: r.session_id, day });
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

/**
 * Cowork model calls in [start, end) in the summary's shape: whole days from cowork_usage_daily
 * and the part-days at either end (and today) added up from cowork_messages. `rawWhere` narrows
 * the raw calls (alias m) and `summaryWhere` the summary rows the same way.
 */
export function coworkUsageIn(start: number, end: number, opts: { nowS?: number; rawWhere?: SQL; summaryWhere?: SQL } = {}): SQL {
  const nowS = opts.nowS ?? Math.floor(Date.now() / 1000);
  const whole = wholeDays(start, end, nowS, false);
  const rawWhere = opts.rawWhere ? sql` AND ${opts.rawWhere}` : sql``;
  const summaryWhere = opts.summaryWhere ? sql` AND ${opts.summaryWhere}` : sql``;
  const raw = (a: number, b: number) => aggregateFrom(sql`
    SELECT m.*, (m.occurred_at - (((m.occurred_at % ${DAY}) + ${DAY}) % ${DAY})) AS day
      FROM cowork_messages m WHERE m.message_type = 'cowork_api_request' AND m.occurred_at >= ${a} AND m.occurred_at < ${b}${rawWhere}`);
  if (!whole) return sql`SELECT * FROM (${raw(start, end)}) r0`;
  const parts: SQL[] = [sql`SELECT ${COLUMNS} FROM cowork_usage_daily WHERE day_start >= ${whole.from} AND day_start < ${whole.to}${summaryWhere}`];
  if (start < whole.from) parts.push(sql`SELECT * FROM (${raw(start, whole.from)}) r1`);
  if (whole.to < end) parts.push(sql`SELECT * FROM (${raw(whole.to, end)}) r2`);
  return sql.join(parts, sql` UNION ALL `);
}

/** Runs a query over coworkUsageIn and returns its rows. */
export async function readCoworkUsage<T>(query: SQL): Promise<T[]> {
  const db = (await getTypedClient()) as unknown as RawFacade;
  return (await db.execute(query)).rows as T[];
}
