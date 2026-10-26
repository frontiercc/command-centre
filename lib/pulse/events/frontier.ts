// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres: getTypedClient() + schema.<table>. The
// check-then-insert sequence below (existence check via
// eventExists/frontierPushExists, then writeEvent's insert) runs inside
// withTx (lib/db/with-tx.ts). Without a transaction, sequential AWAITED
// statements leave yield points between the check and the write, letting two
// overlapping detectFrontierPushes runs (e.g. the hourly scheduler racing an
// admin-triggered POST /api/pulse/admin/aggregate) both pass the existence
// check before either writes, producing duplicate confirmed pulse_events rows.
// withTx makes the check + write one atomic Postgres transaction.
//
// frontierPushExists' LIKE search relies on SQL wildcard semantics (`_`
// matches any single char, so the underscore-separated task_type param
// happens to match the space-separated words in the stored title) rather
// than on case-folding — task_type/title are always lowercase ASCII here, so
// LIKE's case-sensitivity never bites; kept as a literal `like()`.
import { and, eq, inArray, like } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { withTx } from '@/lib/db/with-tx';
import { computeUserDds } from '@/lib/pulse/metrics/dds';

type TxClient = Awaited<ReturnType<typeof getTypedClient>>;

// ─── Types ────────────────────────────────────────────────────────────────────

interface ClassificationRow {
  id: number;
  user_id: string;
  tier: number;
  task_type: string;
  cowork_message_id: string;
  classified_at: number;
  frontier_push_candidate: number; // stored as 0/1 integer
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Check whether a pulse_events row already exists for this (user_id, event_type) pair.
 * Used to enforce "first ever" semantics for tier_3_first and depth_threshold_crossed.
 *
 * Takes the open transaction handle — callers MUST run this inside the same
 * withTx as the corresponding writeEvent so the check + write is atomic.
 */
async function eventExists(tx: TxClient, userId: string, eventType: string): Promise<boolean> {
  const pe = schema.pulseEvents;
  const rows = await tx
    .select({ id: pe.id })
    .from(pe)
    .where(and(eq(pe.user_id, userId), eq(pe.event_type, eventType)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Check whether a pulse_events row exists for (user_id, event_type, task_type).
 * Used to enforce "first ever of this task_type" semantics for frontier_push.
 *
 * Takes the open transaction handle — callers MUST run this inside the same
 * withTx as the corresponding writeEvent so the check + write is atomic.
 */
async function frontierPushExists(tx: TxClient, userId: string, taskType: string): Promise<boolean> {
  const pe = schema.pulseEvents;
  const rows = await tx
    .select({ id: pe.id })
    .from(pe)
    .where(and(eq(pe.user_id, userId), eq(pe.event_type, 'frontier_push'), like(pe.title, `%${taskType}%`)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Write a single confirmed pulse_events row.
 *
 * Takes the open transaction handle — callers MUST run this inside the same
 * withTx as the preceding existence check so the check + write is atomic.
 */
async function writeEvent(
  tx: TxClient,
  params: {
    userId: string;
    eventType: 'tier_3_first' | 'frontier_push' | 'depth_threshold_crossed';
    title: string;
    body: string | null;
    coworkMessageId: string | null;
    tier: number | null;
    teamId: string | null;
    detectedAt: number;
  },
): Promise<void> {
  await tx.insert(schema.pulseEvents).values({
    user_id: params.userId,
    event_type: params.eventType,
    status: 'confirmed',
    title: params.title,
    body: params.body,
    cowork_message_id: params.coworkMessageId,
    tier: params.tier,
    team_id: params.teamId,
    detected_at: params.detectedAt,
  });
}

/**
 * Look up a user's team_id from the users table.
 */
async function getUserTeamId(tx: TxClient, userId: string): Promise<string | null> {
  const u = schema.users;
  const rows = await tx.select({ team_id: u.team_id }).from(u).where(eq(u.id, userId)).limit(1);
  return rows[0]?.team_id ?? null;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Detect Frontier Push events for a set of recently written classification IDs.
 *
 * Called after a batch of classifications is persisted. For each classification
 * that has frontier_push_candidate = 1, three event types are checked:
 *
 *   tier_3_first            — user's first ever Tier 3 classification
 *   frontier_push           — user's first ever classification of this task_type
 *   depth_threshold_crossed — user's DDS crosses 2.0 for the first time
 *
 * All three are written with status = 'confirmed'. Duplicate checks are
 * enforced before writing to prevent repeat events.
 */
export async function detectFrontierPushes(classificationIds: number[]): Promise<void> {
  if (classificationIds.length === 0) return;

  const db = await getTypedClient();
  const pc = schema.pulseClassifications;

  const rows = (await db
    .select({
      id: pc.id,
      user_id: pc.user_id,
      tier: pc.tier,
      task_type: pc.task_type,
      cowork_message_id: pc.cowork_message_id,
      classified_at: pc.classified_at,
      frontier_push_candidate: pc.frontier_push_candidate,
    })
    .from(pc)
    .where(and(inArray(pc.id, classificationIds), eq(pc.frontier_push_candidate, 1), eq(pc.classifier_status, 'classified')))) as ClassificationRow[];

  if (rows.length === 0) return; // no candidates — avoid opening an empty transaction

  const now = Math.floor(Date.now() / 1000);

  // The whole check-then-insert body runs inside a single transaction so the
  // existence check and the write it gates can never be split across two
  // overlapping invocations (see the header comment for the race this closes).
  await withTx(db, async (tx) => {
    for (const row of rows) {
      const teamId = await getUserTeamId(tx, row.user_id);

      // Format task_type slug into readable label: multi_file_operation → multi file operation
      const taskLabel = row.task_type.replace(/_/g, ' ');
      const article = /^[aeiou]/i.test(taskLabel) ? 'an' : 'a';

      // ── tier_3_first ──────────────────────────────────────────────────────────
      if (row.tier === 3 && !(await eventExists(tx, row.user_id, 'tier_3_first'))) {
        await writeEvent(tx, {
          userId: row.user_id,
          eventType: 'tier_3_first',
          title: 'First Tier 3 task',
          body: 'Your first frontier-level delegation: autonomous work that pushes beyond what you\'ve delegated before.',
          coworkMessageId: row.cowork_message_id,
          tier: 3,
          teamId,
          detectedAt: row.classified_at ?? now,
        });
      }

      // ── frontier_push (first ever of this task_type) ──────────────────────────
      if (!(await frontierPushExists(tx, row.user_id, row.task_type))) {
        await writeEvent(tx, {
          userId: row.user_id,
          eventType: 'frontier_push',
          title: `First ${taskLabel} task`,
          body: `You ran ${article} ${taskLabel} for the first time, a new type of work entering your delegation range.`,
          coworkMessageId: row.cowork_message_id,
          tier: row.tier,
          teamId,
          detectedAt: row.classified_at ?? now,
        });
      }

      // ── depth_threshold_crossed (DDS crosses 2.0 for the first time) ──────────
      if (!(await eventExists(tx, row.user_id, 'depth_threshold_crossed'))) {
        const dds = await computeUserDds(row.user_id);
        if (dds !== null && dds >= 2.0) {
          await writeEvent(tx, {
            userId: row.user_id,
            eventType: 'depth_threshold_crossed',
            title: 'Delegation depth milestone',
            body: `Your delegation depth score reached ${dds.toFixed(2)}, past the 2.0 threshold for the first time.`,
            coworkMessageId: null,
            tier: null,
            teamId,
            detectedAt: now,
          });
        }
      }
    }
  });
}
