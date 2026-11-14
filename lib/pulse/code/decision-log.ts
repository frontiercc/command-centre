// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * So what's record of decisions (decision_log): what the page recommended, what the leader chose,
 * and every figure that was on the card that day. The figures are stored rather than read back
 * later, so the follow-up compares what was true then with what is true now, and nothing can move
 * underneath it. Undoing deletes the row; otherwise it is permanent, like coaching_actions.
 */
import { and, eq } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';

/** How long before a decision comes back to say what happened. */
export const LOOK_AGAIN_DAYS = 30;

export interface DecisionRecord {
  card: string;
  department: string;
  recommended: string;
  chosen: string;
  headline: string;
  figures: Record<string, unknown>;
  note: string | null;
  decidedBy: string;
  decidedAt: number;
  lookAgainAt: number;
}

export async function listDecisions(): Promise<DecisionRecord[]> {
  const client = await getTypedClient();
  const t = schema.decisionLog;
  const rows = await client.select().from(t);
  return rows.map(r => ({
    card: r.card,
    department: r.department,
    recommended: r.recommended,
    chosen: r.chosen,
    headline: r.headline,
    figures: parseFigures(r.figures_json),
    note: r.note,
    decidedBy: r.decided_by,
    decidedAt: Number(r.decided_at),
    lookAgainAt: Number(r.look_again_at),
  }));
}

/** A stored figure set that cannot be read is treated as none, never as zeroes. */
function parseFigures(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export async function recordDecision(d: Omit<DecisionRecord, 'lookAgainAt'> & { lookAgainAt?: number }): Promise<void> {
  const client = await getTypedClient();
  const t = schema.decisionLog;
  await client.insert(t).values({
    card: d.card,
    department: d.department,
    recommended: d.recommended,
    chosen: d.chosen,
    headline: d.headline,
    figures_json: JSON.stringify(d.figures),
    note: d.note,
    decided_by: d.decidedBy,
    decided_at: d.decidedAt,
    look_again_at: d.lookAgainAt ?? d.decidedAt + LOOK_AGAIN_DAYS * 86400,
  }).onConflictDoNothing();
}

/** Undo: the row goes, so the card asks again. */
export async function undoDecision(card: string, department: string): Promise<void> {
  const client = await getTypedClient();
  const t = schema.decisionLog;
  await client.delete(t).where(and(eq(t.card, card), eq(t.department, department)));
}
