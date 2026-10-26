// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { getOrgBriefingModel } from '@/lib/anthropic/model';
import Anthropic from '@anthropic-ai/sdk';
import { createAnthropicClient } from '@/lib/anthropic/client';
import { createGroundedJson, paragraphsShape } from '@/lib/anthropic/grounded-json';
import { and, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { buildDeepWorkSummary, deepWorkLines } from '@/lib/pulse/briefings/deep-work-facts';
import { getAllConfig, getConfigValue } from '@/lib/config';
import { listOpenDeptBoxes } from '@/lib/usecases/suggestion-store';
import {
  CIO_BRIEFING_SYSTEM,
  buildCioBriefingUserMessage,
  type CioBriefingContext,
} from './prompts/cio';

async function getClient(): Promise<Anthropic> {
  const apiKey = await getConfigValue('anthropicAiApiKey');
  if (!apiKey) throw new Error('No AI API key configured');
  return createAnthropicClient(apiKey);
}

function periodLabel(date: Date): string {
  return date.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

interface RawFacade {
  execute: (q: unknown) => Promise<{ rows: unknown[]; rowCount: number | null }>;
}
async function rawAll<T>(client: unknown, query: unknown): Promise<T[]> {
  const c = client as RawFacade;
  const res = await c.execute(query);
  return res.rows as T[];
}

/**
 * Generate and persist the CIO Intelligence Briefing for the organisation.
 * Returns the body text on success, throws on failure.
 */
export async function generateCioBriefing(
  periodStart: number,
  periodEnd: number,
  model: string
): Promise<string> {
  const client = await getTypedClient();
  const pc = schema.pulseClassifications;
  const pm = schema.pulseMetrics;
  const pe = schema.pulseEvents;

  // Active users in period
  const activeRows = await client
    .select({ cnt: sql<number | string>`count(distinct ${pc.user_id})` })
    .from(pc)
    .where(and(
      gte(pc.classified_at, periodStart), lt(pc.classified_at, periodEnd),
      eq(pc.classifier_status, 'classified'),
    ));
  const activeCount = Number(activeRows[0]?.cnt ?? 0);

  // Tier breakdown
  const tierRows = await client
    .select({ tier: pc.tier, cnt: sql<number | string>`count(*)` })
    .from(pc)
    .where(and(
      gte(pc.classified_at, periodStart), lt(pc.classified_at, periodEnd),
      eq(pc.classifier_status, 'classified'),
    ))
    .groupBy(pc.tier);

  const tierCounts = { 1: 0, 2: 0, 3: 0 };
  for (const row of tierRows) {
    if (row.tier === 1 || row.tier === 2 || row.tier === 3) tierCounts[row.tier] = Number(row.cnt);
  }
  const totalTier = tierCounts[1] + tierCounts[2] + tierCounts[3];

  // Average DDS and OTI
  const ddsRows = await client
    .select({ v: sql<number | string | null>`avg(${pm.dds})` })
    .from(pm)
    .where(and(
      eq(pm.scope_type, 'user'), isNotNull(pm.dds), eq(pm.granularity, 'rolling'),
      gte(pm.computed_at, periodStart), lt(pm.computed_at, periodEnd),
    ));
  const ddsValue = ddsRows[0]?.v !== null && ddsRows[0]?.v !== undefined ? Number(ddsRows[0].v) : null;

  const otiRows = await client
    .select({ v: sql<number | string | null>`avg(${pm.oti})` })
    .from(pm)
    .where(and(
      eq(pm.scope_type, 'user'), isNotNull(pm.oti), eq(pm.granularity, 'rolling'),
      gte(pm.computed_at, periodStart), lt(pm.computed_at, periodEnd),
    ));
  const otiValue = otiRows[0]?.v !== null && otiRows[0]?.v !== undefined ? Number(otiRows[0].v) : null;

  // Confirmed capability creation events this month
  const capRows = await client
    .select({ cnt: sql<number | string>`count(*)` })
    .from(pe)
    .where(and(
      eq(pe.event_type, 'capability_creation'), eq(pe.status, 'confirmed'),
      gte(pe.confirmed_at, periodStart), lt(pe.confirmed_at, periodEnd),
    ));
  const capCount = Number(capRows[0]?.cnt ?? 0);

  // Deep work this month, measured (replaces the old template frontier events).
  const deepWork = deepWorkLines(await buildDeepWorkSummary(null, periodStart, periodEnd));

  // Concentration risk — task types where exactly one user did all Tier 3 work
  // this period, counted per user, then users with >=3 such sole-owned types.
  // Kept as raw SQL: the nested GROUP BY/HAVING subquery is clearer than the
  // equivalent Drizzle builder chain (matches the "raw divergent SQL" rule).
  // Inner query groups by task_type only (to filter "exactly one distinct
  // user"), so user_id must be wrapped in an aggregate (MAX) for Postgres's
  // strict GROUP BY — harmless since HAVING COUNT(DISTINCT user_id)=1
  // guarantees the group contains only one user_id value (mirrors the
  // MAX()-wrap convention in lib/db/queries.ts's topAlertQuery).
  const tier3UserCounts = await rawAll<{ user_id: string; sole_count: number | string }>(client, sql`
    SELECT user_id, COUNT(DISTINCT task_type) as sole_count
    FROM (
      SELECT MAX(user_id) as user_id, task_type
      FROM pulse_classifications
      WHERE tier = 3 AND classifier_status = 'classified'
        AND classified_at >= ${periodStart} AND classified_at < ${periodEnd}
      GROUP BY task_type
      HAVING COUNT(DISTINCT user_id) = 1
    ) AS sole_owned
    GROUP BY user_id
    HAVING COUNT(DISTINCT task_type) >= 3
  `);

  // Departments with ORS below 0.7 (team-scope rows are never written; departments are scope 'function')
  const lowOrsTeams = await client
    .select({ scope_id: pm.scope_id })
    .from(pm)
    .where(and(
      eq(pm.scope_type, 'function'),
      isNotNull(pm.ors),
      sql`${pm.ors} < 0.7`,
      eq(pm.granularity, 'rolling'),
      gte(pm.computed_at, periodStart), lt(pm.computed_at, periodEnd),
    ))
    .groupBy(pm.scope_id);

  // Departments with any resilience score in the period: with none, "none below
  // 0.7" would read as an all-clear when nothing was measured.
  const scoredDepts = await client
    .select({ scope_id: pm.scope_id })
    .from(pm)
    .where(and(
      eq(pm.scope_type, 'function'),
      isNotNull(pm.ors),
      eq(pm.granularity, 'rolling'),
      gte(pm.computed_at, periodStart), lt(pm.computed_at, periodEnd),
    ))
    .groupBy(pm.scope_id);

  // Open department process opportunities — counts only, and only when Use
  // Cases + its content switch are both on (the same gate as the tray and the
  // act-next boxes). Reads config through getAllConfig so the content key's
  // default ('true') applies; a failure contributes nothing rather than
  // breaking the briefing.
  let deptProcessOpportunities: Array<{ department: string; count: number }> = [];
  try {
    const cfg = await getAllConfig();
    if (cfg.useCasesEnabled === true && cfg.useCasesSuggestUseContent === 'true') {
      deptProcessOpportunities = (await listOpenDeptBoxes()).map(b => ({
        department: b.department,
        count: b.suggestions.length,
      }));
    }
  } catch { /* contributes nothing */ }

  const ctx: CioBriefingContext = {
    period_label: periodLabel(new Date(periodStart * 1000)),
    weekly_active_users: activeCount,
    total_classified_events: totalTier,
    tier_1_pct: totalTier > 0 ? Math.round((tierCounts[1] / totalTier) * 100) : 0,
    tier_2_pct: totalTier > 0 ? Math.round((tierCounts[2] / totalTier) * 100) : 0,
    tier_3_pct: totalTier > 0 ? Math.round((tierCounts[3] / totalTier) * 100) : 0,
    avg_dds: ddsValue !== null ? Math.round(ddsValue * 100) / 100 : null,
    avg_oti: otiValue !== null ? Math.round(otiValue * 100) / 100 : null,
    confirmed_capability_creation_count: capCount,
    concentration_risk_count: tier3UserCounts.length,
    deep_work: deepWork,
    teams_with_ors_below_threshold: lowOrsTeams.map(r => r.scope_id),
    departments_with_ors_count: scoredDepts.length,
    dept_process_opportunities: deptProcessOpportunities,
  };

  const userMessage = buildCioBriefingUserMessage(ctx);
  // Every number in the reply must come from the prompt; one retry, then
  // GroundingRejectedError (nothing stored, so last month's briefing stays).
  const { value: parsed } = await createGroundedJson({
    client: await getClient(),
    model,
    maxTokens: 4000,
    system: CIO_BRIEFING_SYSTEM,
    userMessage,
    ...paragraphsShape(3, ['named_risk', 'recommendation'] as const),
    cycles: 2, // a refused reply gets one fresh cycle before the job records a failure
  });

  // Store body as paragraphs; suggestion field carries "named_risk — recommendation"
  const body = parsed.paragraphs.join('\n\n');
  const suggestion = [parsed.named_risk, parsed.recommendation].filter(Boolean).join('\n\n');
  const now = Math.floor(Date.now() / 1000);

  await client.insert(schema.pulseBriefings).values({
    scope_type: 'organisation',
    scope_id: 'org',
    period_start: periodStart,
    period_end: periodEnd,
    body,
    suggestion,
    model,
    generated_at: now,
  });

  return body;
}

/**
 * Scheduled job: run on the 1st of each month.
 * Covers the previous calendar month.
 */
export async function runCioBriefingJob(): Promise<void> {
  const model = await getOrgBriefingModel();
  const now = new Date();

  // Period = previous calendar month
  const periodEnd = new Date(now.getFullYear(), now.getMonth(), 1); // 1st of current month = end of last
  const periodStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  console.log(`[CioBriefing] Generating CIO briefing for ${periodLabel(periodStart)} with ${model}`);

  // A failure (including a reply the number check refused twice) is thrown, so
  // the scheduler's runJob records it and System health shows it. Nothing is
  // stored, so last month's briefing stays on the page. (It used to be caught
  // here and recorded as a success.)
  await generateCioBriefing(
    Math.floor(periodStart.getTime() / 1000),
    Math.floor(periodEnd.getTime() / 1000),
    model
  );
  console.log('[CioBriefing] Done.');
}
