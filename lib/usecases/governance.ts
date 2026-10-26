// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Governance rollup assembly for the CIO view (Phase 3). Reads ONLY the
 * pre-aggregated weekly tables (never re-scans telemetry). Measured counts
 * are fact; hours/$ are estimates (see lib/usecases/value.ts). Absent weeks
 * are null in the series — an absent week means "not measured", never "quiet".
 *
 * Async Drizzle on Postgres.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { listUseCases } from '@/lib/usecases/queries';
import { weekStarts } from '@/lib/pulse/period';
import {
  computeHoursRecovered, computeDollarsRecovered, sumMeasuredSessions,
  WORKING_HOURS_PER_YEAR, type BetCalibration,
} from '@/lib/usecases/value';
import { getWindowDistinctUsers, type WeekActivity } from '@/lib/usecases/weeks';

const WEEK = 7 * 86400;
const WINDOW_WEEKS = 13;
const ALL_WORKFLOWS_CAP = 50;

export interface GovernanceBet {
  id: string;
  title: string;
  ownerDisplayName: string | null;
  departments: string[];
  lifecycle: string;
  weeksInLifecycle: number | null;
  measured: { distinctUsers: number; sessions: number; hours: number | null };
  estimated: { hoursRecovered: number };
  series: Array<number | null>;
}

/**
 * Every confirmed, non-strategic use case — the "map" beside the curated
 * strategic bets above. Measured-only: no $ estimate, no owner/departments.
 * Ranked by measuredHours desc with null-measured rows last (a workflow with
 * no measured session time isn't "worse", it's simply unmeasured — but it
 * still sorts after anything with a real number so the ranking reads sensibly).
 */
export interface GovernanceWorkflow {
  id: string;
  title: string;
  lifecycle: string;
  series: Array<number | null>;
  measuredHours: number | null;
  distinctUsers: number;
}

export interface GovernanceRollup {
  window: { weeks: number; endsWeekStart: number; label: string };
  headline: { declared: number; adopted: number; piloting: number; atRisk: number; notSeen: number };
  value: {
    hoursRecovered: number;
    dollarsRecovered: number;
    isEstimate: true;
    calibration: { minutesPerSession: number; loadedCompAnnual: number; workingHoursPerYear: number };
  };
  narrative: string;
  bets: GovernanceBet[];
  allWorkflows: GovernanceWorkflow[];
  allWorkflowsTotal: number;
}

