// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Weekly Exec Digest — deterministic content builder.
 *
 * Assembles a plain-data snapshot of "last week's AI story" from data CCC
 * already computes: the completed-week rows written by the code/cowork
 * aggregators (lib/pulse/code/aggregator.ts, lib/pulse/aggregator.ts),
 * the alerts table, and (read-only) the latest stored Developer Pulse weekly
 * briefing. No Anthropic API call happens here — the briefing excerpt is
 * only ever reused from prior storage, never generated inline.
 *
 * "Completed week" = the calendar week (Mon 00:00 UTC .. next Mon) before
 * the one containing `now` — i.e. weekStart(now) - 7 days. Both aggregators
 * upsert one row per (scope_type, scope_id, period_start) with
 * granularity='week' once that week has fully elapsed.
 */
import { sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { getConfigValue } from '@/lib/config';
import { weekStart } from '@/lib/pulse/period';
import { readOrgHumanTime, type OrgHumanTime } from '@/lib/pulse/human-time-summary';
import { getWeeklyDelta } from '@/lib/pulse/trends';
import { getCodePulseHealth } from '@/lib/pulse/code/health';
import { getCodeModelRates, spendIsPartlyEstimated as computeSpendIsPartlyEstimated } from '@/lib/pulse/code/rates';
import { ORG_SCOPE_ID } from '@/lib/pulse/code/aggregator';
import { getLatestCodeBriefing } from '@/lib/pulse/code/briefing';
import { listUseCases } from '@/lib/usecases/queries';
import { getMeasuredCompletedWeeks } from '@/lib/usecases/weeks';
import { getCoachingCountsByDept } from '@/lib/usecases/spread';
import { SEVERITY_RANK } from '@/lib/alerts/severity';

const DAY = 86400;
const WEEK = 7 * DAY;
const BRIEFING_EXCERPT_LEN = 400;

// ─── Phase 3 raw-execution facade (mirrors lib/db/queries.ts's rawAll) ────────
interface RawFacade {
  execute: (q: unknown) => Promise<{ rows: unknown[]; rowCount: number | null }>;
}
async function rawAll<T>(client: unknown, query: unknown): Promise<T[]> {
  const c = client as RawFacade;
  const res = await c.execute(query);
  return res.rows as T[];
}

export interface DigestData {
  weekStart: number;
  weekEnd: number;
  code: {
    spendUsd: number | null;
    spendDeltaPct: number | null;
    spendIsPartlyEstimated: boolean;
    unpricedModelCount: number;
    commits: number;
    prs: number;
    engagedHours: number | null;
    activeUsers: number;
  } | null;
  cowork: {
    classifiedEvents: number;
    eventsDeltaPct: number | null;
    tier3Count: number;
    tier3DeltaPct: number | null;
    activeUsers: number;
  } | null;
  anomaly: { title: string; severity: string; occurredAt: number; userLinked: boolean } | null;
  briefingExcerpt: string | null;
  useCases: {
    atRisk: Array<{ title: string; owner: string | null; quietWeeks: number }>;
    newlyAdopted: string[];
    newlyAtRisk: string[];
  } | null;
  /**
   * Counts-only coaching-opportunity signal (Spread Panel):
   * {dept, count} pairs from getCoachingCountsByDept.
   * Deliberately never enriched with names here: that module's whole
   * contract is that user identity never leaves it. null when
   * useCasesEnabled is off (coaching rides the same flag as Use Cases)
   * or when there is nothing to report.
   */
  coaching: Array<{ dept: string; count: number }> | null;
  /** Human time vs Claude time for the completed week, org totals only. Null when off or empty. */
  humanTime?: OrgHumanTime | null;
}

async function buildCode(periodStart: number, periodEnd: number, now: number): Promise<DigestData['code']> {
  const db = await getTypedClient();

  // spend_usd is `numeric` on Postgres → returned as a STRING; the integer
  // columns come back native. Number()-coerce spend_usd
  // (preserving null) + the integer reads at the read site (Policy B).
  const rows = await rawAll<{
    spend_usd: number | string | null;
    commit_count: number | string;
    pr_count: number | string;
    active_time_user_s: number | string;
    session_count: number | string;
  }>(
    db,
    sql`SELECT spend_usd, commit_count, pr_count, active_time_user_s, session_count
     FROM code_metrics
     WHERE scope_type = 'organisation' AND scope_id = ${ORG_SCOPE_ID} AND granularity = 'week' AND period_start = ${periodStart}`
  );
  const row = rows[0];

  if (!row) return null;

  const spendDelta = await getWeeklyDelta('code_metrics', 'organisation', ORG_SCOPE_ID, 'spend_usd', 4, now);

  // COUNT(*) → bigint → STRING on Postgres; Number()-coerce.
  const activeUsersRows = await rawAll<{ c: number | string }>(
    db,
    sql`SELECT COUNT(*) AS c FROM code_metrics
     WHERE scope_type = 'user' AND granularity = 'week' AND period_start = ${periodStart} AND session_count > 0`
  );
  const activeUsersC = Number(activeUsersRows[0]?.c ?? 0);

  // Models actually used within the completed week, from per-session rollups
  // (code_session_stats.models_json), to decide whether this week's spend
  // includes any Bedrock/Vertex usage priced only via the normalised-key
  // (list-rate) fallback — see rates.ts spendIsPartlyEstimated.
  const sessionRows = await rawAll<{ models_json: string | null }>(
    db,
    sql`SELECT models_json FROM code_session_stats WHERE last_at >= ${periodStart} AND last_at < ${periodEnd}`
  );

  const modelsInWeek = new Set<string>();
  for (const s of sessionRows) {
    if (!s.models_json) continue;
    try {
      const parsed = JSON.parse(s.models_json) as Record<string, unknown>;
      for (const model of Object.keys(parsed)) modelsInWeek.add(model);
    } catch {
      // malformed models_json — ignore for the estimate flag, health.ts
      // separately tracks malformedModelsJson
    }
  }

  const rates = await getCodeModelRates();
  const spendIsPartlyEstimated = computeSpendIsPartlyEstimated(Array.from(modelsInWeek), rates);
  const unpricedModelCount = (await getCodePulseHealth()).unpricedModels.length;

  return {
    spendUsd: row.spend_usd === null || row.spend_usd === undefined ? null : Number(row.spend_usd),
    spendDeltaPct: spendDelta.pct,
    spendIsPartlyEstimated,
    unpricedModelCount,
    commits: Number(row.commit_count),
    prs: Number(row.pr_count),
    // active_time_user_s is NOT NULL DEFAULT 0 on code_metrics, so this is
    // always a number — never null in practice, but the interface allows it
    // for symmetry with the other "no data" fields.
    engagedHours: Math.round((Number(row.active_time_user_s) / 3600) * 10) / 10,
    activeUsers: activeUsersC,
  };
}

interface CoworkAggregateRow {
  eventCount: number;
  tier3Count: number;
  activeUsers: number;
}

async function sumCoworkUserWeek(periodStart: number): Promise<CoworkAggregateRow | null> {
  const db = await getTypedClient();
  const rows = await rawAll<{ event_count: number | string; tier_3_count: number | string }>(
    db,
    sql`SELECT event_count, tier_3_count FROM pulse_metrics
     WHERE scope_type = 'user' AND granularity = 'week' AND period_start = ${periodStart}`
  );

  if (rows.length === 0) return null;

  let eventCount = 0;
  let tier3Count = 0;
  let activeUsers = 0;
  for (const r of rows) {
    const ec = Number(r.event_count);
    eventCount += ec;
    tier3Count += Number(r.tier_3_count);
    if (ec > 0) activeUsers++;
  }

  return { eventCount, tier3Count, activeUsers };
}

function pctDelta(current: number | null, prior: number | null): number | null {
  if (current === null || prior === null || prior === 0) return null;
  return (current - prior) / prior;
}

async function buildCowork(periodStart: number): Promise<DigestData['cowork']> {
  const current = await sumCoworkUserWeek(periodStart);
  if (!current) return null;

  const prior = await sumCoworkUserWeek(periodStart - WEEK);

  return {
    classifiedEvents: current.eventCount,
    eventsDeltaPct: pctDelta(current.eventCount, prior?.eventCount ?? null),
    tier3Count: current.tier3Count,
    tier3DeltaPct: pctDelta(current.tier3Count, prior?.tier3Count ?? null),
    activeUsers: current.activeUsers,
  };
}

async function buildAnomaly(periodStart: number, periodEnd: number): Promise<DigestData['anomaly']> {
  const db = await getTypedClient();
  // generated_at is bigint → a STRING from a raw pg query; Number()-coerce it
  // so the sort + returned occurredAt are numeric.
  const raw = await rawAll<{ title: string; severity: string; status: string; generated_at: number | string; user_id: string | null }>(
    db,
    sql`SELECT title, severity, status, generated_at, user_id FROM alerts
     WHERE generated_at >= ${periodStart} AND generated_at < ${periodEnd}`
  );
  const rows = raw.map(r => ({ ...r, generated_at: Number(r.generated_at) }));

  // Fail-closed allowlist: only 'open' alerts are eligible to surface as the
  // digest anomaly. Any unknown/future status is treated as acknowledged
  // rather than risking a stale or already-handled alert leaking through.
  const eligible = rows.filter(r => r.status === 'open');
  if (eligible.length === 0) return null;

  eligible.sort((a, b) => {
    const rankDiff = (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0);
    if (rankDiff !== 0) return rankDiff;
    // Same severity: prefer the most recent incident (freshest signal for
    // an exec digest) rather than the oldest.
    return b.generated_at - a.generated_at;
  });

  const top = eligible[0];
  return { title: top.title, severity: top.severity, occurredAt: top.generated_at, userLinked: top.user_id !== null };
}

async function buildBriefingExcerpt(periodStart: number): Promise<string | null> {
  const briefing = await getLatestCodeBriefing();
  if (!briefing) return null;
  if (briefing.generated_at <= periodStart) return null;
  return briefing.body.slice(0, BRIEFING_EXCERPT_LEN);
}

async function buildUseCases(periodStart: number, periodEnd: number, now: number): Promise<DigestData['useCases']> {
  if ((await getConfigValue('useCasesEnabled')) !== 'true') return null;

  const all = (await listUseCases()).filter(u => u.status !== 'archived');

  const atRisk = await Promise.all(all.filter(u => u.lifecycle === 'at_risk').map(async u => {
    const weeks = await getMeasuredCompletedWeeks(u.id, 8, now);
    let quiet = 0;
    for (let i = weeks.length - 1; i >= 0; i--) {
      if (weeks[i].matchedMessages > 0 || weeks[i].sessionCount > 0) break;
      quiet++;
    }
    return { title: u.title, owner: u.ownerUserId, quietWeeks: quiet };
  }));

  const inWeek = (u: (typeof all)[number]) =>
    u.lifecycleChangedAt != null && u.lifecycleChangedAt >= periodStart && u.lifecycleChangedAt < periodEnd;

  const newlyAdopted = all.filter(u => u.lifecycle === 'adopted' && inWeek(u)).map(u => u.title);
  const newlyAtRisk = all.filter(u => u.lifecycle === 'at_risk' && inWeek(u)).map(u => u.title);

  if (atRisk.length === 0 && newlyAdopted.length === 0 && newlyAtRisk.length === 0) return null;

  return { atRisk, newlyAdopted, newlyAtRisk };
}

async function buildCoaching(now: number): Promise<DigestData['coaching']> {
  if ((await getConfigValue('useCasesEnabled')) !== 'true') return null;

  const counts = await getCoachingCountsByDept(now);
  if (counts.length === 0) return null;

  return counts;
}

/**
 * Build the digest content for the last COMPLETED calendar week relative to
 * `now` (defaults to the current time). Returns null when neither surface
 * has a completed-week row yet — nothing to send.
 */
export async function buildDigest(now: number = Math.floor(Date.now() / 1000)): Promise<DigestData | null> {
  const periodStart = weekStart(now) - WEEK;
  const periodEnd = periodStart + WEEK;

  const code = await buildCode(periodStart, periodEnd, now);
  const cowork = await buildCowork(periodStart);

  if (!code && !cowork) return null;

  return {
    weekStart: periodStart,
    weekEnd: periodEnd,
    code,
    cowork,
    anomaly: await buildAnomaly(periodStart, periodEnd),
    briefingExcerpt: await buildBriefingExcerpt(periodStart),
    useCases: await buildUseCases(periodStart, periodEnd, now),
    coaching: await buildCoaching(now),
    humanTime: await readOrgHumanTime(periodStart, periodEnd),
  };
}
