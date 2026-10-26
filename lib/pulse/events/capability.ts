// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres: getTypedClient() + schema.<table>. The
// check-then-insert sequence below (capabilityEventExists, then the insert)
// runs inside withTx (lib/db/with-tx.ts) — see frontier.ts's header comment.
// Without a transaction, sequential AWAITED statements leave yield points
// between the check and the write, letting two overlapping
// detectCapabilityCreation runs (e.g. the hourly scheduler racing an
// admin-triggered POST /api/pulse/admin/aggregate) both pass the existence
// check before either writes, producing duplicate capability_creation
// candidates for the same cowork_message_id. withTx makes the check + write
// one Postgres transaction.
import { and, eq, inArray } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { withTx } from '@/lib/db/with-tx';

type TxClient = Awaited<ReturnType<typeof getTypedClient>>;

// ─── Types ────────────────────────────────────────────────────────────────────

interface ClassificationRow {
  id: number;
  user_id: string;
  tier: number;
  task_type: string;
  cowork_message_id: string;
  classified_at: number;
  capability_creation_candidate: number; // stored as 0/1 integer
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Convert a raw task_type slug into a human-readable label.
 * e.g. "engineering:architecture" → "Engineering · Architecture"
 *      "capability_creation"      → "Capability Creation"
 *      "document_drafting"        → "Document Drafting"
 */
export function formatTaskType(slug: string): string {
  return slug
    .replace(/:/g, ' · ')
    .replace(/_/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Check whether a candidate or confirmed pulse_events row already exists for
 * this cowork_message_id. Used to prevent duplicate capability creation records.
 *
 * Takes the open transaction handle — callers MUST run this inside the same
 * withTx as the corresponding insert so the check + write is atomic.
 */
async function capabilityEventExists(tx: TxClient, coworkMessageId: string): Promise<boolean> {
  const pe = schema.pulseEvents;
  const rows = await tx
    .select({ id: pe.id })
    .from(pe)
    .where(
      and(
        eq(pe.event_type, 'capability_creation'),
        eq(pe.cowork_message_id, coworkMessageId),
        inArray(pe.status, ['candidate', 'confirmed']),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Look up a user's team_id from the users table.
 */
async function getUserTeamId(tx: TxClient, userId: string): Promise<string | null> {
  const u = schema.users;
  const rows = await tx.select({ team_id: u.team_id }).from(u).where(eq(u.id, userId)).limit(1);
  return rows[0]?.team_id ?? null;
}

/**
 * Fetch the content_preview snippet for a cowork message, used to give
 * reviewers context on what triggered a capability-creation candidate.
 */
async function getMessagePreview(tx: TxClient, coworkMessageId: string): Promise<string | null> {
  const cm = schema.coworkMessages;
  const rows = await tx
    .select({ content_preview: cm.content_preview })
    .from(cm)
    .where(eq(cm.id, coworkMessageId))
    .limit(1);
  return rows[0]?.content_preview ?? null;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Detect Capability Creation candidates for a set of recently written
 * classification IDs.
 *
 * For each classification with capability_creation_candidate = 1:
 *   - Write a pulse_events row with event_type = 'capability_creation'
 *     and status = 'candidate'.
 *   - Only if no existing 'candidate' or 'confirmed' row exists for
 *     this cowork_message_id.
 *
 * The candidate row awaits admin confirmation to become 'confirmed'.
 */
export async function detectCapabilityCreation(classificationIds: number[]): Promise<void> {
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
      capability_creation_candidate: pc.capability_creation_candidate,
    })
    .from(pc)
    .where(
      and(
        inArray(pc.id, classificationIds),
        eq(pc.capability_creation_candidate, 1),
        eq(pc.classifier_status, 'classified'),
      ),
    )) as ClassificationRow[];

  if (rows.length === 0) return; // no candidates — avoid opening an empty transaction

  const now = Math.floor(Date.now() / 1000);

  // The whole check-then-insert body runs inside a single transaction so the
  // existence check and the insert it gates can never be split across two
  // overlapping invocations (see the header comment for the race this closes).
  await withTx(db, async (tx) => {
    for (const row of rows) {
      // Skip if we already have a record for this message
      if (await capabilityEventExists(tx, row.cowork_message_id)) continue;

      const teamId = await getUserTeamId(tx, row.user_id);
      const readableType = formatTaskType(row.task_type);

      // Pull the actual prompt snippet so reviewers know what triggered this
      const preview = await getMessagePreview(tx, row.cowork_message_id);
      const snippet = preview?.slice(0, 300) ?? null;

      const body = snippet
        ? `Tier ${row.tier} session flagged as a potential new capability. Prompt: "${snippet}"`
        : `Tier ${row.tier} ${readableType} session flagged as a potential new capability. Awaiting admin review.`;

      await tx.insert(schema.pulseEvents).values({
        user_id: row.user_id,
        event_type: 'capability_creation',
        status: 'candidate',
        title: `New capability — ${readableType}`,
        body,
        cowork_message_id: row.cowork_message_id,
        tier: row.tier,
        team_id: teamId,
        detected_at: row.classified_at ?? now,
      });
    }
  });
}
