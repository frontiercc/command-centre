// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres.
import { getUserBriefingModel } from '@/lib/anthropic/model';
import Anthropic from '@anthropic-ai/sdk';
import { createAnthropicClient } from '@/lib/anthropic/client';
import { createGroundedJson, GroundingRejectedError, paragraphsShape } from '@/lib/anthropic/grounded-json';
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { buildFrontierView } from '@/lib/pulse/frontier-view';
import { describeWork, kindText } from '@/lib/pulse/briefings/deep-work-facts';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getConfigValue } from '@/lib/config';
import {
  WEEKLY_BRIEFING_SYSTEM,
  buildWeeklyBriefingUserMessage,
  type WeeklyBriefingContext,
} from './prompts/weekly';

async function getClient(): Promise<Anthropic> {
  const apiKey = await getConfigValue('anthropicAiApiKey');
  if (!apiKey) throw new Error('No AI API key configured');
  return createAnthropicClient(apiKey);
}

function formatDateLabel(date: Date): string {
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * Generate and persist a weekly briefing for a single user.
 * Returns the body text on success, throws on failure.
 */
export async function generateUserWeeklyBriefing(
  userId: string,
  periodStart: number,
  periodEnd: number,
  model: string
): Promise<string> {
  const client = await getTypedClient();
  const u = schema.users;
  const pc = schema.pulseClassifications;
  const cm = schema.coworkMessages;
  const pm = schema.pulseMetrics;

  const userRows = await client.select({ display_name: u.display_name }).from(u).where(eq(u.id, userId)).limit(1);
  const user = userRows[0];

  const tierRows = await client
    .select({ tier: pc.tier, cnt: sql<number | string>`count(*)` })
    .from(pc)
    .innerJoin(cm, eq(cm.id, pc.cowork_message_id))
    .where(and(
      eq(pc.user_id, userId), eq(pc.classifier_status, 'classified'),
      gte(cm.occurred_at, periodStart), lt(cm.occurred_at, periodEnd),
    ))
    .groupBy(pc.tier);

  const tierCounts = { 1: 0, 2: 0, 3: 0 };
  for (const row of tierRows) {
    if (row.tier === 1 || row.tier === 2 || row.tier === 3) tierCounts[row.tier] = Number(row.cnt);
  }

  const taskTypeRows = await client
    .selectDistinct({ task_type: pc.task_type })
    .from(pc)
    .innerJoin(cm, eq(cm.id, pc.cowork_message_id))
    .where(and(
      eq(pc.user_id, userId), eq(pc.classifier_status, 'classified'),
      gte(cm.occurred_at, periodStart), lt(cm.occurred_at, periodEnd),
    ));

  const metricsRows = await client
    .select({ dds: pm.dds, oti: pm.oti })
    .from(pm)
    .where(and(eq(pm.scope_type, 'user'), eq(pm.scope_id, userId), eq(pm.granularity, 'rolling')))
    .orderBy(desc(pm.computed_at))
    .limit(1);
  const metrics = metricsRows[0];

  // Deep work, measured (the same facts as the frontier boxes). Built with the
  // default viewer, so no AI summary or file name is ever included.
  const deepWork: string[] = [];
  try {
    const view = await buildFrontierView({ userId }, periodEnd);
    const best = view.bestWork[0];
    if (best && best.occurredAt >= periodStart) deepWork.push(`Deepest piece of work this week: ${describeWork(best)}`);
    if (view.mainstay?.item) {
      deepWork.push(`Main kind of Tier 3 work over the last 30 days: ${kindText(view.mainstay.item.taskType)} (${view.mainstay.count} of ${view.mainstay.tier3Sessions} Tier 3 sessions)`);
    }
    for (const c of view.capabilities.filter(c => c.occurredAt >= periodStart)) {
      deepWork.push(`New capability this week: ${describeWork(c)} (${c.capability?.status === 'confirmed' ? 'confirmed' : 'awaiting review'})`);
    }
  } catch (err) {
    console.error('[weekly-briefing] deep-work facts unavailable', err instanceof Error ? err.message : err);
  }

  const ctx: WeeklyBriefingContext = {
    user_id: userId,
    display_name: user?.display_name ?? null,
    period_start_label: formatDateLabel(new Date(periodStart * 1000)),
    period_end_label: formatDateLabel(new Date(periodEnd * 1000)),
    tier_1_count: tierCounts[1],
    tier_2_count: tierCounts[2],
    tier_3_count: tierCounts[3],
    dds: metrics?.dds ?? null,
    oti: metrics?.oti ?? null,
    deep_work: deepWork,
    task_types_used: taskTypeRows.map(r => r.task_type),
  };

  const userMessage = buildWeeklyBriefingUserMessage(ctx);
  // Every number in the reply must come from the prompt; one retry, then
  // GroundingRejectedError (nothing stored, so last week's briefing stays).
  const { value: parsed } = await createGroundedJson({
    client: await getClient(),
    model,
    maxTokens: 4000,
    system: WEEKLY_BRIEFING_SYSTEM,
    userMessage,
    ...paragraphsShape(3, ['suggestion'] as const),
    cycles: 2, // a refused reply gets one fresh cycle before the job records a failure
  });

  const body = parsed.paragraphs.join('\n\n');
  const now = Math.floor(Date.now() / 1000);

  await client.insert(schema.pulseBriefings).values({
    scope_type: 'user',
    scope_id: userId,
    period_start: periodStart,
    period_end: periodEnd,
    body,
    suggestion: parsed.suggestion ?? null,
    model,
    generated_at: now,
  });

  return body;
}

/**
 * Scheduled job: run every Sunday at or after 22:00 server time.
 * Generates briefings for all users active in the past 7 days.
 */
export interface WeeklyBriefingRunResult { users: number; succeeded: number; failed: number; rejected: number }

export async function runWeeklyBriefingJob(): Promise<WeeklyBriefingRunResult> {
  const client = await getTypedClient();
  const pc = schema.pulseClassifications;
  const model = await getUserBriefingModel();
  const now = Math.floor(Date.now() / 1000);
  const sevenDaysAgo = now - 7 * 24 * 3600;

  const activeUsers = await client
    .selectDistinct({ user_id: pc.user_id })
    .from(pc)
    .where(and(eq(pc.classifier_status, 'classified'), gte(pc.classified_at, sevenDaysAgo)));

  if (activeUsers.length === 0) {
    console.log('[WeeklyBriefing] No active users this week, nothing to brief.');
    return { users: 0, succeeded: 0, failed: 0, rejected: 0 };
  }

  console.log(`[WeeklyBriefing] Generating briefings for ${activeUsers.length} user(s) with ${model}`);

  let succeeded = 0;
  let failed = 0;
  let rejected = 0; // failed because the number check refused the reply twice

  for (const { user_id } of activeUsers) {
    try {
      await generateUserWeeklyBriefing(user_id, sevenDaysAgo, now, model);
      succeeded++;
    } catch (err) {
      console.error(`[WeeklyBriefing] Failed for user ${user_id}:`, err instanceof Error ? err.message : err);
      failed++;
      if (err instanceof GroundingRejectedError) rejected++;
    }
  }

  console.log(`[WeeklyBriefing] Done. succeeded=${succeeded} failed=${failed} (number check rejected ${rejected})`);
  return { users: activeUsers.length, succeeded, failed, rejected };
}
