// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Indexes on cowork_messages (the largest, busiest table) that are built in the background rather
// than in a migration. A migration's CREATE INDEX blocks every write to the table while it builds,
// which on a large hub pauses telemetry ingest for tens of seconds at upgrade. CREATE INDEX
// CONCURRENTLY does not block writes, but cannot run inside the migrations' transaction, so the
// scheduler (one instance, lib/db/scheduler-lock.ts) runs it once per start. Every query these
// serve gives the same answer without them, only slower, so a hub that has not built them yet is
// correct. A build that fails leaves an invalid index behind, which is dropped and built again.
import { sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';

interface BackgroundIndex { name: string; definition: string }

export const BACKGROUND_INDEXES: readonly BackgroundIndex[] = [
  // A session's output file names (lib/pulse/cowork/work-sessions.ts, /api/pulse/me/tasks): few
  // messages carry one, so the index is small and the lookup no longer reads every message.
  {
    name: 'idx_cowork_messages_session_output',
    definition: 'ON cowork_messages (session_id) INCLUDE (output_name) WHERE output_name IS NOT NULL',
  },
  // A session's Claude in Office or Google product, same readers.
  {
    name: 'idx_cowork_messages_session_product',
    definition: 'ON cowork_messages (session_id) INCLUDE (product) WHERE product IS NOT NULL',
  },
];

type Exec = { execute: (q: unknown) => Promise<{ rows: Array<Record<string, unknown>> }> };

/** Builds any missing or invalid background index. Returns the names it built. */
export async function ensureBackgroundIndexes(): Promise<string[]> {
  const db = (await getTypedClient()) as unknown as Exec;
  const built: string[] = [];
  for (const ix of BACKGROUND_INDEXES) {
    const { rows } = await db.execute(sql`
      SELECT i.indisvalid AS valid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
       WHERE c.relname = ${ix.name} AND c.relnamespace = current_schema()::regnamespace`);
    if (rows.length && rows[0].valid) continue;
    if (rows.length) await db.execute(sql.raw(`DROP INDEX CONCURRENTLY IF EXISTS "${ix.name}"`));
    await db.execute(sql.raw(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "${ix.name}" ${ix.definition}`));
    built.push(ix.name);
  }
  return built;
}
