// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Postgres coverage for the first converted group of
// lib/db/queries.ts: the Cowork project/file analytics + upsertCoworkSession.
// This group exercises table-valued JSON expansion over the TEXT files_touched
// column (Postgres jsonb_array_elements_text / jsonb_agg / jsonb_array_length),
// against a migrated Postgres database (createTestDbClient('postgres')).
//
// HARNESS RULE (copied from error-queries.test.ts): the module-under-test (and
// schema) are DYNAMIC-imported AFTER createTestDbClient() has set the database
// env + reset modules.
import { describe, it, expect } from 'vitest';

const NOW = Math.floor(Date.now() / 1000);
const ONE_HOUR_AGO = NOW - 3600;

async function runSpec(): Promise<void> {
  const { createTestDbClient } = await import('./helpers/db');
  const { client, cleanup } = await createTestDbClient('postgres');
  try {
    // Dynamic import AFTER the database env + module reset (harness rule).
    const { schema } = await import('@/lib/db/schema');
    const queries = await import('@/lib/db/queries');
    const {
      upsertCoworkSession, getCoworkProjectStats, getCoworkActiveProjectCount,
      getCoworkTopFiles, getCoworkUserProjects, getCoworkUserSessions,
    } = queries;

    // Seed users (FK parent) via the same client the queries use.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).insert(schema.users).values([
      { id: 'user-1', email: 'u1@test.local' },
      { id: 'user-2', email: 'u2@test.local' },
    ]);

    const seed = (id: string, opts: {
      userId?: string; projectName?: string | null;
      filesTouched?: string[] | null; startedAt?: number; endedAt?: number | null;
    } = {}) => upsertCoworkSession({
      id, conversation_id: `conv-${id}`,
      user_id: opts.userId ?? 'user-1',
      project_name: opts.projectName ?? null,
      files_touched: opts.filesTouched ?? null,
      started_at: opts.startedAt ?? NOW,
      ended_at: opts.endedAt ?? null,
    });

    // ── upsertCoworkSession: dedup JSON-array merge on conflict
    await seed('s-merge', { filesTouched: ['a.ts', 'b.ts'] });
    await seed('s-merge', { filesTouched: ['b.ts', 'c.ts'] });

    // ── getCoworkProjectStats: session + distinct-user counts per project
    await seed('s1', { userId: 'user-1', projectName: 'alpha' });
    await seed('s2', { userId: 'user-2', projectName: 'alpha' });
    await seed('s3', { userId: 'user-1', projectName: 'beta' });
    await seed('s4', { projectName: null }); // excluded (no project)

    const stats = await getCoworkProjectStats(ONE_HOUR_AGO);
    const alpha = stats.find((s) => s.project_name === 'alpha');
    const beta = stats.find((s) => s.project_name === 'beta');
    expect(alpha?.session_count).toBe(2);
    expect(alpha?.user_count).toBe(2);
    expect(beta?.session_count).toBe(1);
    expect(beta?.user_count).toBe(1);
    // counts are numbers (Postgres int8 → coerced, not string)
    expect(typeof alpha?.session_count).toBe('number');

    // ── getCoworkActiveProjectCount: distinct non-null projects
    expect(await getCoworkActiveProjectCount(ONE_HOUR_AGO)).toBe(2);

    // ── getCoworkTopFiles: ranking + merge-dedup evidence + limit
    // s-merge has ['a.ts','b.ts','c.ts']; s1/s2/s3/s4 have no files.
    const top = await getCoworkTopFiles(ONE_HOUR_AGO, 10);
    expect(top.map((f) => f.file_path).sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(top.every((f) => f.session_count === 1)).toBe(true);
    expect((await getCoworkTopFiles(ONE_HOUR_AGO, 2)).length).toBe(2);

    // ── getCoworkUserProjects: per-user distinct file list
    await seed('p1', { userId: 'user-1', projectName: 'proj-a', filesTouched: ['a.ts', 'b.ts'] });
    await seed('p2', { userId: 'user-1', projectName: 'proj-a', filesTouched: ['b.ts', 'c.ts'] });
    await seed('p3', { userId: 'user-2', projectName: 'proj-a', filesTouched: ['d.ts'] });
    const projects = await getCoworkUserProjects('user-1', ONE_HOUR_AGO);
    const projA = projects.find((p) => p.project_name === 'proj-a');
    expect(projA?.session_count).toBe(2);
    expect(projA?.files.sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);

    // ── getCoworkUserSessions: fields, DESC order, bigint→number coercion
    const sessions = await getCoworkUserSessions('user-2', ONE_HOUR_AGO, 10);
    const sess = sessions.find((s) => s.id === 'p3');
    expect(sess).toBeDefined();
    expect(sess!.files_touched_count).toBe(1);
    expect(typeof sess!.started_at).toBe('number');
    expect(sess!.started_at).toBe(NOW);

    // limit honoured
    await seed('u2a', { userId: 'user-2', startedAt: NOW - 10 });
    await seed('u2b', { userId: 'user-2', startedAt: NOW - 20 });
    expect((await getCoworkUserSessions('user-2', ONE_HOUR_AGO, 2)).length).toBe(2);
  } finally {
    await cleanup();
  }
}

describe('cowork analytics (postgres)', () => {
  it(
    'project/file analytics + upsert merge behave correctly on postgres',
    async () => {
      await runSpec();
    },
    180_000,
  );
});
