// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Work Pulse's "Document sessions": sessions with at least one uploaded file,
// and how many files, over a window. Claude Cowork sessions are counted from
// cowork_session_stats.upload_count (the session aggregator's parse of
// cowork_sessions.files_uploaded); ChatGPT sessions get no stats row, so their
// cowork_sessions.files_uploaded list is counted the same way here. One rule
// for the Executive View and the department page.
import { and, eq, gt, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { OPENAI_SOURCES } from '@/lib/openai/sources';
import type { Vendor } from '@/lib/dashboard/vendor';

export interface DocSessions {
  sessions_with_uploads: number;
  total_uploads: number;
}

export async function getDocSessions(opts: {
  since: number;
  /** Narrow to these people (a department); every person when absent. */
  memberIds?: string[];
  vendor?: Vendor;
}): Promise<DocSessions> {
  const { since, memberIds, vendor = 'all' } = opts;
  const result: DocSessions = { sessions_with_uploads: 0, total_uploads: 0 };
  if (memberIds && memberIds.length === 0) return result;
  const client = await getTypedClient();
  const cs = schema.coworkSessions;
  const css = schema.coworkSessionStats;

  if (vendor !== 'openai') {
    const rows = await client
      .select({
        sessions: sql<number | string>`COUNT(*)`,
        files: sql<number | string>`COALESCE(SUM(${css.upload_count}), 0)`,
      })
      .from(css)
      .innerJoin(cs, eq(cs.id, css.session_id))
      .where(and(gt(css.upload_count, 0), gte(cs.started_at, since),
        memberIds ? inArray(cs.user_id, memberIds) : undefined));
    result.sessions_with_uploads += Number(rows[0]?.sessions ?? 0);
    result.total_uploads += Number(rows[0]?.files ?? 0);
  }

  if (vendor !== 'claude') {
    const rows = await client
      .select({ files: cs.files_uploaded })
      .from(cs)
      .where(and(inArray(cs.source, [...OPENAI_SOURCES]), isNotNull(cs.files_uploaded), gte(cs.started_at, since),
        memberIds ? inArray(cs.user_id, memberIds) : undefined));
    for (const r of rows) {
      let n = 0;
      try {
        const list = JSON.parse(r.files ?? '[]');
        n = Array.isArray(list) ? list.length : 0;
      } catch { n = 0; }
      if (n > 0) {
        result.sessions_with_uploads += 1;
        result.total_uploads += n;
      }
    }
  }
  return result;
}
