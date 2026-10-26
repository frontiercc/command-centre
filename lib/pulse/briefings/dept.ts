// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres.
import Anthropic from '@anthropic-ai/sdk';
import { createAnthropicClient } from '@/lib/anthropic/client';
import { createGroundedJson, paragraphsShape } from '@/lib/anthropic/grounded-json';
import { and, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { buildDeepWorkSummary, deepWorkLines } from '@/lib/pulse/briefings/deep-work-facts';
import { getConfigValue } from '@/lib/config';
import {
  DEPT_BRIEFING_SYSTEM,
  buildDeptBriefingUserMessage,
  type DeptBriefingContext,
} from './prompts/dept';

async function getClient(): Promise<Anthropic> {
  const apiKey = await getConfigValue('anthropicAiApiKey');
  if (!apiKey) throw new Error('No AI API key configured');
  return createAnthropicClient(apiKey);
}

function periodLabel(date: Date): string {
  return date.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

export async function generateDeptBriefing(
  dept: string,
  periodStart: number,
  periodEnd: number,
  model: string
): Promise<string> {
  const client = await getTypedClient();
  const u = schema.users;
  const pc = schema.pulseClassifications;
  const pm = schema.pulseMetrics;
  const pe = schema.pulseEvents;

  const memberRows = await client.select({ id: u.id }).from(u).where(eq(u.department, dept));
  const memberIds = memberRows.map(r => r.id);

  if (memberIds.length === 0) {
    throw new Error(`No users found in department: ${dept}`);
  }

  const activeRows = await client
    .select({ cnt: sql<number | string>`count(distinct ${pc.user_id})` })
    .from(pc)
    .where(and(
      inArray(pc.user_id, memberIds),
      gte(pc.classified_at, periodStart), lt(pc.classified_at, periodEnd),
      eq(pc.classifier_status, 'classified'),
    ));
  const activeCount = Number(activeRows[0]?.cnt ?? 0);

  const tierRows = await client
    .select({ tier: pc.tier, cnt: sql<number | string>`count(*)` })
    .from(pc)
    .where(and(
      inArray(pc.user_id, memberIds),
      gte(pc.classified_at, periodStart), lt(pc.classified_at, periodEnd),
      eq(pc.classifier_status, 'classified'),
    ))
    .groupBy(pc.tier);

  const tierCounts = { 1: 0, 2: 0, 3: 0 };
  for (const row of tierRows) {
    if (row.tier === 1 || row.tier === 2 || row.tier === 3) tierCounts[row.tier] = Number(row.cnt);
  }
  const totalTier = tierCounts[1] + tierCounts[2] + tierCounts[3];

  const ddsRows = await client
    .select({ v: sql<number | string | null>`avg(${pm.dds})` })
    .from(pm)
    .where(and(
      eq(pm.scope_type, 'user'), inArray(pm.scope_id, memberIds), isNotNull(pm.dds),
      eq(pm.granularity, 'rolling'),
      gte(pm.computed_at, periodStart), lt(pm.computed_at, periodEnd),
    ));
  const ddsValue = ddsRows[0]?.v !== null && ddsRows[0]?.v !== undefined ? Number(ddsRows[0].v) : null;

  const otiRows = await client
    .select({ v: sql<number | string | null>`avg(${pm.oti})` })
    .from(pm)
    .where(and(
      eq(pm.scope_type, 'user'), inArray(pm.scope_id, memberIds), isNotNull(pm.oti),
      eq(pm.granularity, 'rolling'),
      gte(pm.computed_at, periodStart), lt(pm.computed_at, periodEnd),
    ));
  const otiValue = otiRows[0]?.v !== null && otiRows[0]?.v !== undefined ? Number(otiRows[0].v) : null;

  const capRows = await client
    .select({ cnt: sql<number | string>`count(*)` })
    .from(pe)
    .where(and(
      inArray(pe.user_id, memberIds), eq(pe.event_type, 'capability_creation'), eq(pe.status, 'confirmed'),
      gte(pe.confirmed_at, periodStart), lt(pe.confirmed_at, periodEnd),
    ));
  const capCount = Number(capRows[0]?.cnt ?? 0);

  const deepWork = deepWorkLines(await buildDeepWorkSummary(memberIds, periodStart, periodEnd));

  const tier3ByType = await client
    .select({ user_id: pc.user_id, task_type: pc.task_type })
    .from(pc)
    .where(and(
      inArray(pc.user_id, memberIds), eq(pc.tier, 3), eq(pc.classifier_status, 'classified'),
      gte(pc.classified_at, periodStart), lt(pc.classified_at, periodEnd),
    ))
    .groupBy(pc.user_id, pc.task_type);

  const typeUsers = new Map<string, Set<string>>();
  for (const row of tier3ByType) {
    const s = typeUsers.get(row.task_type) ?? new Set();
    s.add(row.user_id);
    typeUsers.set(row.task_type, s);
  }
  const soleUserCounts = new Map<string, number>();
  for (const [, users] of typeUsers) {
    if (users.size === 1) {
      const uid = [...users][0];
      soleUserCounts.set(uid, (soleUserCounts.get(uid) ?? 0) + 1);
    }
  }
  const concentrationCount = [...soleUserCounts.values()].filter(c => c >= 3).length;

  const ctx: DeptBriefingContext = {
    dept_name: dept,
    period_label: periodLabel(new Date(periodStart * 1000)),
    active_users: activeCount,
    total_classified: totalTier,
    tier_1_pct: totalTier > 0 ? Math.round((tierCounts[1] / totalTier) * 100) : 0,
    tier_2_pct: totalTier > 0 ? Math.round((tierCounts[2] / totalTier) * 100) : 0,
    tier_3_pct: totalTier > 0 ? Math.round((tierCounts[3] / totalTier) * 100) : 0,
    avg_dds: ddsValue !== null ? Math.round(ddsValue * 100) / 100 : null,
    avg_oti: otiValue !== null ? Math.round(otiValue * 100) / 100 : null,
    confirmed_capabilities: capCount,
    deep_work: deepWork,
    concentration_risk_count: concentrationCount,
  };

  // Every number in the reply must come from the prompt; one retry, then
  // GroundingRejectedError (nothing stored, so the previous briefing stays).
  const { value: parsed } = await createGroundedJson({
    client: await getClient(),
    model,
    maxTokens: 4000,
    system: DEPT_BRIEFING_SYSTEM,
    userMessage: buildDeptBriefingUserMessage(ctx),
    ...paragraphsShape(3, ['strength', 'risk_note', 'recommendation'] as const),
    cycles: 2, // a refused reply gets one fresh cycle before the job records a failure
  });

  const body = parsed.paragraphs.join('\n\n');
  const suggestion = [parsed.strength, parsed.risk_note, parsed.recommendation]
    .filter(Boolean).join('\n\n');
  const now = Math.floor(Date.now() / 1000);

  await client.insert(schema.pulseBriefings).values({
    scope_type: 'function',
    scope_id: dept,
    period_start: periodStart,
    period_end: periodEnd,
    body,
    suggestion,
    model,
    generated_at: now,
  });

  return body;
}
