// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. Follows the
// standard pattern: getTypedClient() + schema.<table> +
// query-builder inArray/groupBy/orderBy — no raw SQL needed (no GROUP BY
// date-bucket, no jsonb, no tuple-IN-subquery here). Every raw-SQL COUNT
// aggregate is Number()-coerced (bigint/numeric come back as
// STRINGS on Postgres).
import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth/admin-auth';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ teamId: string }> }
) {
  const session = await requireAdmin(request);
  if (!session) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { teamId } = await params;
  const client = await getTypedClient();
  const now = Math.floor(Date.now() / 1000);
  const sixWeeksAgo = now - 42 * 24 * 3600;

  const u = schema.users;
  const pm = schema.pulseMetrics;
  const pc = schema.pulseClassifications;
  const cm = schema.coworkMessages;
  const pe = schema.pulseEvents;
  const ps = schema.pulseSkills;

  // Team members
  const members = await client
    .select({ id: u.id, display_name: u.display_name, email: u.email })
    .from(u)
    .where(eq(u.team_id, teamId));

  const memberIds = members.map(m => m.id);

  if (memberIds.length === 0) {
    return NextResponse.json({
      teamId,
      members: [],
      metrics: null,
      journeyHeatmap: [],
      concentrationRisk: [],
      frontierFeed: [],
      skills: [],
    });
  }

  // Latest team metrics
  const metricsRows = await client
    .select({
      oti: pm.oti, dds: pm.dds, psr: pm.psr, ors: pm.ors,
      event_count: pm.event_count,
      tier_1_count: pm.tier_1_count, tier_2_count: pm.tier_2_count, tier_3_count: pm.tier_3_count,
      computed_at: pm.computed_at,
    })
    .from(pm)
    .where(and(eq(pm.scope_type, 'team'), eq(pm.scope_id, teamId), eq(pm.granularity, 'rolling')))
    .orderBy(desc(pm.computed_at))
    .limit(1);
  const metrics = metricsRows[0];

  // 6-week journey heatmap (aggregated across all team members)
  // Use cowork_messages.occurred_at (when the work happened) not classified_at
  const classifications = await client
    .select({ tier: pc.tier, occurred_at: cm.occurred_at })
    .from(pc)
    .innerJoin(cm, eq(cm.id, pc.cowork_message_id))
    .where(and(inArray(pc.user_id, memberIds), eq(pc.classifier_status, 'classified'), gte(cm.occurred_at, sixWeeksAgo)))
    .orderBy(cm.occurred_at);

  const heatmapMap = new Map<string, number>();
  for (const row of classifications) {
    const weekIndex = Math.min(5, Math.floor((now - row.occurred_at) / (7 * 24 * 3600)));
    const displayWeek = weekIndex; // Wk 1 = most recent, Wk 6 = oldest
    const key = `${displayWeek}-${row.tier}`;
    heatmapMap.set(key, (heatmapMap.get(key) ?? 0) + 1);
  }
  const journeyHeatmap = Array.from(heatmapMap.entries()).map(([key, count]) => {
    const [week, tier] = key.split('-').map(Number);
    return { week, tier, count };
  });

  // Concentration risk: Tier 3 task types run by only one member
  const tier3ByType = await client
    .select({ user_id: pc.user_id, task_type: pc.task_type, cnt: sql<number | string>`COUNT(*)` })
    .from(pc)
    .where(and(inArray(pc.user_id, memberIds), eq(pc.tier, 3), eq(pc.classifier_status, 'classified'), gte(pc.classified_at, sixWeeksAgo)))
    .groupBy(pc.user_id, pc.task_type);

  // Build per-task_type → set of user_ids
  const typeUsersMap = new Map<string, Set<string>>();
  for (const row of tier3ByType) {
    const set = typeUsersMap.get(row.task_type) ?? new Set();
    set.add(row.user_id);
    typeUsersMap.set(row.task_type, set);
  }

  // Flag users who are sole runner of 3+ Tier 3 task types
  const concentrationRisk: Array<{
    user_id: string; display_name: string | null; sole_workflows: number;
  }> = [];

  const soleWorkflowCounts = new Map<string, number>();
  for (const [, users] of typeUsersMap) {
    if (users.size === 1) {
      const uid = [...users][0];
      soleWorkflowCounts.set(uid, (soleWorkflowCounts.get(uid) ?? 0) + 1);
    }
  }
  for (const [uid, count] of soleWorkflowCounts) {
    if (count >= 3) {
      const member = members.find(m => m.id === uid);
      concentrationRisk.push({
        user_id: uid,
        display_name: member?.display_name ?? member?.email ?? uid,
        sole_workflows: count,
      });
    }
  }

  // Frontier feed — last 20 events across team
  const frontierFeed = await client
    .select({
      event_type: pe.event_type, title: pe.title, body: pe.body,
      tier: pe.tier, detected_at: pe.detected_at, user_id: pe.user_id,
      display_name: u.display_name, email: u.email,
    })
    .from(pe)
    .innerJoin(u, eq(u.id, pe.user_id))
    .where(and(
      inArray(pe.user_id, memberIds),
      inArray(pe.event_type, ['frontier_push', 'tier_3_first', 'depth_threshold_crossed']),
      eq(pe.status, 'confirmed'),
    ))
    .orderBy(desc(pe.detected_at))
    .limit(20);

  // Team skills
  const skills = await client
    .select({
      skill_name: ps.skill_name, description: ps.description,
      author_user_id: ps.author_user_id, run_count: ps.run_count, last_seen_at: ps.last_seen_at,
    })
    .from(ps)
    .where(eq(ps.team_id, teamId))
    .orderBy(desc(ps.run_count))
    .limit(20);

  return NextResponse.json({
    teamId,
    members,
    metrics: metrics ?? null,
    journeyHeatmap,
    concentrationRisk,
    frontierFeed,
    skills,
  });
}
