// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Cowork session stats aggregator.
 *
 * Rolls up per-session statistics from the cowork_messages rows inserted by
 * the OTel receiver (source='otel'). Produces one row in cowork_session_stats
 * per session. Safe to run multiple times — UPSERT on session_id.
 *
 * What it aggregates:
 *   cowork_api_request rows  → token totals, cost, model list
 *   cowork_tool_metadata rows → tool call count, unique tool names
 *   cowork_messages (all)    → duration (first/last occurred_at)
 *   cowork_sessions           → upload count (from files_uploaded JSON)
 *
 * Called by: /api/pulse/cowork/aggregate (on-demand) and
 * runCoworkSessionAggJob() (lib/ingestion/scheduler.ts, hourly).
 *
 * Token extraction is done in JS, not SQL: Postgres's `::jsonb` cast THROWS
 * on invalid JSON, which would abort the whole per-session SUM the moment any
 * one row's content_preview didn't parse. This fetches the raw
 * `content_preview`/`cost_usd`/`model` columns for the session's OTel
 * api_request + tool_metadata rows ONE time via the Drizzle query builder,
 * then parses/sums/aggregates entirely in JS — NULL-tolerant BY CONSTRUCTION
 * (a JS try/catch around JSON.parse) — see
 * .git/sdd/task-3.7b-report.md for the full rationale and the confirmed
 * write-side contract (lib/otel/cowork-receiver.ts's `claude_code.api_request`
 * handler always writes `"<model|unknown> | {4-key JSON, values number|null}"`,
 * so content_preview is always well-formed for source='otel' rows — the
 * malformed-row tolerance here is defence in depth, not a known live case).
 */

import { and, eq, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getConfigValue, setConfigValue } from '@/lib/config';
import { activeSecondsFromTimestamps } from '@/lib/pulse/session-active-time';
import { OUTPUT_TOOLS } from '@/lib/pulse/cowork/session-output';
import { STRIPPED_MARKER } from '@/lib/retention/cleanup';

interface ApiRequestPreview {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
}

export interface AggregateResult {
  sessionsProcessed: number;
  sessionsUpserted: number;
  errors: string[];
  /**
   * How many additional candidate sessions were pending beyond this run's
   * `limit` cap — a lower bound (peeked via a `limit+1` fetch, not a full
   * COUNT scan), just enough to tell a caller "there's more" without an
   * expensive extra query. Left-over candidates are naturally picked up by
   * the next run (no cursor needed — a session stays a candidate until its
   * stats row exists and is fresh).
   */
  remaining: number;
}

const DEFAULT_LIMIT = 500;

/**
 * Parse one cowork_messages.content_preview value written for a
 * cowork_api_request row (format: "<model> | {JSON}"). Returns null for any
 * row that doesn't match — missing separator, or a tail that isn't valid
 * JSON — a malformed row is excluded from the sums and the loop continues.
 */
function parseApiRequestTokens(contentPreview: string | null): ApiRequestPreview | null {
  if (!contentPreview) return null;
  const sepIndex = contentPreview.indexOf(' | ');
  if (sepIndex < 0) return null;
  const jsonTail = contentPreview.slice(sepIndex + 3);
  try {
    const parsed: unknown = JSON.parse(jsonTail);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as ApiRequestPreview;
  } catch {
    return null;
  }
}

/**
 * Aggregate stats for all OTel sessions that either have no stats row yet,
 * or whose last message is newer than their computed_at timestamp.
 *
 * Pass `sessionId` to run for a single session only (useful after ingest).
 * Pass `limit` to cap how many candidate sessions this run processes
 * (default 500) — any left over are reported in `remaining` and are picked
 * up naturally by the next run.
 */
