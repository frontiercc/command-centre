// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { and, eq, gte, inArray, isNotNull, lt, lte, ne, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getConfigValue, setConfigValue } from '@/lib/config';
import { computeOtiForUsers, type OtiResult } from '@/lib/pulse/metrics/oti';
import { computeDdsForUsers } from '@/lib/pulse/metrics/dds';
import { computeTeamOrsDetail, computeDeptOrsDetail } from '@/lib/pulse/metrics/ors';
import { detectFrontierPushes } from '@/lib/pulse/events/frontier';
import { detectCapabilityCreation } from '@/lib/pulse/events/capability';
import { weekStart, weekStarts } from '@/lib/pulse/period';
import { messageVendor, SPLIT_VENDORS, type SplitVendor } from '@/lib/pulse/vendor-filter';
import { hasOpenAiData } from '@/lib/dashboard/queries';
import type { Vendor } from '@/lib/dashboard/vendor';

type TypedClient = Awaited<ReturnType<typeof getTypedClient>>;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Write (upsert) a pulse_metrics snapshot for the given scope and period.
 * There is no unique constraint on pulse_metrics for 'rolling' rows, so we
 * just insert a new row each aggregation run — each row is a time-stamped
 * snapshot. 'week' rows ARE upserted, keyed on (scope_type, scope_id,
 * period_start).
 *
 * Weekly upsert ON CONFLICT target: the `idx_pulse_metrics_week` unique index
 * is PARTIAL — `WHERE granularity = 'week'` (Postgres baseline,
 * migrations-pg/0000_...). Postgres requires an ON CONFLICT arbiter to name
 * the partial predicate to infer a partial index, hence
 * `targetWhere: sql\`granularity = 'week'\``.
 *
 * Because the index is partial, a 'rolling' row can NEVER match it — so the
 * rolling INSERT below is a plain insert (a fresh snapshot every run, no
 * conflict possible).
 */
async function writeMetric(client: TypedClient, params: {
  scopeType: 'user' | 'team' | 'function';
  scopeId: string;
  periodStart: number;
  periodEnd: number;
  oti: number | null;
  dds: number | null;
  psr: number | null;
  ors: number | null;
  tier1Count: number;
  tier2Count: number;
  tier3Count: number;
  eventCount: number;
  orsBreadth?: number | null;
  orsOverlap?: number | null;
  orsPropagation?: number | null;
  granularity?: 'rolling' | 'week';
  // OTI v2: formula generation + early-read/active-day provenance.
  metricVersion?: number;
  otiEarlyRead?: boolean;
  otiActiveDays?: number | null;
  /** Set for one vendor's figures, saved to pulse_metrics_vendor; absent for all products. */
  vendor?: SplitVendor;
}): Promise<void> {
  if (params.vendor) return writeVendorMetric(client, params.vendor, params);
  const t = schema.pulseMetrics;
  const now = Math.floor(Date.now() / 1000);
  const granularity = params.granularity ?? 'rolling';
  const orsBreadth = params.orsBreadth ?? null;
  const orsOverlap = params.orsOverlap ?? null;
  const orsPropagation = params.orsPropagation ?? null;

  const values = {
    scope_type: params.scopeType,
    scope_id: params.scopeId,
    period_start: params.periodStart,
    period_end: params.periodEnd,
    oti: params.oti,
    dds: params.dds,
    psr: params.psr,
    ors: params.ors,
    event_count: params.eventCount,
    tier_1_count: params.tier1Count,
    tier_2_count: params.tier2Count,
    tier_3_count: params.tier3Count,
    ors_breadth: orsBreadth,
    ors_overlap: orsOverlap,
    ors_propagation: orsPropagation,
    computed_at: now,
    // Every aggregator write is OTI v2; default to 2 so callers need not repeat it.
    metric_version: params.metricVersion ?? 2,
    oti_early_read: params.otiEarlyRead ? 1 : 0,
    oti_active_days: params.otiActiveDays ?? null,
  };

  if (granularity === 'rolling') {
    // The unique index is partial (WHERE granularity='week'), so it never
    // applies to a 'rolling' row: a plain insert always appends a fresh
    // time-stamped snapshot and can never collide.
    await client.insert(t).values({ ...values, granularity: 'rolling' });
    return;
  }

  await client
    .insert(t)
    .values({ ...values, granularity: 'week' })
    .onConflictDoUpdate({
      target: [t.scope_type, t.scope_id, t.period_start],
      // The partial index (WHERE granularity='week') is the arbiter; naming
      // the predicate lets Postgres infer it.
      targetWhere: sql`granularity = 'week'`,
      set: {
        period_end: values.period_end,
        oti: values.oti,
        dds: values.dds,
        psr: values.psr,
        ors: values.ors,
        event_count: values.event_count,
        tier_1_count: values.tier_1_count,
        tier_2_count: values.tier_2_count,
        tier_3_count: values.tier_3_count,
        ors_breadth: values.ors_breadth,
        ors_overlap: values.ors_overlap,
        ors_propagation: values.ors_propagation,
        computed_at: values.computed_at,
        metric_version: values.metric_version,
        oti_early_read: values.oti_early_read,
        oti_active_days: values.oti_active_days,
      },
    });
}

