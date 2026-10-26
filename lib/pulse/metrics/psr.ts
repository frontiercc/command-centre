// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres, following the blessed query pattern: getTypedClient() +
// schema.<table>, count/bigint→Number (Policy B) at every aggregate read.
import { and, eq, gte, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';

// ─── Per-team PSR ─────────────────────────────────────────────────────────────

/**
 * Compute PSR (Process Substitution Rate) for a team.
 *
 * PSR = confirmed capability_creation events / baseline_process_count
 *
 * Numerator:   count of pulse_events rows where event_type = 'capability_creation'
 *              AND status = 'confirmed' for users in the given team.
 * Denominator: pulse_baselines.baseline_process_count for the team.
 *
 * Returns null if:
 *   - No baseline row exists for the team.
 *   - baseline_process_count is null or 0 (avoids division by zero and
 *     "Pending baseline" state where denominator has not been set yet).
 */
export async function computeTeamPsr(teamId: string): Promise<number | null> {
  const db = await getTypedClient();
  const pb = schema.pulseBaselines;
  const pe = schema.pulseEvents;
  const u = schema.users;

  const baselineRows = await db
    .select({ baseline_process_count: pb.baseline_process_count })
    .from(pb)
    .where(eq(pb.team_id, teamId))
    .limit(1);
  const baseline = baselineRows[0];

  if (!baseline) return null;

  const denominator = baseline.baseline_process_count;
  if (!denominator || denominator === 0) return null;

  const resultRows = await db
    .select({ cnt: sql<number | string>`count(*)` })
    .from(pe)
    .innerJoin(u, eq(u.id, pe.user_id))
    .where(and(eq(pe.event_type, 'capability_creation'), eq(pe.status, 'confirmed'), eq(u.team_id, teamId)));

  return Number(resultRows[0]?.cnt ?? 0) / denominator;
}

/**
 * Suggest a baseline_process_count from observed data: the number of distinct
 * recurring task types classified in the last 30 days.
 *
 * Numerator: COUNT(DISTINCT pulse_classifications.task_type) where
 *            classifier_status = 'classified' AND cowork_messages.occurred_at
 *            is within the last 30 days.
 *
 * When `teamId` is given, restricted to that team's members (users.team_id = ?).
 * When omitted, counts across all users (org-wide).
 */
export async function suggestBaselineProcessCount(teamId?: string): Promise<number> {
  const db = await getTypedClient();
  const pc = schema.pulseClassifications;
  const cm = schema.coworkMessages;
  const u = schema.users;

  const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;

  if (teamId) {
    const rows = await db
      .select({ cnt: sql<number | string>`count(distinct ${pc.task_type})` })
      .from(pc)
      .innerJoin(cm, eq(cm.id, pc.cowork_message_id))
      .innerJoin(u, eq(u.id, pc.user_id))
      .where(and(eq(pc.classifier_status, 'classified'), gte(cm.occurred_at, thirtyDaysAgo), eq(u.team_id, teamId)));

    return Number(rows[0]?.cnt ?? 0);
  }

  const rows = await db
    .select({ cnt: sql<number | string>`count(distinct ${pc.task_type})` })
    .from(pc)
    .innerJoin(cm, eq(cm.id, pc.cowork_message_id))
    .where(and(eq(pc.classifier_status, 'classified'), gte(cm.occurred_at, thirtyDaysAgo)));

  return Number(rows[0]?.cnt ?? 0);
}

/**
 * Department-scoped equivalent of suggestBaselineProcessCount — same
 * distinct-task-type-over-30-days signal, but membership resolved via
 * admin_users.department (linked_cowork_user_id -> pulse_classifications.user_id),
 * matching computeDeptPsr's existing join pattern below.
 */
export async function suggestBaselineProcessCountForDept(department: string): Promise<number> {
  const db = await getTypedClient();
  const pc = schema.pulseClassifications;
  const cm = schema.coworkMessages;
  const au = schema.adminUsers;

  const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;

  const rows = await db
    .select({ cnt: sql<number | string>`count(distinct ${pc.task_type})` })
    .from(pc)
    .innerJoin(cm, eq(cm.id, pc.cowork_message_id))
    .innerJoin(au, eq(au.linked_cowork_user_id, pc.user_id))
    .where(and(eq(pc.classifier_status, 'classified'), gte(cm.occurred_at, thirtyDaysAgo), eq(au.department, department)));

  return Number(rows[0]?.cnt ?? 0);
}

export async function computeDeptPsr(department: string): Promise<number | null> {
  const db = await getTypedClient();
  const pb = schema.pulseBaselines;
  const pe = schema.pulseEvents;
  const au = schema.adminUsers;

  // Baseline is stored using department name as the team_id key
  const baselineRows = await db
    .select({ baseline_process_count: pb.baseline_process_count })
    .from(pb)
    .where(eq(pb.team_id, department))
    .limit(1);
  const baseline = baselineRows[0];

  if (!baseline) return null;

  const denominator = baseline.baseline_process_count;
  if (!denominator || denominator === 0) return null;

  const resultRows = await db
    .select({ cnt: sql<number | string>`count(*)` })
    .from(pe)
    .innerJoin(au, eq(au.linked_cowork_user_id, pe.user_id))
    .where(and(eq(pe.event_type, 'capability_creation'), eq(pe.status, 'confirmed'), eq(au.department, department)));

  return Number(resultRows[0]?.cnt ?? 0) / denominator;
}
