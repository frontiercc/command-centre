// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { getOrgBriefingModel } from '@/lib/anthropic/model';
import { personPerProduct } from '@/lib/dashboard/product-sql';
import Anthropic from '@anthropic-ai/sdk';
import { createAnthropicClient } from '@/lib/anthropic/client';
import { createGroundedJson, paragraphsShape } from '@/lib/anthropic/grounded-json';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { buildProductFacts } from '@/lib/pulse/briefings/product-facts';
import { buildDeepWorkSummary, deepWorkLines } from '@/lib/pulse/briefings/deep-work-facts';
import { workByProductFacts } from '@/lib/pulse/briefings/work-by-product';
import { getAllConfig, getConfigValue } from '@/lib/config';
import { listOpenDeptBoxes } from '@/lib/usecases/suggestion-store';
import { getTierNames } from '@/lib/pulse/tier-config';
import { tierLines, producedLine, departmentsBelowFloor } from '@/lib/pulse/briefings/described-facts';
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
  const pe = schema.pulseEvents;

  // Active users in period
  const activeRows = await client
    // A person once for each product they used, as the pages' All view counts them.
    .select({ cnt: sql<number | string>`count(distinct ${sql.raw(personPerProduct('cowork_messages.'))})` })
    .from(pc)
    .innerJoin(schema.coworkMessages, eq(schema.coworkMessages.id, pc.cowork_message_id))
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
  const deepWork = deepWorkLines(await buildDeepWorkSummary(null, periodStart, periodEnd), (await getTierNames()).t3);

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

  const tierNames = await getTierNames();
  const ctx: CioBriefingContext = {
    period_label: periodLabel(new Date(periodStart * 1000)),
    weekly_active_users: activeCount,
    total_classified_events: totalTier,
    tier_lines: tierLines(tierNames, tierCounts),
    produced_line: await producedLine(null, periodStart, periodEnd),
    confirmed_capability_creation_count: capCount,
    concentration_risk_count: tier3UserCounts.length,
    deep_work: deepWork,
    work_by_product: await workByProductFacts(null, periodStart, periodEnd),
    floor_line: await departmentsBelowFloor(periodStart, periodEnd, tierNames),
    dept_process_opportunities: deptProcessOpportunities,
    products: await buildProductFacts({ periodStart, periodEnd }),
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