/**
 * One vendor's figures, the same shape and upsert rule as writeMetric, in
 * pulse_metrics_vendor. Kept out of pulse_metrics so every existing reader of
 * that table still sees all products only.
 */
async function writeVendorMetric(
  client: TypedClient,
  vendor: SplitVendor,
  params: Omit<Parameters<typeof writeMetric>[1], 'vendor'>,
): Promise<void> {
  const t = schema.pulseMetricsVendor;
  const now = Math.floor(Date.now() / 1000);
  const granularity = params.granularity ?? 'rolling';
  const values = {
    vendor,
    scope_type: params.scopeType,
    scope_id: params.scopeId,
    period_start: params.periodStart,
    period_end: params.periodEnd,
    oti: params.oti,
    dds: params.dds,
    psr: params.psr,
    ors: params.ors,
    event_count: params.eventCount,
    tier_1_count: params.tier1Count,
    tier_2_count: params.tier2Count,
    tier_3_count: params.tier3Count,
    ors_breadth: params.orsBreadth ?? null,
    ors_overlap: params.orsOverlap ?? null,
    ors_propagation: params.orsPropagation ?? null,
    computed_at: now,
    metric_version: params.metricVersion ?? 2,
    oti_early_read: params.otiEarlyRead ? 1 : 0,
    oti_active_days: params.otiActiveDays ?? null,
  };
  if (granularity === 'rolling') {
    await client.insert(t).values({ ...values, granularity: 'rolling' });
    return;
  }
  const set = {
    period_end: values.period_end,
    oti: values.oti,
    dds: values.dds,
    psr: values.psr,
    ors: values.ors,
    event_count: values.event_count,
    tier_1_count: values.tier_1_count,
    tier_2_count: values.tier_2_count,
    tier_3_count: values.tier_3_count,
    ors_breadth: values.ors_breadth,
    ors_overlap: values.ors_overlap,
    ors_propagation: values.ors_propagation,
    computed_at: values.computed_at,
    metric_version: values.metric_version,
    oti_early_read: values.oti_early_read,
    oti_active_days: values.oti_active_days,
  };
  await client
    .insert(t)
    .values({ ...values, granularity: 'week' })
    .onConflictDoUpdate({
      target: [t.vendor, t.scope_type, t.scope_id, t.period_start],
      targetWhere: sql`granularity = 'week'`,
      set,
    });
}

/**
 * Fetch tier counts for a user or group of users over a window.
 */
async function getTierCountsForUsers(
  client: TypedClient,
  userIds: string[],
  windowStart: number,
  windowEnd: number,
  vendor: Vendor = 'all',
): Promise<{ t1: number; t2: number; t3: number; total: number }> {
  if (userIds.length === 0) return { t1: 0, t2: 0, t3: 0, total: 0 };

  const pc = schema.pulseClassifications;
  const cm = schema.coworkMessages;

  const rows = await client
    .select({
      t1: sql<number | string>`SUM(CASE WHEN ${pc.tier} = 1 THEN 1 ELSE 0 END)`,
      t2: sql<number | string>`SUM(CASE WHEN ${pc.tier} = 2 THEN 1 ELSE 0 END)`,
      t3: sql<number | string>`SUM(CASE WHEN ${pc.tier} = 3 THEN 1 ELSE 0 END)`,
      total: sql<number | string>`COUNT(*)`,
    })
    .from(pc)
    .innerJoin(cm, eq(cm.id, pc.cowork_message_id))
    .where(and(
      inArray(pc.user_id, userIds),
      eq(pc.classifier_status, 'classified'),
      gte(cm.occurred_at, windowStart),
      lt(cm.occurred_at, windowEnd),
      messageVendor(vendor),
    ));

  const row = rows[0];
  return {
    t1: Number(row?.t1 ?? 0),
    t2: Number(row?.t2 ?? 0),
    t3: Number(row?.t3 ?? 0),
    total: Number(row?.total ?? 0),
  };
}

