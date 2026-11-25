// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. Each page's writes (`upsertUser` + the
// `analytics_snapshots` upsert for every activity row on that page) run
// inside ONE `withTx` call (lib/db/with-tx.ts) — a real Postgres
// transaction, all-or-nothing per page. The `await
// fetchAnalyticsForDate(...)` BETWEEN pages (and between dates) is fine —
// each `withTx` is a top-level transaction, never nested inside another.
// The date-window math (lastDate → maxDate = today-3-days) and the
// per-date pagination cursor are unchanged.
//
// Rewritten against the REAL Enterprise Analytics API endpoint
// (`GET https://api.anthropic.com/v1/organizations/analytics/users`) per
// published docs. An earlier version of this module targeted a
// guessed/placeholder endpoint shape (`/v1/analytics/user-activity`,
// flat per-user fields, a computed `calculateSurfaceBreakdown` with
// surface_cowork hardcoded to 0) that never matched the real API. Surfaces
// are now MEASURED directly from the response (chat message_count / code
// distinct_session_count / cowork message_count) rather than derived.
// UNVERIFIED against the live API until a live smoke test is run — the
// field mapping below is built from the documented response shape only.
// KNOWN LIMITATION (API-side, not ours): Bedrock-routed Claude Code usage
// is absent from this endpoint entirely, so Code activity that runs
// through Bedrock will not appear in these snapshots.
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { withTx } from '@/lib/db/with-tx';
import { sql, eq } from 'drizzle-orm';
import { getConfigValue, setConfigValue } from '@/lib/config';
import { v4 as uuidv4 } from 'uuid';
import { withBackoff } from '@/lib/ingestion/scheduler';

type TypedClient = Awaited<ReturnType<typeof getTypedClient>>;

const ANALYTICS_API_BASE = 'https://api.anthropic.com/v1/organizations/analytics';

interface AnalyticsUserRecord {
  user: { id: string; email_address: string };
  chat_metrics?: {
    message_count?: number;
    distinct_conversation_count?: number;
    distinct_projects_created_count?: number;
    distinct_files_uploaded_count?: number;
    distinct_artifacts_created_count?: number;
    distinct_skills_used_count?: number;
    connectors_used_count?: number;
  };
  claude_code_metrics?: {
    core_metrics?: {
      distinct_session_count?: number;
      commit_count?: number;
      pull_request_count?: number;
      lines_of_code?: { added_count?: number; removed_count?: number };
    };
  };
  cowork_metrics?: { message_count?: number };
}

interface AnalyticsApiResponse {
  data: AnalyticsUserRecord[];
  // The live API sends no `has_more`, only `next_page` (null on the last
  // page). Kept optional so an explicit `has_more: false` still stops.
  has_more?: boolean;
  next_page?: string | null;
}

/**
 * The cursor for the next page, or undefined when this is the last page.
 * Follows `next_page` alone: reading `has_more` stopped every day after its
 * first 100 people, because the live API never sends it.
 */
export function nextAnalyticsPage(response: Pick<AnalyticsApiResponse, 'has_more' | 'next_page'>): string | undefined {
  if (response.has_more === false) return undefined;
  const next = response.next_page;
  return typeof next === 'string' && next.length > 0 ? next : undefined;
}

/**
 * Fetch analytics data for a specific date. `page` is the opaque cursor
 * returned as `next_page` on a previous response for the SAME date —
 * pass it through to walk that date's pages.
 */