async function resolveOwnerName(ownerUserId: string | null): Promise<string | null> {
  if (!ownerUserId) return null;
  const client = await getTypedClient();
  const u = schema.users;
  const rows = await client.select({ display_name: u.display_name, email: u.email }).from(u).where(eq(u.id, ownerUserId)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return row.display_name || row.email || null;
}

/** One window week's impact columns (Workflow Impact package) — null across all six means "no measured session that week", not zero. */
type ImpactRow = {
  measured_duration_secs: number | null;
  engaged_secs: number | null;
  tool_error_count: number | null;
  cowork_tool_error_count: number | null;
  edit_reject_count: number | null;
  edit_accept_count: number | null;
  flagged_count: number | null;
};

/** Map the 13 window weeks to sessionCount (present) or null (absent). */
async function buildSeries(useCaseId: string, windowStarts: number[]): Promise<{ series: Array<number | null>; measuredWeeks: WeekActivity[]; impactRows: ImpactRow[] }> {
  const client = await getTypedClient();
  const t = schema.useCaseActivationWeeks;
  const rows = await client
    .select({
      week_start: t.week_start, distinct_users: t.distinct_users, session_count: t.session_count,
      matched_messages: t.matched_messages, latest_tier: t.latest_tier, last_seen_at: t.last_seen_at,
      measured_duration_secs: t.measured_duration_secs, engaged_secs: t.engaged_secs,
      tool_error_count: t.tool_error_count, edit_reject_count: t.edit_reject_count,
      edit_accept_count: t.edit_accept_count, flagged_count: t.flagged_count,
      cowork_tool_error_count: t.cowork_tool_error_count,
    })
    .from(t)
    .where(and(eq(t.use_case_id, useCaseId), inArray(t.week_start, windowStarts)));

  const byWeek = new Map(rows.map(r => [r.week_start, r]));
  const series = windowStarts.map(ws => (byWeek.has(ws) ? byWeek.get(ws)!.session_count : null));
  const measuredWeeks: WeekActivity[] = rows.map(r => ({
    weekStart: r.week_start, distinctUsers: r.distinct_users, sessionCount: r.session_count,
    matchedMessages: r.matched_messages, latestTier: r.latest_tier, lastSeenAt: r.last_seen_at,
  }));
  const impactRows: ImpactRow[] = rows.map(r => ({
    measured_duration_secs: r.measured_duration_secs, engaged_secs: r.engaged_secs,
    tool_error_count: r.tool_error_count, cowork_tool_error_count: r.cowork_tool_error_count,
    edit_reject_count: r.edit_reject_count,
    edit_accept_count: r.edit_accept_count, flagged_count: r.flagged_count,
  }));
  return { series, measuredWeeks, impactRows };
}

/** Σ the given columns across rows; null (never 0) when every row's value for every key is null — "not measured", not "measured zero". */
function sumNullable(rows: Array<Record<string, number | null>>, keys: string[]): number | null {
  let any = false;
  let total = 0;
  for (const r of rows) for (const k of keys) { if (r[k] != null) { any = true; total += Number(r[k]); } }
  return any ? total : null;
}

function secsToHours(secs: number | null): number | null {
  return secs === null ? null : Math.round((secs / 3600) * 10) / 10;
}

function formatWindowLabel(endsWeekStart: number): string {
  const end = new Date((endsWeekStart + 6 * 86400) * 1000); // Sunday of the last completed week
  return `Quarter to ${end.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

export function buildGovernanceNarrative(bets: GovernanceBet[]): string {
  if (bets.length === 0) return 'No strategic bets have been declared yet.';
  const adopted = bets.filter(b => b.lifecycle === 'adopted');
  const atRisk = bets.filter(b => b.lifecycle === 'at_risk');
  const parts: string[] = [];

  // Adoption concentration by department (top 2 depts among adopted bets).
  const deptCounts = new Map<string, number>();
  for (const b of adopted) for (const d of b.departments) deptCounts.set(d, (deptCounts.get(d) ?? 0) + 1);
  const topDepts = [...deptCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(e => e[0]);
  if (adopted.length > 0 && topDepts.length > 0) {
    parts.push(`Adoption is concentrated in ${topDepts.join(' and ')}.`);
  } else if (adopted.length > 0) {
    parts.push(`${adopted.length} of ${bets.length} declared ${bets.length === 1 ? 'bet is' : 'bets are'} adopted.`);
  }

  if (atRisk.length > 0) {
    const b = atRisk[0];
    const owner = b.ownerDisplayName ? `, owner ${b.ownerDisplayName}` : '';
    const wk = b.weeksInLifecycle != null ? ` for ${b.weeksInLifecycle} ${b.weeksInLifecycle === 1 ? 'week' : 'weeks'}` : '';
    parts.push(`${atRisk.length} at-risk ${atRisk.length === 1 ? 'bet' : 'bets'}: ${b.title} has been quiet${wk}${owner}.`);
  }
  return parts.join(' ') || `${bets.length} declared ${bets.length === 1 ? 'bet' : 'bets'}, all in early stages.`;
}

export async function buildGovernanceRollup(nowS: number, cal: BetCalibration): Promise<GovernanceRollup> {
  const windowStarts = weekStarts(nowS - WEEK, WINDOW_WEEKS); // 13 completed weeks, ascending
  const endsWeekStart = windowStarts[windowStarts.length - 1];

  const confirmed = await listUseCases({ status: 'confirmed' });
  const betsRaw = confirmed.filter(u => u.strategic === 1);
  const workflowsRaw = confirmed.filter(u => u.strategic !== 1);

  const bets: GovernanceBet[] = await Promise.all(betsRaw.map(async uc => {
    const { series, measuredWeeks, impactRows } = await buildSeries(uc.id, windowStarts);
    const sessions = sumMeasuredSessions(measuredWeeks);
    const distinctUsers = await getWindowDistinctUsers(uc.id, windowStarts);
    const hoursRecovered = computeHoursRecovered(sessions, cal);
    const hours = secsToHours(sumNullable(impactRows, ['measured_duration_secs']));
    const weeksInLifecycle = uc.lifecycleChangedAt != null
      ? Math.max(0, Math.floor((nowS - uc.lifecycleChangedAt) / WEEK))
      : null;
    return {
      id: uc.id,
      title: uc.title,
      ownerDisplayName: await resolveOwnerName(uc.ownerUserId),
      departments: uc.departments,
      lifecycle: uc.lifecycle,
      weeksInLifecycle,
      measured: { distinctUsers, sessions, hours },
      estimated: { hoursRecovered },
      series,
    };
  }));

  const allWorkflowsUnranked: GovernanceWorkflow[] = await Promise.all(workflowsRaw.map(async uc => {
    const { series, impactRows } = await buildSeries(uc.id, windowStarts);
    const distinctUsers = await getWindowDistinctUsers(uc.id, windowStarts);
    const measuredHours = secsToHours(sumNullable(impactRows, ['measured_duration_secs']));
    // frictionCount removed: a raw 13-week count
    // with no rate/baseline invited unsupported conclusions; the weekly
    // friction columns are still collected.
    return { id: uc.id, title: uc.title, lifecycle: uc.lifecycle, series, measuredHours, distinctUsers };
  }));

  // Ranked measuredHours desc; null-measured rows always sort last (unmeasured
  // isn't "worse" than a genuine low number, but it can't be compared to one).
  const allWorkflowsRanked = [...allWorkflowsUnranked].sort((a, b) => {
    if (a.measuredHours === null && b.measuredHours === null) return 0;
    if (a.measuredHours === null) return 1;
    if (b.measuredHours === null) return -1;
    return b.measuredHours - a.measuredHours;
  });
  const allWorkflowsTotal = allWorkflowsRanked.length;
  const allWorkflows = allWorkflowsRanked.slice(0, ALL_WORKFLOWS_CAP);

  const headline = {
    declared: bets.length,
    adopted: bets.filter(b => b.lifecycle === 'adopted').length,
    piloting: bets.filter(b => b.lifecycle === 'piloting').length,
    atRisk: bets.filter(b => b.lifecycle === 'at_risk').length,
    notSeen: bets.filter(b => b.lifecycle === 'not_seen').length,
  };

  const totalHours = bets.reduce((acc, b) => acc + b.estimated.hoursRecovered, 0);
  const dollarsRecovered = computeDollarsRecovered(totalHours, cal);

  return {
    window: { weeks: WINDOW_WEEKS, endsWeekStart, label: formatWindowLabel(endsWeekStart) },
    headline,
    value: {
      hoursRecovered: totalHours,
      dollarsRecovered,
      isEstimate: true,
      calibration: {
        minutesPerSession: cal.minutesPerSession,
        loadedCompAnnual: cal.loadedCompAnnual,
        workingHoursPerYear: WORKING_HOURS_PER_YEAR,
      },
    },
    narrative: buildGovernanceNarrative(bets),
    bets,
    allWorkflows,
    allWorkflowsTotal,
  };
}