export async function aggregateCoworkSessionStats(sessionId?: string, limit = DEFAULT_LIMIT): Promise<AggregateResult> {
  const client = await getTypedClient();
  const now = Math.floor(Date.now() / 1000);
  const result: AggregateResult = { sessionsProcessed: 0, sessionsUpserted: 0, errors: [], remaining: 0 };

  // Find sessions needing aggregation. Plain bigint comparisons (no date
  // bucketing) — kept as one raw statement since
  // the 2-table JOIN + correlated MAX() subquery is clearer raw than built
  // via the query builder (Rule 2). Fetches up to limit+1 rows so the (limit+1)th
  // row's presence tells us there's more pending without a separate COUNT query.
  const fetched = await rawSessionsNeedingAggregation(client, sessionId, limit + 1);
  const capped = fetched.length > limit;
  result.remaining = capped ? fetched.length - limit : 0;
  const sessions = capped ? fetched.slice(0, limit) : fetched;

  for (const { session_id, user_id } of sessions) {
    result.sessionsProcessed++;
    try {
      const cm = schema.coworkMessages;

      // One query for every OTel row in the session — api_request rows feed
      // tokens/cost/models, tool_metadata rows feed tool stats, and (across
      // ALL rows) occurred_at feeds first/last timing. See the file header
      // for why token extraction is done here in JS rather than in SQL.
      const msgRows = await client
        .select({
          message_type: cm.message_type,
          content_preview: cm.content_preview,
          cost_usd: cm.cost_usd,
          model: cm.model,
          occurred_at: cm.occurred_at,
          tool_success: cm.tool_success,
        })
        .from(cm)
        .where(and(
          eq(cm.session_id, session_id),
          eq(cm.source, 'otel'),
          sql`COALESCE(${cm.surface}, 'cowork') = 'cowork'`,
        ));

      let inputTokens = 0;
      let outputTokens = 0;
      let cacheRead = 0;
      let cacheCreate = 0;
      let totalCost: number | null = null;
      const modelsUsedSet = new Set<string>();
      let toolCallCount = 0;
      const uniqueToolsSet = new Set<string>();
      // Did this session produce anything? Set the moment an output-producing
      // tool call SUCCEEDS. Recorded here rather than derived later because
      // this is the only place both the tool name and tool_success are in
      // hand: unique_tools keeps the name regardless of success, and the raw
      // message rows that carry success lose their tool name to retention.
      // See lib/pulse/cowork/session-output.ts for what counts and why.
      let producedOutput = false;
      // Retention's strip mode overwrites content_preview — which on a
      // tool_metadata row IS the tool name — so a stripped session cannot be
      // judged either way. Recording 0 there would assert "produced nothing"
      // about a session we simply cannot read, and the whole metric would
      // read 0% on any instance whose retention window has already passed.
      // Unknown is NULL, and NULL is excluded from the rate entirely.
      let toolNamesUnreadable = false;
      let firstAt: number | null = null;
      let lastAt: number | null = null;
      const eventTimestamps: number[] = [];

      for (const row of msgRows) {
        if (row.occurred_at !== null && row.occurred_at !== undefined) {
          const occurredAt = Number(row.occurred_at);
          firstAt = firstAt === null ? occurredAt : Math.min(firstAt, occurredAt);
          lastAt = lastAt === null ? occurredAt : Math.max(lastAt, occurredAt);
          eventTimestamps.push(occurredAt);
        }

        if (row.message_type === 'cowork_api_request') {
          const parsed = parseApiRequestTokens(row.content_preview);
          if (parsed) {
            if (typeof parsed.inputTokens === 'number') inputTokens += parsed.inputTokens;
            if (typeof parsed.outputTokens === 'number') outputTokens += parsed.outputTokens;
            if (typeof parsed.cacheReadTokens === 'number') cacheRead += parsed.cacheReadTokens;
            if (typeof parsed.cacheCreationTokens === 'number') cacheCreate += parsed.cacheCreationTokens;
          }
          // cost_usd is a `numeric` column (Drizzle always decodes numeric
          // as a STRING to avoid
          // silent precision loss) — Number()-coerce at the read site
          // (Policy B) before accumulating.
          if (row.cost_usd !== null && row.cost_usd !== undefined) {
            totalCost = (totalCost ?? 0) + Number(row.cost_usd);
          }
          if (row.model) modelsUsedSet.add(row.model);
        } else if (row.message_type === 'cowork_tool_metadata') {
          toolCallCount++;
          if (row.content_preview) {
            uniqueToolsSet.add(row.content_preview);
            if (row.content_preview === STRIPPED_MARKER) {
              toolNamesUnreadable = true;
            } else if (Number(row.tool_success) === 1 && OUTPUT_TOOLS.has(row.content_preview)) {
              // tool_success is 1/0; the receiver defaults an absent success
              // attribute to success, so an unflagged call counts — the same
              // conservative reading cowork_tool_error_count already takes.
              producedOutput = true;
            }
          }
        }
      }

      // A readable output tool beats an unreadable row — if we SAW something
      // get produced, a stripped sibling row cannot take that away. Otherwise
      // any stripped row makes the answer unknowable.
      const producedOutputValue = producedOutput ? 1 : (toolNamesUnreadable ? null : 0);

      const modelsUsed = JSON.stringify(Array.from(modelsUsedSet));
      const uniqueTools = JSON.stringify(Array.from(uniqueToolsSet));
      const durationSecs = (firstAt !== null && lastAt !== null) ? lastAt - firstAt : null;
      // Gap-based active time — see lib/pulse/session-
      // active-time.ts for why this replaces wall-clock duration as the
      // "measured session time" figure everywhere it's consumed.
      const activeSecs = activeSecondsFromTimestamps(eventTimestamps);

      // Upload count from cowork_sessions
      const sessionRows = await client
        .select({ files_uploaded: schema.coworkSessions.files_uploaded })
        .from(schema.coworkSessions)
        .where(eq(schema.coworkSessions.id, session_id))
        .limit(1);
      const sessionRow = sessionRows[0];

      let uploadCount = 0;
      if (sessionRow?.files_uploaded) {
        try {
          uploadCount = (JSON.parse(sessionRow.files_uploaded) as string[]).length;
        } catch { /* ignore */ }
      }

      // cowork_session_stats.session_id carries a hard FK to cowork_sessions.id
      // (cowork_messages.session_id does NOT — that asymmetry is exactly what let
      // historic/ETL'd/seeded message-only sessions pile up uncounted, since the
      // discovery query used to require a cowork_sessions row to even become a
      // candidate). Now that the candidate query no longer requires one, a
      // missing row here would fail the upsert below — so create a minimal stub,
      // mirroring the same "ensure session exists" pattern lib/otel/cowork-
      // receiver.ts already uses at ingest time (INSERT OR IGNORE, safe under
      // concurrent runs). A real OTel ingest always writes a full row on its
      // own, so this only ever fires for pre-existing orphaned sessions.
      if (!sessionRow) {
        await client
          .insert(schema.coworkSessions)
          .values({
            id: session_id,
            user_id,
            source: 'otel',
            started_at: firstAt,
            conversation_id: session_id,
          })
          .onConflictDoNothing();
      }

      // Upsert. cowork_session_stats_session_id_uq is a FULL (non-partial)
      // unique constraint, so a plain target works.
      await client
        .insert(schema.coworkSessionStats)
        .values({
          session_id,
          user_id,
          total_input_tokens: inputTokens,
          total_output_tokens: outputTokens,
          total_cache_read_tokens: cacheRead,
          total_cache_creation_tokens: cacheCreate,
          // numeric() requires a string — see the Policy-B note above.
          total_cost_usd: totalCost !== null ? String(totalCost) : null,
          tool_call_count: toolCallCount,
          unique_tools: uniqueTools,
          produced_output: producedOutputValue,
          models_used: modelsUsed,
          duration_secs: durationSecs,
          first_event_at: firstAt,
          last_event_at: lastAt,
          upload_count: uploadCount,
          computed_at: now,
          active_secs: activeSecs,
        })
        .onConflictDoUpdate({
          target: schema.coworkSessionStats.session_id,
          set: {
            total_input_tokens: inputTokens,
            total_output_tokens: outputTokens,
            total_cache_read_tokens: cacheRead,
            total_cache_creation_tokens: cacheCreate,
            total_cost_usd: totalCost !== null ? String(totalCost) : null,
            tool_call_count: toolCallCount,
            unique_tools: uniqueTools,
            produced_output: producedOutputValue,
            models_used: modelsUsed,
            duration_secs: durationSecs,
            first_event_at: firstAt,
            last_event_at: lastAt,
            upload_count: uploadCount,
            computed_at: now,
            active_secs: activeSecs,
          },
        });

      result.sessionsUpserted++;
    } catch (e) {
      result.errors.push(`Session ${session_id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return result;
}

/**
 * Scheduler entry point — cadence-guarded exactly like
 * lib/usecases/tracker.ts's runUseCaseTrackerJob (gate + cadence check live
 * INSIDE the job, called unconditionally from lib/ingestion/scheduler.ts).
 * Hardcoded hourly cadence (no config knob — matches the Developer Pulse/Pulse
 * hourly aggregators, which are also hardcoded). `coworkSessionAggLastRun` is
 * job-written only — deliberately NOT added to app/api/config/route.ts's
 * allowedKeys, same convention as codeAggregatorLastRun/pulseAggregatorLastRun.
 *
 * This was the other half of the root cause: aggregateCoworkSessionStats()
 * had no scheduled caller at all (its only caller was the on-demand
 * /api/pulse/cowork/aggregate route) despite this file's header previously
 * (wrongly) claiming an hourly job already called it.
 */
export async function runCoworkSessionAggJob(): Promise<void> {
  const lastRun = await getConfigValue('coworkSessionAggLastRun');
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  if (lastRun && lastRun >= oneHourAgo) return;

  const result = await aggregateCoworkSessionStats();
  if (result.errors.length > 0) {
    console.error('[CoworkSessionAgg] errors:', result.errors);
  }
  console.log(
    `[CoworkSessionAgg] processed=${result.sessionsProcessed} upserted=${result.sessionsUpserted} remaining=${result.remaining}`,
  );
  await setConfigValue('coworkSessionAggLastRun', new Date().toISOString());
}

/**
 * Raw facade used only for the "sessions needing aggregation" discovery
 * query (a 2-table LEFT JOIN + correlated MAX() subquery — clearer as one raw
 * statement than built via the query builder). No date bucketing involved.
 *
 * Deliberately does NOT join cowork_sessions — most historic cowork message
 * sessions (ETL'd/seeded data, or any client that never wrote a
 * cowork_sessions row) have none, and an INNER JOIN there silently excluded
 * them from aggregation forever (the proven root cause of an
 * always-near-empty cowork_session_stats table). The aggregation body
 * already tolerates a missing cowork_sessions row when reading
 * files_uploaded (falls back to upload_count 0).
 *
 * Surface filter: `COALESCE(cm.surface, 'cowork') = 'cowork'` — NULL surface
 * folds into cowork everywhere else in this codebase (see the retention
 * engine's convention in lib/retention/cleanup.ts). Without this filter,
 * dropping the cowork_sessions join would let Code-surface (surface='code')
 * otel sessions gain cowork_session_stats rows too, double-counting cowork +
 * code duration downstream (lib/usecases/impact-rollup.ts sums both per
 * matched session).
 */
async function rawSessionsNeedingAggregation(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  sessionId?: string,
  limit = DEFAULT_LIMIT + 1,
): Promise<Array<{ session_id: string; user_id: string }>> {
  const sessionFilter = sessionId ? sql`AND cm.session_id = ${sessionId}` : sql``;
  const query = sql`
    SELECT DISTINCT cm.session_id, cm.user_id
    FROM cowork_messages cm
    LEFT JOIN cowork_session_stats css ON css.session_id = cm.session_id
    WHERE cm.source = 'otel'
      AND COALESCE(cm.surface, 'cowork') = 'cowork'
      ${sessionFilter}
      AND (
        css.session_id IS NULL
        OR css.computed_at < (
          SELECT MAX(occurred_at) FROM cowork_messages
          WHERE session_id = cm.session_id AND source = 'otel'
        )
      )
    ORDER BY cm.session_id ASC
    LIMIT ${limit}
  `;

  const res = await client.execute(query);
  return res.rows as Array<{ session_id: string; user_id: string }>;
}