async function fetchAnalyticsForDate(
  apiKey: string,
  date: string,
  page?: string
): Promise<AnalyticsApiResponse> {
  return withBackoff(async () => {
    const url = new URL(`${ANALYTICS_API_BASE}/users`);
    url.searchParams.set('date', date);
    url.searchParams.set('limit', '100');
    if (page) {
      url.searchParams.set('page', page);
    }

    const response = await fetch(url.toString(), {
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Analytics API error ${response.status}: ${text}`);
    }

    return response.json();
  });
}

/**
 * Ensure user exists in users table. Matches the original semantics
 * exactly: on an EXISTING row, a non-null argument OVERWRITES the stored
 * value (COALESCE(newValue, existingValue) — new wins, falls back to the
 * existing value only when the new one is null); a brand new row is
 * seeded with whatever was supplied. The real Analytics API record has
 * neither display_name nor department, so callers now omit both — those
 * columns simply keep whatever was already stored (or null on a first
 * insert). `nowS` is passed in (computed once per page in
 * ingestAnalyticsSnapshots from the app clock).
 */
async function upsertUser(
  tx: TypedClient,
  userId: string,
  email: string,
  nowS: number,
  displayName?: string,
  department?: string
): Promise<string> {
  const displayNameArg = displayName || null;
  const departmentArg = department || null;

  // users.email carries its own UNIQUE constraint, separate from the id
  // primary key. The Analytics API's user.id (a real Anthropic account id)
  // can differ from an id a users row already got under for the same email
  // (e.g. an OTel- or manually-seeded row) — `ON CONFLICT (id)` alone can't
  // see that collision, so the insert below would violate the email
  // constraint outright and this call would throw. Resolve by email FIRST,
  // same pattern as the PSR Baselines save fix: an existing row for this
  // email gets updated in place (by its own id), never fought over with a
  // second row under a different id.
  if (email) {
    const existing = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, email));
    const other = existing.find(r => r.id !== userId);
    if (other) {
      await tx
        .update(schema.users)
        .set({
          display_name: sql`COALESCE(${displayNameArg}, ${schema.users.display_name})`,
          department: sql`COALESCE(${departmentArg}, ${schema.users.department})`,
          last_seen_at: nowS,
        })
        .where(eq(schema.users.id, other.id));
      // The caller must attribute this activity to the row that actually
      // exists — never the id the Analytics API reported, which would
      // dangle analytics_snapshots.user_id's FK to a row we didn't create.
      return other.id;
    }
  }

  await tx
    .insert(schema.users)
    .values({
      id: userId,
      email,
      display_name: displayNameArg,
      department: departmentArg,
      first_seen_at: nowS,
      last_seen_at: nowS,
    })
    .onConflictDoUpdate({
      target: schema.users.id,
      set: {
        email: sql`COALESCE(${email}, ${schema.users.email})`,
        display_name: sql`COALESCE(${displayNameArg}, ${schema.users.display_name})`,
        department: sql`COALESCE(${departmentArg}, ${schema.users.department})`,
        last_seen_at: nowS,
      },
    });
  return userId;
}

/**
 * Run analytics ingestion for recent dates.
 * Analytics data has a 3-day delay, so we fetch up to (today - 3 days).
 */
export async function ingestAnalyticsSnapshots(): Promise<{
  snapshotsUpserted: number;
  errors: string[];
}> {
  const apiKey = await getConfigValue('anthropicAnalyticsApiKey');
  if (!apiKey) {
    return { snapshotsUpserted: 0, errors: ['No Analytics API key configured'] };
  }

  const client = await getTypedClient();
  let totalUpserted = 0;
  const errors: string[] = [];

  // Determine date range: from last ingested date to (today - 3 days)
  const lastDate = await getConfigValue('analyticsLastDate');
  const now = new Date();
  const maxDate = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000); // 3 days ago

  let startDate: Date;
  if (lastDate) {
    // Start from the day after the last ingested date
    startDate = new Date(lastDate);
    startDate.setDate(startDate.getDate() + 1);
  } else {
    // Default: fetch last 7 days of available data
    startDate = new Date(maxDate.getTime() - 7 * 24 * 60 * 60 * 1000);
  }

  const currentDate = new Date(startDate);

  while (currentDate <= maxDate) {
    const dateStr = currentDate.toISOString().split('T')[0];

    try {
      let hasMore = true;
      let page: string | undefined;

      while (hasMore) {
        const response = await fetchAnalyticsForDate(apiKey, dateStr, page);

        // Top-level transaction PER PAGE — all-or-nothing, matching the
        // original sync db.transaction(() => …) exactly.
        await withTx(client, async (tx) => {
          const nowS = Math.floor(Date.now() / 1000); // app clock
          for (const activity of response.data) {
            const resolvedUserId = await upsertUser(tx, activity.user.id, activity.user.email_address, nowS);

            const chat = activity.chat_metrics ?? {};
            const code = activity.claude_code_metrics?.core_metrics ?? {};
            const loc = code.lines_of_code ?? {};

            await tx
              .insert(schema.analyticsSnapshots)
              .values({
                id: uuidv4(),
                user_id: resolvedUserId,
                snapshot_date: dateStr,
                conversations: chat.distinct_conversation_count ?? 0,
                messages_sent: chat.message_count ?? 0,
                projects_created: chat.distinct_projects_created_count ?? 0,
                files_uploaded: chat.distinct_files_uploaded_count ?? 0,
                artifacts_created: chat.distinct_artifacts_created_count ?? 0,
                skills_used: chat.distinct_skills_used_count ?? 0,
                connectors_used: chat.connectors_used_count ?? 0,
                code_commits: code.commit_count ?? 0,
                code_prs: code.pull_request_count ?? 0,
                code_lines: (loc.added_count ?? 0) + (loc.removed_count ?? 0),
                surface_chat: chat.message_count ?? 0,
                surface_code: code.distinct_session_count ?? 0,
                surface_cowork: activity.cowork_metrics?.message_count ?? 0,
              })
              .onConflictDoUpdate({
                target: [schema.analyticsSnapshots.user_id, schema.analyticsSnapshots.snapshot_date],
                set: {
                  conversations: sql`excluded.conversations`,
                  messages_sent: sql`excluded.messages_sent`,
                  projects_created: sql`excluded.projects_created`,
                  files_uploaded: sql`excluded.files_uploaded`,
                  artifacts_created: sql`excluded.artifacts_created`,
                  skills_used: sql`excluded.skills_used`,
                  connectors_used: sql`excluded.connectors_used`,
                  code_commits: sql`excluded.code_commits`,
                  code_prs: sql`excluded.code_prs`,
                  code_lines: sql`excluded.code_lines`,
                  surface_chat: sql`excluded.surface_chat`,
                  surface_code: sql`excluded.surface_code`,
                  surface_cowork: sql`excluded.surface_cowork`,
                },
              });

            totalUpserted++;
          }
        });

        const next = nextAnalyticsPage(response);
        // A cursor that repeats would loop forever; treat it as the end.
        hasMore = next !== undefined && next !== page;
        page = next;
      }

      // Update last ingested date after each successful day
      await setConfigValue('analyticsLastDate', dateStr);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${dateStr}: ${message}`);
      console.error(`[Analytics Ingest] Error for ${dateStr}:`, message);
    }

    currentDate.setDate(currentDate.getDate() + 1);
  }

  try {
    await refreshAnthropicSeatCount(apiKey);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push(`seat count: ${message}`);
    console.error('[Analytics Ingest] Error reading the seat count:', message);
  }

  return { snapshotsUpserted: totalUpserted, errors };
}

interface AnalyticsSummaryRow {
  starting_at: string;
  assigned_seat_count?: number;
}

// The summaries endpoint answers up to its latest available day when no
// ending date is given, so a week back always reaches it.
const SEAT_LOOKBACK_DAYS = 7;

/**
 * Store Anthropic's assigned seat count (the latest day of the summaries
 * endpoint) for FinOps' unused-seats line, which uses it when no licensed
 * seats figure has been set by hand. Asks at most once a UTC day, the
 * check date written first so a failing call is not retried every cycle
 * against the API's 60 requests a minute.
 */
export async function refreshAnthropicSeatCount(apiKey: string, now: Date = new Date()): Promise<void> {
  const today = now.toISOString().split('T')[0];
  if ((await getConfigValue('anthropicSeatCountCheckedOn')) === today) return;
  await setConfigValue('anthropicSeatCountCheckedOn', today);

  const from = new Date(now.getTime() - SEAT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const body = await withBackoff(async () => {
    const url = new URL(`${ANALYTICS_API_BASE}/summaries`);
    url.searchParams.set('starting_date', from);
    const response = await fetch(url.toString(), {
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Analytics API error ${response.status}: ${text}`);
    }
    return response.json() as Promise<{ data?: AnalyticsSummaryRow[] }>;
  });

  const latest = (body.data ?? []).reduce<AnalyticsSummaryRow | undefined>(
    (best, row) => (!best || row.starting_at > best.starting_at ? row : best),
    undefined,
  );
  const seats = Number(latest?.assigned_seat_count);
  if (Number.isFinite(seats) && seats > 0) {
    await setConfigValue('anthropicSeatCount', String(seats));
  }
}
