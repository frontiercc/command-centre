// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// logAccess() writes through getAuditClient() (lib/db/client.ts), which
// installs the append-only triggers on a fresh Postgres audit pool, so every
// logAccess() write goes through that immutable path.
//
// Async + never-rejects: the write is awaited INSIDE the try/catch so a failed
// (or rejected) audit write is swallowed — audit failure must never break or
// reject into the API response. Callers await it to keep the write-before-
// response durability the old sync version guaranteed.
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { getAuditClient } from '@/lib/db/client';
import { auditSchema, auditPgSchema } from '@/lib/db/schema-audit';

export interface AccessLogEntry {
  actorId: string;
  actorEmail: string;
  actorIp?: string;
  resource: string;
  action: 'READ' | 'WRITE' | 'DELETE' | 'EXPORT' | 'SSO_LOGIN';
  outcome: 'success' | 'denied' | 'error' | 'failure';
  detail?: string;
}

export async function logAccess(entry: AccessLogEntry): Promise<void> {
  try {
    // Typed as the async Postgres builder over the audit schema (same trick
    // as getTypedClient()).
    const db = (await getAuditClient()) as unknown as NodePgDatabase<typeof auditPgSchema>;
    // Exact column mapping preserved from the old prepared INSERT (actor_ip ??
    // null, detail ?? null). occurred_at is deliberately NOT set — the column
    // has a DB default (extract(epoch from now())), matching the old behaviour.
    await db.insert(auditSchema.accessAuditLog).values({
      actor_id: entry.actorId,
      actor_email: entry.actorEmail,
      actor_ip: entry.actorIp ?? null,
      resource: entry.resource,
      action: entry.action,
      outcome: entry.outcome,
      detail: entry.detail ?? null,
    });
  } catch {
    // Audit failure must never break (or reject into) the API response.
  }
}