/**
 * Fetch all classification IDs written since a given ISO timestamp string.
 * Used to scope frontier/capability detection to new rows only.
 */
async function getClassificationIdsSince(client: TypedClient, since: string | null): Promise<number[]> {
  const pc = schema.pulseClassifications;

  if (!since) {
    // First ever run — process all existing classified rows
    const rows = await client
      .select({ id: pc.id })
      .from(pc)
      .where(eq(pc.classifier_status, 'classified'));
    return rows.map(r => r.id);
  }

  // Convert ISO string to unix timestamp for comparison with classified_at (integer)
  const sinceEpoch = Math.floor(new Date(since).getTime() / 1000);

  const rows = await client
    .select({ id: pc.id })
    .from(pc)
    .where(and(eq(pc.classifier_status, 'classified'), gte(pc.classified_at, sinceEpoch)));
  return rows.map(r => r.id);
}

/**
 * Average the values of a batch metric Map (from computeOtiForUsers /
 * computeDdsForUsers) over a set of member IDs, excluding nulls/missing
 * entries — same semantics as looping computeUserOti/computeUserDds and
 * averaging the non-null results.
 * Returns null if no member has a non-null value.
 */
function averageOfBatch(batch: Map<string, number | null>, memberIds: string[]): number | null {
  const values: number[] = [];
  for (const id of memberIds) {
    const v = batch.get(id);
    if (v !== null && v !== undefined) values.push(v);
  }
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Reduce an OTI v2 batch (Map<user, OtiResult|null>) to the numeric value map
 * that averageOfBatch expects: the publishable `value` per user, or null when
 * the user has no value / is stale (< 2 active days).
 */
function otiValueMap(batch: Map<string, OtiResult | null>): Map<string, number | null> {
  const m = new Map<string, number | null>();
  for (const [id, res] of batch) m.set(id, res && res.value !== null ? res.value : null);
  return m;
}

async function countConfirmedCapabilities(client: TypedClient, userIds: string[], vendor: Vendor = 'all'): Promise<number> {
  if (userIds.length === 0) return 0;
  const pe = schema.pulseEvents;
  const where = and(inArray(pe.user_id, userIds), eq(pe.event_type, 'capability_creation'), eq(pe.status, 'confirmed'));
  if (vendor === 'all') {
    const rows = await client.select({ cnt: sql<number | string>`COUNT(*)` }).from(pe).where(where);
    return Number(rows[0]?.cnt ?? 0);
  }
  // A capability belongs to the vendor of the prompt it was detected on.
  const rows = await client
    .select({ cnt: sql<number | string>`COUNT(*)` })
    .from(pe)
    .innerJoin(schema.coworkMessages, eq(schema.coworkMessages.id, pe.cowork_message_id))
    .where(and(where, messageVendor(vendor)));
  return Number(rows[0]?.cnt ?? 0);
}

// ─── OTel cowork helpers ─────────────────────────────────────────────────────

/**
 * Sum cost_usd from OTel-sourced cowork_api_request rows for a user over a window.
 * Returns 0 when no rows exist (COALESCE in SQL).
 */
export async function getCoworkCostUsd(
  userId: string,
  windowStart: number,
  windowEnd: number,
): Promise<number> {
  const client = await getTypedClient();
  const t = schema.coworkMessages;
  const rows = await client
    .select({ cowork_cost: sql<number | string>`COALESCE(SUM(${t.cost_usd}), 0)` })
    .from(t)
    .where(and(
      eq(t.user_id, userId),
      eq(t.message_type, 'cowork_api_request'),
      gte(t.occurred_at, windowStart),
      lte(t.occurred_at, windowEnd),
    ));
  return Number(rows[0]?.cowork_cost ?? 0);
}

/**
 * Compute friction index (failed tools / total tools) for a user over a window.
 * Only counts rows where message_type = 'cowork_tool_metadata' as the denominator,
 * and tool_success = 0 as the numerator.
 * Returns null when total_tools = 0 (no tool data yet).
 */
export async function getCoworkFrictionIndex(
  userId: string,
  windowStart: number,
  windowEnd: number,
): Promise<number | null> {
  const client = await getTypedClient();
  const t = schema.coworkMessages;
  const rows = await client
    .select({
      failed_tools: sql<number | string>`COUNT(*) FILTER (WHERE ${t.tool_success} = 0)`,
      total_tools: sql<number | string>`COUNT(*) FILTER (WHERE ${t.message_type} = 'cowork_tool_metadata')`,
    })
    .from(t)
    .where(and(eq(t.user_id, userId), gte(t.occurred_at, windowStart), lte(t.occurred_at, windowEnd)));

  const row = rows[0];
  const totalTools = Number(row?.total_tools ?? 0);
  if (!row || totalTools === 0) return null;
  return Number(row.failed_tools ?? 0) / totalTools;
}

// ─── Hourly aggregation ───────────────────────────────────────────────────────

/**
 * Hourly aggregation:
 *   - Compute OTI and DDS per user, write to pulse_metrics (scope_type='user').
 *   - Compute OTI, DDS, ORS, PSR per team, write to pulse_metrics (scope_type='team').
 *   - Run frontier push and capability creation detection on new classifications.
 */
export async function runHourlyAggregation(): Promise<void> {
  const client = await getTypedClient();
  const now = Math.floor(Date.now() / 1000);
  const SEVEN_DAYS = 7 * 24 * 60 * 60;

  console.log('[PulseAggregator] Running hourly aggregation...');

  // ── Per-user metrics ──────────────────────────────────────────────────────

  const users = await client
    .selectDistinct({ user_id: schema.pulseClassifications.user_id })
    .from(schema.pulseClassifications)
    .where(eq(schema.pulseClassifications.classifier_status, 'classified'));

  const periodStart = now - SEVEN_DAYS;
  const periodEnd = now;

  // Build a map of user_id → pulse_start_at for per-user window floors
  const userPrefs = await client
    .select({ user_id: schema.pulseUserPrefs.user_id, pulse_start_at: schema.pulseUserPrefs.pulse_start_at })
    .from(schema.pulseUserPrefs)
    .where(isNotNull(schema.pulseUserPrefs.pulse_start_at));
  const startDateMap = new Map(userPrefs.map(p => [p.user_id, p.pulse_start_at as number]));

  const userIds = users.map(u => u.user_id);
  const otiByUser = await computeOtiForUsers(userIds);
  const ddsByUser = await computeDdsForUsers(userIds);

  for (const { user_id } of users) {
    const otiRes = otiByUser.get(user_id) ?? null;
    const oti = otiRes && otiRes.value !== null ? otiRes.value : null;
    const dds = ddsByUser.get(user_id) ?? null;

    const pulseStartAt = startDateMap.get(user_id) ?? null;
    const effectiveStart = pulseStartAt !== null ? Math.max(periodStart, pulseStartAt) : periodStart;

    const counts = await getTierCountsForUsers(client, [user_id], effectiveStart, periodEnd + 1);

    await writeMetric(client, {
      scopeType: 'user',
      scopeId: user_id,
      periodStart: effectiveStart,
      periodEnd,
      oti,
      // OTI v2 provenance is per-user (the "Early read" badge + active-day quality).
      otiEarlyRead: otiRes?.earlyRead ?? false,
      otiActiveDays: otiRes?.activeDaysCurrent ?? null,
      dds,
      psr: await countConfirmedCapabilities(client, [user_id]),
      ors: null,    // ORS is team-scoped only
      tier1Count: counts.t1,
      tier2Count: counts.t2,
      tier3Count: counts.t3,
      eventCount: counts.total,
    });
  }

  // ── Per-team metrics ──────────────────────────────────────────────────────

  const teams = (await client
    .selectDistinct({ team_id: schema.users.team_id })
    .from(schema.users)
    .where(isNotNull(schema.users.team_id)))
    .map(r => r.team_id as string);

  for (const team_id of teams) {
    // Collect member IDs for count aggregation
    const memberIds = (await client
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.team_id, team_id))).map(r => r.id);

    // Batch OTI/DDS across team members instead of computeTeamOti/computeTeamDds'
    // internal per-member loop — same "average of member values, nulls excluded" semantics.
    const oti = averageOfBatch(otiValueMap(await computeOtiForUsers(memberIds)), memberIds);
    const dds = averageOfBatch(await computeDdsForUsers(memberIds), memberIds);
    const orsDetail = await computeTeamOrsDetail(team_id);

    const counts = await getTierCountsForUsers(client, memberIds, periodStart, periodEnd + 1);

    await writeMetric(client, {
      scopeType: 'team',
      scopeId: team_id,
      periodStart,
      periodEnd,
      oti,
      dds,
      psr: await countConfirmedCapabilities(client, memberIds),
      ors: orsDetail?.ors ?? null,
      tier1Count: counts.t1,
      tier2Count: counts.t2,
      tier3Count: counts.t3,
      eventCount: counts.total,
      orsBreadth: orsDetail?.breadth ?? null,
      orsOverlap: orsDetail?.overlap ?? null,
      orsPropagation: orsDetail?.propagation ?? null,
    });
  }

  // ── Per-department metrics (OTI, DDS, PSR, ORS grouped by admin_users.department) ────
  // Department is set on admin login accounts (Access & Keys page), not on agent users.
  // We resolve members via the linked_cowork_user_id link.

  const departments = (await client
    .selectDistinct({ department: schema.adminUsers.department })
    .from(schema.adminUsers)
    .where(and(isNotNull(schema.adminUsers.department), ne(schema.adminUsers.department, ''))))
    .map(r => r.department as string);

  for (const department of departments) {
    const deptMemberIds = (await client
      .select({ id: schema.adminUsers.linked_cowork_user_id })
      .from(schema.adminUsers)
      .where(and(eq(schema.adminUsers.department, department), isNotNull(schema.adminUsers.linked_cowork_user_id))))
      .map(r => r.id as string);

    const dOti = averageOfBatch(otiValueMap(await computeOtiForUsers(deptMemberIds)), deptMemberIds);
    const dDds = averageOfBatch(await computeDdsForUsers(deptMemberIds), deptMemberIds);
    const dOrsDetail = await computeDeptOrsDetail(department);

    const dCounts = await getTierCountsForUsers(client, deptMemberIds, periodStart, periodEnd + 1);

    await writeMetric(client, {
      scopeType: 'function',
      scopeId: department,
      periodStart,
      periodEnd,
      oti: dOti,
      dds: dDds,
      psr: await countConfirmedCapabilities(client, deptMemberIds),
      ors: dOrsDetail?.ors ?? null,
      tier1Count: dCounts.t1,
      tier2Count: dCounts.t2,
      tier3Count: dCounts.t3,
      eventCount: dCounts.total,
      orsBreadth: dOrsDetail?.breadth ?? null,
      orsOverlap: dOrsDetail?.overlap ?? null,
      orsPropagation: dOrsDetail?.propagation ?? null,
    });
  }

  // ── Weekly rows (calendar-week trend, upserted) ───────────────────────────
  // Volume-only: tier counts + event_count + inline dds for the window
  // [weekStart(now), now]. oti/psr/ors have their own window semantics and
  // are left null on weekly rows — the weekly trend cares about volume +
  // delegation mix, not those metrics' bespoke lookback windows.

  const wkStart = weekStart(now);

  const weeklyDds = (t1: number, t2: number, t3: number, total: number): number | null =>
    total > 0 ? (3 * t3 + 2 * t2 + t1) / total : null;

  for (const { user_id } of users) {
    const counts = await getTierCountsForUsers(client, [user_id], wkStart, now + 1);
    await writeMetric(client, {
      scopeType: 'user',
      scopeId: user_id,
      periodStart: wkStart,
      periodEnd: now,
      oti: null,
      dds: weeklyDds(counts.t1, counts.t2, counts.t3, counts.total),
      psr: null,
      ors: null,
      tier1Count: counts.t1,
      tier2Count: counts.t2,
      tier3Count: counts.t3,
      eventCount: counts.total,
      granularity: 'week',
    });
  }

  for (const team_id of teams) {
    const memberIds = (await client
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.team_id, team_id))).map(r => r.id);
    const counts = await getTierCountsForUsers(client, memberIds, wkStart, now + 1);
    await writeMetric(client, {
      scopeType: 'team',
      scopeId: team_id,
      periodStart: wkStart,
      periodEnd: now,
      oti: null,
      dds: weeklyDds(counts.t1, counts.t2, counts.t3, counts.total),
      psr: null,
      ors: null,
      tier1Count: counts.t1,
      tier2Count: counts.t2,
      tier3Count: counts.t3,
      eventCount: counts.total,
      granularity: 'week',
    });
  }

  for (const department of departments) {
    const deptMemberIds = (await client
      .select({ id: schema.adminUsers.linked_cowork_user_id })
      .from(schema.adminUsers)
      .where(and(eq(schema.adminUsers.department, department), isNotNull(schema.adminUsers.linked_cowork_user_id))))
      .map(r => r.id as string);
    const counts = await getTierCountsForUsers(client, deptMemberIds, wkStart, now + 1);
    await writeMetric(client, {
      scopeType: 'function',
      scopeId: department,
      periodStart: wkStart,
      periodEnd: now,
      oti: null,
      dds: weeklyDds(counts.t1, counts.t2, counts.t3, counts.total),
      psr: null,
      ors: null,
      tier1Count: counts.t1,
      tier2Count: counts.t2,
      tier3Count: counts.t3,
      eventCount: counts.total,
      granularity: 'week',
    });
  }

  // ── Per-vendor rows (Claude / OpenAI), only while OpenAI data exists ──────
  if (await hasOpenAiData()) {
    // Past weeks are recounted from the prompts graded since the last run
    // (all of them the first time), so a week that gains prompts late (an
    // OpenAI backfill, or the classifier catching up) is brought up to date.
    // Five minutes of overlap, so nothing graded while this run starts is
    // missed; recounting a week twice gives the same answer.
    const gradedSince = Number(await getConfigValue('pulseVendorWeeksGradedSince')) || 0;
    const runStart = Math.floor(Date.now() / 1000);
    for (const vendor of SPLIT_VENDORS) {
      await aggregateVendor(client, vendor, now, startDateMap, departments, gradedSince);
    }
    await setConfigValue('pulseVendorWeeksGradedSince', String(runStart - 300));
  }

  // ── Event detection ───────────────────────────────────────────────────────
  // detectFrontierPushes/detectCapabilityCreation each open their OWN withTx
  // internally (3.7a) — kept here as sequential top-level awaited calls, NOT
  // wrapped in any aggregator-level withTx, to avoid tripping the re-entrancy
  // guard (lib/db/with-tx.ts).

  const lastRun = await getConfigValue('pulseAggregatorLastRun');
  const newClassificationIds = await getClassificationIdsSince(client, lastRun || null);

  if (newClassificationIds.length > 0) {
    await detectFrontierPushes(newClassificationIds);
    await detectCapabilityCreation(newClassificationIds);
  }

  await setConfigValue('pulseAggregatorLastRun', new Date().toISOString());
  console.log('[PulseAggregator] Hourly aggregation complete.');
}

