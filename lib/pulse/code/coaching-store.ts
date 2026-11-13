// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Team coaching's record of actions a team lead marked done (coaching_actions): one row per team
 * and action, with the figure the action is meant to move as it stood that day, for the team and
 * for the organisation, and the lead's note. Undoing deletes the row; otherwise it is permanent,
 * like coaching_acks, so the same conversation never comes back.
 */
import { and, eq } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import type { DoneRecord } from '@/lib/pulse/code/team-coaching';

export async function listDoneActions(department: string): Promise<DoneRecord[]> {
  const client = await getTypedClient();
  const t = schema.coachingActions;
  const rows = await client.select().from(t).where(eq(t.department, department));
  return rows.map(r => ({
    actionKey: r.action_key,
    actionText: r.action_text,
    metric: r.metric,
    baseline: r.baseline === null ? null : Number(r.baseline),
    orgBaseline: r.org_baseline === null ? null : Number(r.org_baseline),
    note: r.note,
    doneBy: r.done_by,
    doneAt: Number(r.done_at),
  }));
}

export async function markActionDone(a: {
  department: string;
  actionKey: string;
  actionText: string;
  metric: string | null;
  baseline: number | null;
  orgBaseline: number | null;
  note: string | null;
  doneBy: string;
  doneAt: number;
}): Promise<void> {
  const client = await getTypedClient();
  const t = schema.coachingActions;
  await client.insert(t).values({
    department: a.department,
    action_key: a.actionKey,
    action_text: a.actionText,
    metric: a.metric,
    baseline: a.baseline,
    org_baseline: a.orgBaseline,
    note: a.note,
    done_by: a.doneBy,
    done_at: a.doneAt,
  }).onConflictDoNothing();
}

/** Undo: the row goes, so the plan suggests the action again. */
export async function undoActionDone(department: string, actionKey: string): Promise<void> {
  const client = await getTypedClient();
  const t = schema.coachingActions;
  await client.delete(t).where(and(eq(t.department, department), eq(t.action_key, actionKey)));
}
