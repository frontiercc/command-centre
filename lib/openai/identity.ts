// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * OpenAI account identity. The OpenAI sync finds people by email (lib/openai/
 * sync.ts → resolveOtelUser); each export record also names the OpenAI
 * account behind it (actor.user_id). This keeps which person each account
 * first resolved to (openai_identity_users, migration 0048). When the same
 * account later arrives under a second, different email that resolves to
 * someone else, the clash is recorded in otel_identity_conflicts with
 * product 'openai', on the same Identity conflicts card and with the same
 * Merge / Keep separate / Undo as a Claude installation shared by two
 * accounts. A merge writes the email alias the resolver already honours, so
 * later records for that email go to the existing person. A clash never
 * fails the sync.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { recordIdentityConflict, type IdentityConflictInput } from '@/lib/otel/resolve-user';

type Client = Awaited<ReturnType<typeof getTypedClient>>;

/** The OpenAI account id on an export record, when the record's actor is the person being resolved. */
export function openAiAccountOf(raw: unknown, email: string): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const actor = (raw as { actor?: { user_id?: unknown; user_email?: unknown } }).actor;
  const id = typeof actor?.user_id === 'string' ? actor.user_id.trim() : '';
  if (!id || id.length > 200) return null;
  const actorEmail = typeof actor?.user_email === 'string' ? actor.user_email.trim().toLowerCase() : '';
  return actorEmail === email.trim().toLowerCase() ? id : null;
}

export interface NoteAccountInput {
  openaiUserId: string;
  email: string;
  /** The person the email resolved to. */
  userId: string;
  surface: 'cowork' | 'code';
  nowS: number;
}

/** A conflict this record created, whose alert the caller raises once its transaction has committed. */
export interface NewConflict { input: IdentityConflictInput; conflictId: string }

/**
 * Records the account against the person it resolved to the first time it is
 * seen; afterwards, a different person for the same account is an identity
 * conflict. Returns 'conflict' when this record clashes, with the new
 * conflict when this record created it.
 */
export async function noteOpenAiAccount(client: Client, input: NoteAccountInput): Promise<{ outcome: 'ok' | 'conflict'; created: NewConflict | null }> {
  const t = schema.openaiIdentityUsers;
  const read = () => client.select({ user_id: t.user_id }).from(t).where(eq(t.openai_user_id, input.openaiUserId)).limit(1);
  let rows = await read();
  if (!rows[0]) {
    await client.insert(t).values({
      openai_user_id: input.openaiUserId, user_id: input.userId, first_seen_at: input.nowS, last_seen_at: input.nowS,
    }).onConflictDoNothing();
    // Re-select: a concurrent sync may have recorded this account first.
    rows = await read();
  }
  const mapped = rows[0]?.user_id;
  if (!mapped || mapped === input.userId) {
    if (mapped) {
      await client.update(t)
        .set({ last_seen_at: sql`GREATEST(${t.last_seen_at}, ${input.nowS})` })
        .where(eq(t.openai_user_id, input.openaiUserId));
    }
    return { outcome: 'ok', created: null };
  }

  const lowerEmail = input.email.trim().toLowerCase();
  const conflict: IdentityConflictInput = {
    installationId: input.openaiUserId,
    existingUserId: mapped,
    newEmail: lowerEmail,
    newUserId: input.userId,
    surface: input.surface === 'code' ? 'codex' : 'chatgpt',
    product: 'openai',
    nowS: input.nowS,
    eventCount: 1,
  };
  const conflictId = await recordIdentityConflict(client, conflict, { alert: false });
  if (!conflictId) {
    // Keep an open conflict's "last seen / events" current while it waits for a decision.
    const c = schema.otelIdentityConflicts;
    await client.update(c)
      .set({ last_seen_at: sql`GREATEST(${c.last_seen_at}, ${input.nowS})`, event_count: sql`${c.event_count} + 1` })
      .where(and(
        eq(c.installation_id, input.openaiUserId),
        eq(c.new_email, lowerEmail),
        eq(c.status, 'open'),
        eq(c.product, 'openai'),
      ));
  }
  return { outcome: 'conflict', created: conflictId ? { input: conflict, conflictId } : null };
}
