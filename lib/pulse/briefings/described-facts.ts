// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * The facts the Work Pulse briefings describe the work with, in place of the old scores (delegation
 * depth, output throughput, resilience). The pages describe work in counts and shares the reader
 * can picture; the briefings say the same things the same way. Every figure is worked out here, in
 * code, and the model only words it (CLAUDE.md, rule 3).
 */
import { PC_MESSAGE } from '@/lib/pulse/classification-message';
import { sql, type SQL } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { getConfigValue } from '@/lib/config';
import { visibleVendor } from '@/lib/sources/openai-visibility';
import { readWorkSessions } from '@/lib/pulse/cowork/work-sessions';
import { isWorkPulseSurface } from '@/lib/pulse/work-surfaces';
import { vendorClause } from '@/lib/dashboard/product-sql';
import { tierNamesOr, type TierNames } from '@/lib/pulse/tier-names';
import { briefingCount, largestTierLine, wholeShares } from '@/lib/pulse/briefings/format';

/** The rule every Work Pulse briefing's system prompt carries. */
export const DESCRIBE_NOT_SCORE_RULE =
  'Never use scores, indexes or ratios, and never use any of these terms or anything like them: delegation depth, DDS, output throughput, output quality, output quality index, output transformation, OTI, resilience score, ORS, PSR, friction, high-friction, Tier 1, Tier 2, Tier 3, routine admin, routine single-step, high-stakes or high stakes. No multipliers (a number followed by x). Describe the work with the counts and shares given, in plain words. Name the tiers only by the names given, never by number. When you describe a tier, put its description in brackets after its name. The largest kind of work is stated in the data: never call a smaller share "mostly". Write percentages as figures with a % sign, never as word fractions such as "a quarter" or "half". Never use a colon as a dash, and never use more than one colon in a sentence. Never judge a kind of work as good or bad, passive or valuable. Never give a reason for a figure that the data does not state.';

/** The three tiers as this customer names them, with a share of the total each, for the facts. Shares add up to 100. */
export function tierLines(names: TierNames | null | undefined, counts: { 1: number; 2: number; 3: number }): string[] {
  const t = tierNamesOr(names);
  const c: [number, number, number] = [counts[1], counts[2], counts[3]];
  const shares = wholeShares(c);
  const share = (i: number) => (shares ? ` (${shares[i]}% of tasks)` : '');
  const lines = [
    `${t.t1} (quick, single tasks): ${briefingCount(c[0])}${share(0)}`,
    `${t.t2} (whole pieces of work): ${briefingCount(c[1])}${share(1)}`,
    `${t.t3} (the deepest work): ${briefingCount(c[2])}${share(2)}`,
  ];
  const largest = largestTierLine([t.t1, t.t2, t.t3], c);
  if (largest) lines.push(largest);
  return lines;
}

/**
 * How many sessions produced something, of those where it could be seen: a file saved, sent or
 * published, an artifact or file in Claude Chat, a file listed on a ChatGPT reply. Measured.
 */
export async function producedLine(userIds: string[] | null, since: number, until: number): Promise<string> {
  const sessions = await readWorkSessions({ since, until, vendor: await visibleVendor(null), userIds: userIds ?? undefined });
  const measured = sessions.filter(s => s.produced !== null);
  if (measured.length === 0) return 'Sessions that produced something: not measured in this period.';
  const produced = measured.filter(s => s.produced).length;
  return `Sessions that produced something (a file saved, sent or published, an artifact, or a file listed on a reply): ${briefingCount(produced)} of the ${briefingCount(measured.length)} sessions where it could be seen (${Math.round((produced / measured.length) * 100)}%).`;
}

/** The admin's floor for a department's share of meaningful or frontier work, as the Overview reads it. */
async function depthFloor(): Promise<number | null> {
  const raw = (await getConfigValue('targetDeptRealWorkPct')) ?? '';
  const n = Number(raw);
  return raw === '' ? 33 : Number.isFinite(n) && n > 0 && n <= 100 ? n : null;
}

/**
 * Departments whose share of meaningful or frontier work in the period is below the admin's floor,
 * the measure the Overview shows. Replaces "departments below a 0.7 resilience score".
 */
export async function departmentsBelowFloor(since: number, until: number, names: TierNames | null | undefined): Promise<string> {
  const floor = await depthFloor();
  const t = tierNamesOr(names);
  const deep = `${t.t2.toLowerCase()} or ${t.t3.toLowerCase()} work`;
  if (floor === null) return `No floor is set for a department's share of ${deep}.`;
  const client = await getTypedClient();
  const vendor = await visibleVendor(null);
  const rows = (await (client as unknown as { execute: (q: SQL) => Promise<{ rows: unknown[] }> }).execute(sql`
    SELECT COALESCE(NULLIF(au.department, ''), NULLIF(u.department, '')) AS d,
           COUNT(*) FILTER (WHERE pc.tier >= 2) AS deep, COUNT(*) AS n
    FROM pulse_classifications pc
    ${PC_MESSAGE}
    LEFT JOIN users u ON u.id = pc.user_id
    LEFT JOIN admin_users au ON au.linked_cowork_user_id = pc.user_id
    WHERE pc.classifier_status = 'classified'
      AND ${isWorkPulseSurface(sql`cm.surface`, true)} AND ${sql.raw(vendorClause(vendor, 'cm.'))}
      AND cm.occurred_at >= ${since} AND cm.occurred_at < ${until}
    GROUP BY 1
  `)).rows as Array<{ d: string | null; deep: number | string; n: number | string }>;
  const measured = rows.filter(r => r.d && Number(r.n) > 0);
  if (measured.length === 0) return `No department had judged work in this period, so none can be compared with the floor.`;
  const below = measured
    .map(r => ({ d: r.d!, share: Number(r.deep) / Number(r.n) }))
    .filter(r => r.share * 100 < floor)
    .sort((a, b) => a.share - b.share);
  if (below.length === 0) return `Every one of the ${measured.length} departments is at or above the floor of ${floor}% ${deep}.`;
  return `Departments below the floor of ${floor}% ${deep}, ${below.length} of ${measured.length}: ${below.map(b => `${b.d} (${Math.round(b.share * 100)}%)`).join(', ')}.`;
}

/**
 * The briefing's period in words. A whole calendar month (the scheduled run) reads "October 2026";
 * any other window (Generate now covers the last 30 days) reads by its dates, "15 October to
 * 14 November 2026", so a briefing never names a month it only half covers. Times are seconds;
 * the end is exclusive.
 */
export function briefingPeriodLabel(startS: number, endS: number): string {
  const start = new Date(startS * 1000);
  const last = new Date((endS - 1) * 1000);
  const wholeMonth = start.getDate() === 1 && start.getHours() === 0 && start.getMinutes() === 0
    && new Date(endS * 1000).getDate() === 1
    && start.getMonth() === last.getMonth() && start.getFullYear() === last.getFullYear();
  if (wholeMonth) return start.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const sameYear = start.getFullYear() === last.getFullYear();
  const from = start.toLocaleDateString('en-GB', sameYear ? { day: 'numeric', month: 'long' } : { day: 'numeric', month: 'long', year: 'numeric' });
  const to = last.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  return `${from} to ${to}`;
}
