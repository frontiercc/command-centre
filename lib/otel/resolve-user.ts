// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Resolve an OTel event's person to a `users` row.
 *
 * Claude's OTel `user.id` identifies an INSTALLATION, not a person: Anthropic's
 * monitoring docs describe it as a random id generated on first run and kept in
 * ~/.claude.json, "not derived from your Claude account". Both log receivers
 * used to create a new person with `id = user.id`, so a second Claude account on
 * the same machine (same user.id, different email) hit the primary key, the
 * error escaped to the ingest route and the whole batch was answered with 500 —
 * and the collector deletes a batch it gets a 500 for.
 *
 * The rules now:
 *   1. an admin merge (otel_identity_aliases) wins;
 *   2. otherwise the person is found by email, ignoring case;
 *   3. a new person takes the installation id only when nobody else holds it,
 *      otherwise a stable id derived from their email — so concurrent requests,
 *      retries and the metrics receiver all land on the same id;
 *   4. when the installation id was held by someone else, the clash is recorded
 *      in otel_identity_conflicts for an admin to Merge or Keep separate.
 * A clash never fails ingest.
 */
import { createHash } from 'crypto';
import { isPlainEmail } from '@/lib/email/address';
import { v4 as uuidv4 } from 'uuid';
import { and, eq, sql } from 'drizzle-orm';
import type { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { insertAlert } from '@/lib/db/queries';

type Client = Awaited<ReturnType<typeof getTypedClient>>;

export function derivedUserId(email: string): string {
  return createHash('sha256').update('otel:' + email.trim().toLowerCase()).digest('hex');
}

async function aliasUserId(client: Client, lowerEmail: string): Promise<string | null> {
  const rows = await client
    .select({ user_id: schema.otelIdentityAliases.user_id })
    .from(schema.otelIdentityAliases)
    .where(eq(schema.otelIdentityAliases.email, lowerEmail))
    .limit(1);
  return rows[0]?.user_id ?? null;
}

async function userIdByEmail(client: Client, lowerEmail: string): Promise<string | null> {
  const rows = await client
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(sql`lower(${schema.users.email}) = ${lowerEmail}`)
    .limit(1);
  return rows[0]?.id ?? null;
}

/** Who, if anyone other than this email, already holds `id` in users or admin_users. */
async function heldByOther(client: Client, id: string, lowerEmail: string): Promise<string | null> {
  const u = await client
    .select({ id: schema.users.id, email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, id))
    .limit(1);
  if (u[0] && String(u[0].email ?? '').toLowerCase() !== lowerEmail) return u[0].id;
  const a = await client
    .select({ id: schema.adminUsers.id, email: schema.adminUsers.email })
    .from(schema.adminUsers)
    .where(eq(schema.adminUsers.id, id))
    .limit(1);
  if (a[0] && String(a[0].email).toLowerCase() !== lowerEmail) return a[0].id;
  return null;
}

/**
 * Read-only resolution for the metrics receiver, which never creates users:
 * the same id the log receivers would choose, without writing anything.
 */
export async function lookupOtelUserId(client: Client, email: string, installationId: string | null): Promise<string> {
  const lowerEmail = email.trim().toLowerCase();
  const alias = await aliasUserId(client, lowerEmail);
  if (alias) return alias;
  const existing = await userIdByEmail(client, lowerEmail);
  if (existing) return existing;
  if (installationId && !(await heldByOther(client, installationId, lowerEmail))) return installationId;
  return derivedUserId(lowerEmail);
}

export interface ResolveInput {
  email: string;
  installationId: string | null;
  displayName: string;
  department: string | null;
  accountUuid?: string | null;
  surface: 'cowork' | 'code';
  nowS: number;
  /** Log records in this resource — counted on an open conflict. */
  eventCount: number;
}

export interface ResolveResult {
  userId: string;
  /** True when the users row already existed (or an alias pointed at one). */
  existing: boolean;
  created: boolean;
}

export async function resolveOtelUser(client: Client, input: ResolveInput): Promise<ResolveResult> {
  // Telemetry decides who a person is, so only a single plain address may
  // create or find an account; anything else skips the resource (the caller
  // records it) rather than reaching admin_users.
  if (!isPlainEmail(input.email)) throw new Error('OTel identity: user.email is not a single plain email address');
  const lowerEmail = input.email.trim().toLowerCase();

  const alias = await aliasUserId(client, lowerEmail);
  if (alias) return { userId: alias, existing: true, created: false };

  const existing = await userIdByEmail(client, lowerEmail);
  if (existing) {
    // Keep an open conflict's "last seen / events" current while it waits for a decision.
    if (input.installationId && input.installationId !== existing) {
      await client
        .update(schema.otelIdentityConflicts)
        .set({
          last_seen_at: input.nowS,
          event_count: sql`${schema.otelIdentityConflicts.event_count} + ${input.eventCount}`,
        })
        .where(and(
          eq(schema.otelIdentityConflicts.installation_id, input.installationId),
          eq(schema.otelIdentityConflicts.new_email, lowerEmail),
          eq(schema.otelIdentityConflicts.status, 'open'),
        ));
    }
    return { userId: existing, existing: true, created: false };
  }

  let newId: string;
  let clashWith: string | null = null;
  if (input.installationId) {
    clashWith = await heldByOther(client, input.installationId, lowerEmail);
    newId = clashWith ? derivedUserId(lowerEmail) : input.installationId;
  } else {
    newId = uuidv4();
  }

  await client.insert(schema.users).values({
    id: newId,
    email: input.email,
    display_name: input.displayName,
    source: 'otel',
    account_uuid: input.accountUuid ?? null,
    department: input.department,
    first_seen_at: input.nowS,
    last_seen_at: input.nowS,
  }).onConflictDoNothing();

  // Re-select: a concurrent request may have created this person first.
  const userId = await userIdByEmail(client, lowerEmail);
  if (!userId) throw new Error(`OTel identity: could not create or find a user for this email (id ${newId.slice(0, 12)})`);
  const created = userId === newId;

  const adminRows = await client
    .select({ id: schema.adminUsers.id })
    .from(schema.adminUsers)
    .where(eq(schema.adminUsers.email, lowerEmail))
    .limit(1);
  if (!adminRows[0]) {
    // password_hash sentinel — an admin must set a real password before the user can log in.
    await client.insert(schema.adminUsers).values({
      id: userId,
      email: lowerEmail,
      password_hash: '__otel_pending__',
      display_name: input.displayName,
      role: 'pulse',
      department: input.department ?? null,
      linked_cowork_user_id: userId,
      sso_enabled: 0,
    }).onConflictDoNothing();
  }

  if (clashWith && input.installationId && created) {
    await recordConflict(client, {
      installationId: input.installationId,
      existingUserId: clashWith,
      newEmail: lowerEmail,
      newUserId: userId,
      surface: input.surface,
      nowS: input.nowS,
      eventCount: input.eventCount,
    });
  }

  return { userId, existing: false, created };
}

async function recordConflict(client: Client, c: {
  installationId: string; existingUserId: string; newEmail: string; newUserId: string;
  surface: string; nowS: number; eventCount: number;
}): Promise<void> {
  const inserted = await client.insert(schema.otelIdentityConflicts).values({
    id: uuidv4(),
    installation_id: c.installationId,
    existing_user_id: c.existingUserId,
    new_email: c.newEmail,
    new_user_id: c.newUserId,
    surface: c.surface,
    first_seen_at: c.nowS,
    last_seen_at: c.nowS,
    event_count: c.eventCount,
    status: 'open',
  }).onConflictDoNothing().returning({ id: schema.otelIdentityConflicts.id });
  if (!inserted[0]) return;

  // Medium: visible on /alerts, not pushed through the high-priority Slack sweep.
  try {
    const holder = await client
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, c.existingUserId))
      .limit(1);
    await insertAlert({
      id: uuidv4(),
      user_id: c.newUserId,
      alert_type: 'identity_conflict',
      severity: 'medium',
      title: 'Two Claude accounts are sending from one machine',
      explanation: `${c.newEmail} is sending ${c.surface} telemetry from a Claude installation already used by ${holder[0]?.email ?? 'another user'}. It has been kept as a separate person. Review it on Admin → Ingestion → Identity conflicts to merge or keep separate.`,
      raw_evidence: JSON.stringify({ conflict_id: inserted[0].id, surface: c.surface }),
    });
  } catch (err) {
    console.error('[OTel identity] conflict alert failed:', err instanceof Error ? err.message : err);
  }
}