/**
 * The per-user and per-department figures above, for one vendor's prompts
 * only, saved to pulse_metrics_vendor: rolling OTI, DDS, PSR, ORS and tier
 * counts, plus the weekly tier rows. Same windows and rules as the
 * all-products pass; teams are left out (users.team_id is never populated).
 */
async function aggregateVendor(
  client: TypedClient,
  vendor: SplitVendor,
  now: number,
  startDateMap: Map<string, number>,
  departments: string[],
  gradedSince: number,
): Promise<void> {
  const SEVEN_DAYS = 7 * 24 * 60 * 60;
  const periodStart = now - SEVEN_DAYS;
  const wkStart = weekStart(now);
  const weeklyDds = (t1: number, t2: number, t3: number, total: number): number | null =>
    total > 0 ? (3 * t3 + 2 * t2 + t1) / total : null;

  const pc = schema.pulseClassifications;
  const userIds = (await client
    .selectDistinct({ user_id: pc.user_id })
    .from(pc)
    .innerJoin(schema.coworkMessages, eq(schema.coworkMessages.id, pc.cowork_message_id))
    .where(and(eq(pc.classifier_status, 'classified'), messageVendor(vendor))))
    .map(r => r.user_id);

  const otiByUser = await computeOtiForUsers(userIds, vendor);
  const ddsByUser = await computeDdsForUsers(userIds, vendor);
  for (const user_id of userIds) {
    const otiRes = otiByUser.get(user_id) ?? null;
    const pulseStartAt = startDateMap.get(user_id) ?? null;
    const effectiveStart = pulseStartAt !== null ? Math.max(periodStart, pulseStartAt) : periodStart;
    const counts = await getTierCountsForUsers(client, [user_id], effectiveStart, now + 1, vendor);
    await writeMetric(client, {
      vendor,
      scopeType: 'user',
      scopeId: user_id,
      periodStart: effectiveStart,
      periodEnd: now,
      oti: otiRes && otiRes.value !== null ? otiRes.value : null,
      otiEarlyRead: otiRes?.earlyRead ?? false,
      otiActiveDays: otiRes?.activeDaysCurrent ?? null,
      dds: ddsByUser.get(user_id) ?? null,
      psr: await countConfirmedCapabilities(client, [user_id], vendor),
      ors: null,
      tier1Count: counts.t1,
      tier2Count: counts.t2,
      tier3Count: counts.t3,
      eventCount: counts.total,
    });
    const week = await getTierCountsForUsers(client, [user_id], wkStart, now + 1, vendor);
    await writeMetric(client, {
      vendor,
      scopeType: 'user',
      scopeId: user_id,
      periodStart: wkStart,
      periodEnd: now,
      oti: null,
      dds: weeklyDds(week.t1, week.t2, week.t3, week.total),
      psr: null,
      ors: null,
      tier1Count: week.t1,
      tier2Count: week.t2,
      tier3Count: week.t3,
      eventCount: week.total,
      granularity: 'week',
    });
  }

  for (const department of departments) {
    const memberIds = (await client
      .select({ id: schema.adminUsers.linked_cowork_user_id })
      .from(schema.adminUsers)
      .where(and(eq(schema.adminUsers.department, department), isNotNull(schema.adminUsers.linked_cowork_user_id))))
      .map(r => r.id as string);
    const orsDetail = await computeDeptOrsDetail(department, vendor);
    const counts = await getTierCountsForUsers(client, memberIds, periodStart, now + 1, vendor);
    await writeMetric(client, {
      vendor,
      scopeType: 'function',
      scopeId: department,
      periodStart,
      periodEnd: now,
      oti: averageOfBatch(otiValueMap(await computeOtiForUsers(memberIds, vendor)), memberIds),
      dds: averageOfBatch(await computeDdsForUsers(memberIds, vendor), memberIds),
      psr: await countConfirmedCapabilities(client, memberIds, vendor),
      ors: orsDetail?.ors ?? null,
      tier1Count: counts.t1,
      tier2Count: counts.t2,
      tier3Count: counts.t3,
      eventCount: counts.total,
      orsBreadth: orsDetail?.breadth ?? null,
      orsOverlap: orsDetail?.overlap ?? null,
      orsPropagation: orsDetail?.propagation ?? null,
    });
    const week = await getTierCountsForUsers(client, memberIds, wkStart, now + 1, vendor);
    await writeMetric(client, {
      vendor,
      scopeType: 'function',
      scopeId: department,
      periodStart: wkStart,
      periodEnd: now,
      oti: null,
      dds: weeklyDds(week.t1, week.t2, week.t3, week.total),
      psr: null,
      ors: null,
      tier1Count: week.t1,
      tier2Count: week.t2,
      tier3Count: week.t3,
      eventCount: week.total,
      granularity: 'week',
    });
  }

  await refreshPastVendorWeeks(client, vendor, now, departments, gradedSince);
}

