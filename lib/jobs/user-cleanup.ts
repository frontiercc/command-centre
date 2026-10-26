// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. App-clock timestamps; affected-row
// counts via a local rowcount helper (matches lib/db/queries.ts's local
// `rowsAffected`).
import { and, eq, isNotNull, isNull, lt, or } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getConfigValue } from '@/lib/config';

export interface UserCleanupResult {
  deactivated: number;
}

function rowsAffected(result: unknown): number {
  return Number((result as { rowCount?: number | null }).rowCount ?? 0);
}

/**
 * Soft-deactivate OTel-enrolled users who have been inactive beyond the
 * configured threshold (default 30 days). Runs daily via scheduler.
 *
 * A never-seen user (last_seen_at IS NULL — e.g. bulk-prepopulated via
 * app/api/admin/otel-prepopulate/route.ts ahead of them ever sending
 * telemetry) gets the same grace period as anyone else, measured from
 * first_seen_at (when the row was created/enrolled), not deactivated on the
 * very next run regardless of how recently they were added.
 */
export async function runUserCleanup(): Promise<UserCleanupResult> {
  const staleDays = parseInt((await getConfigValue('otelUserStaleDays')) || '30', 10);
  const cutoff = Math.floor(Date.now() / 1000) - staleDays * 86400;
  const nowS = Math.floor(Date.now() / 1000); // app clock

  const db = await getTypedClient();
  const t = schema.users;
  const result = await db
    .update(t)
    .set({ deactivated_at: nowS, deactivation_reason: 'stale_otel_auto' })
    .where(and(
      eq(t.source, 'otel'),
      isNull(t.deactivated_at),
      or(
        and(isNotNull(t.last_seen_at), lt(t.last_seen_at, cutoff)),
        and(isNull(t.last_seen_at), isNotNull(t.first_seen_at), lt(t.first_seen_at, cutoff)),
      ),
    ));

  const count = rowsAffected(result);
  if (count > 0) {
    console.log(`[UserCleanup] Soft-deactivated ${count} stale OTel user(s) (inactive >${staleDays}d)`);
  }
  return { deactivated: count };
}
