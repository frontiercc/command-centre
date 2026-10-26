// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres, following the blessed query pattern: getTypedClient() +
// schema.<table>, count/bigint→Number (Policy B) at every aggregate read.
import { and, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';

// ─── Component computations ───────────────────────────────────────────────────

/**
 * T2+_breadth — fraction of active team members with ≥1 T2+ task in last 30d.
 * Returns null if no active participants.
 */
async function computeT2Breadth(
  teamMemberIds: string[],
  windowStart: number,
): Promise<{ breadth: number | null; totalParticipants: number }> {
  if (teamMemberIds.length === 0) return { breadth: null, totalParticipants: 0 };

  const db = await getTypedClient();
  const pc = schema.pulseClassifications;
  const cm = schema.coworkMessages;

  // Active participants: any classified work in window (by when work happened)
  const activeRows = await db
    .selectDistinct({ user_id: pc.user_id })
    .from(pc)
    .innerJoin(cm, eq(cm.id, pc.cowork_message_id))
    .where(and(inArray(pc.user_id, teamMemberIds), eq(pc.classifier_status, 'classified'), gte(cm.occurred_at, windowStart)));

  const totalParticipants = activeRows.length;
  if (totalParticipants < 2) return { breadth: null, totalParticipants };

  const activeIds = activeRows.map((r) => r.user_id);

  const tier2PlusRows = await db
    .selectDistinct({ user_id: pc.user_id })
    .from(pc)
    .innerJoin(cm, eq(cm.id, pc.cowork_message_id))
    .where(
      and(
        inArray(pc.user_id, activeIds),
        eq(pc.classifier_status, 'classified'),
        gte(cm.occurred_at, windowStart),
        gte(pc.tier, 2),
      ),
    );

  return {
    breadth: tier2PlusRows.length / totalParticipants,
    totalParticipants,
  };
}

/**
 * connector_overlap_at_tier — for each (mcp_server, tier≥2) combination used
 * by the team in the last 30d, what % of active members share it?
 * Average across all such combinations.
 * Returns null if no connectors used at T2+.
 */
async function computeConnectorOverlap(
  activeIds: string[],
  windowStart: number,
): Promise<number | null> {
  if (activeIds.length < 2) return null;

  const db = await getTypedClient();
  const cmi = schema.coworkMcpInvocations;
  const cm = schema.coworkMessages;
  const pc = schema.pulseClassifications;

  // Find all (mcp_server, user_id) pairs at tier≥2 for active members in window.
  // Join cowork_mcp_invocations → cowork_messages (via session_id) → pulse_classifications.
  const connectorRows = await db
    .selectDistinct({ mcp_server: cmi.mcp_server, user_id: cmi.user_id })
    .from(cmi)
    .innerJoin(cm, eq(cm.session_id, cmi.session_id))
    .innerJoin(pc, eq(pc.cowork_message_id, cm.id))
    .where(
      and(
        inArray(cmi.user_id, activeIds),
        gte(cmi.occurred_at, windowStart),
        gte(pc.tier, 2),
        eq(pc.classifier_status, 'classified'),
      ),
    );

  if (connectorRows.length === 0) return null;

  // Group by mcp_server → set of users
  const serverUsers = new Map<string, Set<string>>();
  for (const row of connectorRows) {
    if (!serverUsers.has(row.mcp_server)) serverUsers.set(row.mcp_server, new Set());
    serverUsers.get(row.mcp_server)!.add(row.user_id);
  }

  // Average overlap fraction across all servers
  let overlapSum = 0;
  for (const users of serverUsers.values()) {
    overlapSum += users.size / activeIds.length;
  }

  return overlapSum / serverUsers.size;
}

/**
 * skill_propagation — skills used by 2+ active team members / total distinct
 * skills used by team in last 30d.
 * Returns null if no skills used.
 */
async function computeSkillPropagation(
  activeIds: string[],
  windowStart: number,
): Promise<number | null> {
  if (activeIds.length < 2) return null;

  const db = await getTypedClient();
  const csi = schema.coworkSkillInvocations;

  const skillRows = await db
    .select({
      skill_name: csi.skill_name,
      user_count: sql<number | string>`count(distinct ${csi.user_id})`,
    })
    .from(csi)
    .where(and(inArray(csi.user_id, activeIds), gte(csi.occurred_at, windowStart)))
    .groupBy(csi.skill_name);

  if (skillRows.length === 0) return null;

  const totalSkills = skillRows.length;
  const sharedSkills = skillRows.filter((r) => Number(r.user_count) >= 2).length;

  return sharedSkills / totalSkills;
}

// ─── Weighted composition ─────────────────────────────────────────────────────

/**
 * Compose available components with proportional reweighting when some are null.
 *
 * Base weights: T2+_breadth=0.3, connector_overlap=0.4, skill_propagation=0.3
 * If a component is null, its weight is redistributed proportionally to the others.
 */
function composeOrs(
  breadth: number | null,
  connectorOverlap: number | null,
  skillPropagation: number | null,
): number | null {
  if (breadth === null) return null; // No activity at all

  const components: Array<{ value: number; weight: number }> = [
    { value: breadth, weight: 0.3 },
  ];
  if (connectorOverlap !== null) components.push({ value: connectorOverlap, weight: 0.4 });
  if (skillPropagation !== null) components.push({ value: skillPropagation, weight: 0.3 });

  const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
  const score = components.reduce((sum, c) => sum + (c.value * c.weight) / totalWeight, 0);

  return score;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface OrsDetail {
  ors: number;
  breadth: number | null;
  overlap: number | null;
  propagation: number | null;
}

/**
 * Shared tail for computeTeamOrsDetail/computeDeptOrsDetail: breadth → activeIds
 * → overlap → propagation → compose.
 *
 * ORS = (T2+_breadth × 0.3) + (connector_overlap_at_tier × 0.4) + (skill_propagation × 0.3)
 *
 * All components are fully automated from captured session data.
 * Null components are reweighted proportionally across available signals.
 * Returns null if fewer than 2 active participants in the past 30 days.
 */
async function computeOrsForMembers(memberIds: string[]): Promise<OrsDetail | null> {
  if (memberIds.length === 0) return null;

  const db = await getTypedClient();
  const pc = schema.pulseClassifications;
  const cm = schema.coworkMessages;

  const THIRTY_DAYS = 30 * 24 * 60 * 60;
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - THIRTY_DAYS;

  const { breadth, totalParticipants } = await computeT2Breadth(memberIds, windowStart);
  if (totalParticipants < 2) return null;

  // Active member IDs (those with any classified work in window by occurred_at)
  const activeRows = await db
    .selectDistinct({ user_id: pc.user_id })
    .from(pc)
    .innerJoin(cm, eq(cm.id, pc.cowork_message_id))
    .where(and(inArray(pc.user_id, memberIds), eq(pc.classifier_status, 'classified'), gte(cm.occurred_at, windowStart)));

  const activeIds = activeRows.map((r) => r.user_id);

  const connectorOverlap = await computeConnectorOverlap(activeIds, windowStart);
  const skillPropagation = await computeSkillPropagation(activeIds, windowStart);

  const ors = composeOrs(breadth, connectorOverlap, skillPropagation);
  if (ors === null) return null;

  return {
    ors,
    breadth,
    overlap: connectorOverlap,
    propagation: skillPropagation,
  };
}

/**
 * Compute ORS (Operational Resilience Score) + its components for a team.
 * Returns null if fewer than 2 active participants in the past 30 days.
 */
export async function computeTeamOrsDetail(teamId: string): Promise<OrsDetail | null> {
  const db = await getTypedClient();
  const u = schema.users;

  const memberRows = await db.select({ id: u.id }).from(u).where(eq(u.team_id, teamId));

  return computeOrsForMembers(memberRows.map((r) => r.id));
}

/**
 * Compute ORS (Operational Resilience Score) + its components for a department.
 * Returns null if fewer than 2 active participants in the past 30 days.
 */
export async function computeDeptOrsDetail(department: string): Promise<OrsDetail | null> {
  const db = await getTypedClient();
  const au = schema.adminUsers;

  const memberRows = (await db
    .select({ id: au.linked_cowork_user_id })
    .from(au)
    .where(and(eq(au.department, department), isNotNull(au.linked_cowork_user_id)))) as Array<{ id: string }>;

  return computeOrsForMembers(memberRows.map((r) => r.id));
}

/** @deprecated Use computeTeamOrsDetail for component breakdown. */
export async function computeTeamOrs(teamId: string): Promise<number | null> {
  const detail = await computeTeamOrsDetail(teamId);
  return detail?.ors ?? null;
}