/** Completed weeks the per-vendor weekly rows reach back over (the Delegation View's longest window). */
const PAST_VENDOR_WEEKS = 52;
const WEEK = 7 * 24 * 60 * 60;

/**
 * The per-vendor table only gains a week while the aggregator runs in it, so
 * a vendor view had no history before the first run, and a week written
 * before all its prompts were graded stayed short. This recounts every
 * completed week (within PAST_VENDOR_WEEKS) that has a prompt graded since
 * gradedSince, writing its user and department rows with the same counts as
 * the weekly rows above, bounded to the week by the prompt's own time. Weeks
 * with nothing newly graded are left exactly as they are, so prompts later
 * removed by retention never shrink an old week.
 */
async function refreshPastVendorWeeks(
  client: TypedClient,
  vendor: SplitVendor,
  now: number,
  departments: string[],
  gradedSince: number,
): Promise<void> {
  const current = weekStart(now);
  const from = weekStarts(current - 1, PAST_VENDOR_WEEKS)[0];
  const pc = schema.pulseClassifications;
  const cm = schema.coworkMessages;
  // Monday 00:00 UTC of the prompt's week, the same rule as weekStart() (1 January 1970 was a Thursday).
  const ws = sql<number | string>`(${cm.occurred_at} - (((${cm.occurred_at} / 86400) + 3) % 7) * 86400 - (${cm.occurred_at} % 86400))`;
  const inWindow = and(
    eq(pc.classifier_status, 'classified'),
    gte(cm.occurred_at, from),
    lt(cm.occurred_at, current),
    messageVendor(vendor),
  );

  const touched = (await client
    .selectDistinct({ week: ws })
    .from(pc)
    .innerJoin(cm, eq(cm.id, pc.cowork_message_id))
    .where(and(inWindow, gte(pc.classified_at, gradedSince))))
    .map(r => Number(r.week));
  if (touched.length === 0) return;
  const weekSet = new Set(touched);

  const activity = (await client
    .select({
      user_id: pc.user_id,
      week: ws,
      t1: sql<number | string>`SUM(CASE WHEN ${pc.tier} = 1 THEN 1 ELSE 0 END)`,
      t2: sql<number | string>`SUM(CASE WHEN ${pc.tier} = 2 THEN 1 ELSE 0 END)`,
      t3: sql<number | string>`SUM(CASE WHEN ${pc.tier} = 3 THEN 1 ELSE 0 END)`,
      total: sql<number | string>`COUNT(*)`,
    })
    .from(pc)
    .innerJoin(cm, eq(cm.id, pc.cowork_message_id))
    .where(and(inWindow, gte(cm.occurred_at, Math.min(...touched)), lt(cm.occurred_at, Math.max(...touched) + WEEK)))
    .groupBy(pc.user_id, ws))
    .filter(r => weekSet.has(Number(r.week)));

  type Counts = { t1: number; t2: number; t3: number; total: number };
  const write = async (scopeType: 'user' | 'function', scopeId: string, week: number, c: Counts) => {
    await writeMetric(client, {
      vendor,
      scopeType,
      scopeId,
      periodStart: week,
      periodEnd: week + WEEK,
      oti: null,
      dds: c.total > 0 ? (3 * c.t3 + 2 * c.t2 + c.t1) / c.total : null,
      psr: null,
      ors: null,
      tier1Count: c.t1,
      tier2Count: c.t2,
      tier3Count: c.t3,
      eventCount: c.total,
      granularity: 'week',
    });
  };

  const byUserWeek = new Map<string, Map<number, Counts>>();
  for (const r of activity) {
    if (!r.user_id) continue;
    const week = Number(r.week);
    const c = { t1: Number(r.t1), t2: Number(r.t2), t3: Number(r.t3), total: Number(r.total) };
    if (!byUserWeek.has(r.user_id)) byUserWeek.set(r.user_id, new Map());
    byUserWeek.get(r.user_id)!.set(week, c);
    await write('user', r.user_id, week, c);
  }

  // Departments: the same members as the department rows above.
  for (const department of departments) {
    const memberIds = (await client
      .select({ id: schema.adminUsers.linked_cowork_user_id })
      .from(schema.adminUsers)
      .where(and(eq(schema.adminUsers.department, department), isNotNull(schema.adminUsers.linked_cowork_user_id))))
      .map(r => r.id as string);
    const sums = new Map<number, Counts>();
    for (const id of memberIds) {
      for (const [week, c] of byUserWeek.get(id) ?? []) {
        const s0 = sums.get(week) ?? { t1: 0, t2: 0, t3: 0, total: 0 };
        sums.set(week, { t1: s0.t1 + c.t1, t2: s0.t2 + c.t2, t3: s0.t3 + c.t3, total: s0.total + c.total });
      }
    }
    for (const [week, c] of sums) await write('function', department, week, c);
  }
}

