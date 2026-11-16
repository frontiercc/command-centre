// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Developer Pulse for one period: this week, this month or this quarter, each against the same
 * length before it, summed from the weekly rows the aggregator already writes. One period for the
 * page, as on Work Pulse, instead of a screen mixing 7 days, 30 days and 8 weeks.
 */
import { sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import type { Vendor } from '@/lib/dashboard/vendor';
import { hasCodexData, pickCodeMetricsSource } from '@/lib/pulse/code/vendor-view';
import { PERIOD_SHAPE, type PulsePeriod } from '@/lib/pulse/period-shape';

const WEEK = 7 * 86400;

/** Weeks in each period: this week, four weeks, a quarter. */
const WEEKS: Record<PulsePeriod, number> = { week: 1, month: 4, quarter: 13 };

export interface CodePeriodWork {
  period: PulsePeriod;
  label: string;
  prior: string;
  sessions: { now: number; before: number };
  commits: { now: number; before: number };
  prs: { now: number; before: number };
  engagedSecs: { now: number; before: number };
  linesAdded: { now: number; before: number };
  spendUsd: { now: number; before: number };
  /** Per week across the window, oldest first, for the trend bars. */
  trend: { sessions: number[]; commits: number[]; engagedSecs: number[]; spendUsd: number[] };
  /** Averages over the window: null when nothing was measured. */
  automation: number | null;
  cacheHit: number | null;
  editAcceptance: number | null;
  repos: number | null;
}

interface Row {
  period_start: number | string;
  session_count: number | string | null;
  commit_count: number | string | null;
  pr_count: number | string | null;
  active_time_user_s: number | string | null;
  active_time_cli_s: number | string | null;
  lines_added: number | string | null;
  spend_usd: number | string | null;
  autonomy_ratio: number | string | null;
  cache_hit_ratio: number | string | null;
  edit_accept_count: number | string | null;
  edit_reject_count: number | string | null;
  repo_count: number | string | null;
}

function mondayOf(ts: number): number {
  const d = new Date(ts * 1000);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
  return midnight - ((d.getUTCDay() + 6) % 7) * 86400;
}

const n = (v: unknown) => Number(v ?? 0);

export async function buildCodePeriodWork(opts: {
  scopeType: 'user' | 'function' | 'org';
  scopeId: string;
  period: PulsePeriod;
  vendor: Vendor;
  nowS: number;
}): Promise<CodePeriodWork> {
  const weeks = WEEKS[opts.period];
  const thisWeek = mondayOf(opts.nowS);
  // The quarter is the 13 completed weeks, as on Work Pulse; a week or a month runs to now.
  const lastWeek = opts.period === 'quarter' ? thisWeek - WEEK : thisWeek;
  const start = lastWeek - (weeks - 1) * WEEK;
  const priorStart = start - weeks * WEEK;
  const { table, only } = await pickCodeMetricsSource(opts.vendor, await hasCodexData());

  const client = await getTypedClient();
  const rows = (await (client as unknown as { execute: (q: ReturnType<typeof sql>) => Promise<{ rows: unknown[] }> }).execute(sql`
    SELECT period_start, session_count, commit_count, pr_count, active_time_user_s, active_time_cli_s, lines_added,
           spend_usd, autonomy_ratio, cache_hit_ratio, edit_accept_count, edit_reject_count, repo_count
    FROM ${table}
    WHERE granularity = 'week' AND scope_type = ${opts.scopeType} AND scope_id = ${opts.scopeId}
      AND period_start >= ${priorStart} AND period_start <= ${lastWeek}
      ${only}
    ORDER BY period_start
  `)).rows as Row[];

  const inWindow = rows.filter(r => n(r.period_start) >= start);
  const before = rows.filter(r => n(r.period_start) < start);
  const sum = (rs: Row[], k: keyof Row) => rs.reduce((t, r) => t + n(r[k]), 0);
  const mean = (rs: Row[], k: keyof Row) => {
    const vs = rs.map(r => r[k]).filter(v => v !== null && v !== undefined).map(n);
    return vs.length === 0 ? null : vs.reduce((a, b) => a + b, 0) / vs.length;
  };

  // One point per week of the window, in order, with the empty weeks present.
  const byWeek = new Map(inWindow.map(r => [n(r.period_start), r]));
  const weekList = Array.from({ length: weeks }, (_, i) => byWeek.get(start + i * WEEK));
  const series = (k: keyof Row) => weekList.map(r => (r ? n(r[k]) : 0));
  // Engaged time is the person's time plus the CLI's, as on the productivity strip.
  const engaged = (rs: Row[]) => sum(rs, 'active_time_user_s') + sum(rs, 'active_time_cli_s');

  const accept = sum(inWindow, 'edit_accept_count');
  const reject = sum(inWindow, 'edit_reject_count');

  return {
    period: opts.period,
    label: PERIOD_SHAPE[opts.period].label,
    prior: PERIOD_SHAPE[opts.period].prior,
    sessions: { now: sum(inWindow, 'session_count'), before: sum(before, 'session_count') },
    commits: { now: sum(inWindow, 'commit_count'), before: sum(before, 'commit_count') },
    prs: { now: sum(inWindow, 'pr_count'), before: sum(before, 'pr_count') },
    engagedSecs: { now: engaged(inWindow), before: engaged(before) },
    linesAdded: { now: sum(inWindow, 'lines_added'), before: sum(before, 'lines_added') },
    spendUsd: { now: sum(inWindow, 'spend_usd'), before: sum(before, 'spend_usd') },
    trend: {
      sessions: series('session_count'),
      commits: series('commit_count'),
      engagedSecs: weekList.map(r => (r ? n(r.active_time_user_s) + n(r.active_time_cli_s) : 0)),
      spendUsd: series('spend_usd'),
    },
    automation: mean(inWindow, 'autonomy_ratio'),
    cacheHit: mean(inWindow, 'cache_hit_ratio'),
    editAcceptance: accept + reject > 0 ? accept / (accept + reject) : null,
    repos: inWindow.length === 0 ? null : Math.max(...inWindow.map(r => n(r.repo_count))),
  };
}