// ─── Daily aggregation ────────────────────────────────────────────────────────

/**
 * Daily aggregation:
 *   - Compute OTI, DDS per function (grouped by users.department).
 *   - Write to pulse_metrics with scope_type='function', scope_id = department name.
 */
export async function runDailyAggregation(): Promise<void> {
  const client = await getTypedClient();
  const now = Math.floor(Date.now() / 1000);
  const SEVEN_DAYS = 7 * 24 * 60 * 60;

  console.log('[PulseAggregator] Running daily aggregation...');

  // Distinct departments that have any users
  const departments = (await client
    .selectDistinct({ department: schema.users.department })
    .from(schema.users)
    .where(and(isNotNull(schema.users.department), ne(schema.users.department, ''))))
    .map(r => r.department as string);

  const periodStart = now - SEVEN_DAYS;
  const periodEnd = now;

  for (const department of departments) {
    // All users in this department
    const memberIds = (await client
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.department, department))).map(r => r.id);

    if (memberIds.length === 0) continue;

    // Batch OTI/DDS across department members instead of one query pair per
    // member — same "average of member values, nulls excluded" semantics.
    const oti = averageOfBatch(otiValueMap(await computeOtiForUsers(memberIds)), memberIds);
    const dds = averageOfBatch(await computeDdsForUsers(memberIds), memberIds);

    const counts = await getTierCountsForUsers(client, memberIds, periodStart, periodEnd + 1);

    await writeMetric(client, {
      scopeType: 'function',
      scopeId: department,
      periodStart,
      periodEnd,
      oti,
      dds,
      psr: await countConfirmedCapabilities(client, memberIds),
      ors: null,  // ORS is not computed at function level in v1
      tier1Count: counts.t1,
      tier2Count: counts.t2,
      tier3Count: counts.t3,
      eventCount: counts.total,
    });
  }

  await setConfigValue('pulseAggregatorDailyLastRun', new Date().toISOString());
  console.log('[PulseAggregator] Daily aggregation complete.');
}
