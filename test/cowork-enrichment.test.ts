// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import { seedUserSql } from './helpers/seed';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;

// Dynamically imported query functions (bound to test DB). These were
// converted to async Drizzle — the calls below are awaited accordingly.
let upsertCoworkSession: typeof import('@/lib/db/queries').upsertCoworkSession;
let getCoworkProjectStats: typeof import('@/lib/db/queries').getCoworkProjectStats;
let getCoworkActiveProjectCount: typeof import('@/lib/db/queries').getCoworkActiveProjectCount;
let getCoworkTopFiles: typeof import('@/lib/db/queries').getCoworkTopFiles;
let getCoworkUserProjects: typeof import('@/lib/db/queries').getCoworkUserProjects;
let getCoworkUserSessions: typeof import('@/lib/db/queries').getCoworkUserSessions;

const NOW = Math.floor(Date.now() / 1000);
const ONE_HOUR_AGO = NOW - 3600;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;

  const queries = await import('@/lib/db/queries');
  upsertCoworkSession = queries.upsertCoworkSession;
  getCoworkProjectStats = queries.getCoworkProjectStats;
  getCoworkActiveProjectCount = queries.getCoworkActiveProjectCount;
  getCoworkTopFiles = queries.getCoworkTopFiles;
  getCoworkUserProjects = queries.getCoworkUserProjects;
  getCoworkUserSessions = queries.getCoworkUserSessions;

  await seedUserSql(sql, 'user-1');
  await seedUserSql(sql, 'user-2');
});

afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec('DELETE FROM cowork_sessions');
});

// ─── Helper ──────────────────────────────────────────────────────────────

async function seedSession(id: string, opts: {
  userId?: string; projectName?: string | null;
  filesTouched?: string[] | null; startedAt?: number;
  endedAt?: number | null;
} = {}) {
  await upsertCoworkSession({
    id,
    conversation_id: `conv-${id}`,
    user_id: opts.userId ?? 'user-1',
    project_name: opts.projectName ?? null,
    files_touched: opts.filesTouched ?? null,
    started_at: opts.startedAt ?? NOW,
    ended_at: opts.endedAt ?? null,
  });
}

// ─── upsertCoworkSession: new columns ───────────────────────────────────

describe('upsertCoworkSession', () => {
  it('persists files_touched and project_name on insert', async () => {
    await seedSession('s1', {
      projectName: 'my-project',
      filesTouched: ['src/index.ts', 'lib/util.ts'],
    });

    const row = (await sql.get('SELECT files_touched, project_name FROM cowork_sessions WHERE id = ?', ['s1'])) as {
      files_touched: string | null; project_name: string | null;
    };

    expect(row.project_name).toBe('my-project');
    const files = JSON.parse(row.files_touched!);
    expect(files).toContain('src/index.ts');
    expect(files).toContain('lib/util.ts');
  });

  it('merges files_touched JSON arrays on upsert (deduplication)', async () => {
    // First insert
    await upsertCoworkSession({
      id: 's-merge',
      conversation_id: 'conv-merge',
      user_id: 'user-1',
      files_touched: ['a.ts', 'b.ts'],
      started_at: NOW,
    });

    // Second upsert with overlapping files
    await upsertCoworkSession({
      id: 's-merge',
      conversation_id: 'conv-merge',
      user_id: 'user-1',
      files_touched: ['b.ts', 'c.ts'],
      started_at: NOW,
    });

    const row = (await sql.get('SELECT files_touched FROM cowork_sessions WHERE id = ?', ['s-merge'])) as {
      files_touched: string;
    };

    const files: string[] = JSON.parse(row.files_touched);
    expect(files.sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('preserves existing files_touched when upsert value is null', async () => {
    await upsertCoworkSession({
      id: 's-keep',
      conversation_id: 'conv-keep',
      files_touched: ['keep.ts'],
      started_at: NOW,
    });

    await upsertCoworkSession({
      id: 's-keep',
      conversation_id: 'conv-keep',
      files_touched: null,
      started_at: NOW,
    });

    const row = (await sql.get('SELECT files_touched FROM cowork_sessions WHERE id = ?', ['s-keep'])) as {
      files_touched: string;
    };
    expect(JSON.parse(row.files_touched)).toEqual(['keep.ts']);
  });
});

// ─── getCoworkProjectStats ──────────────────────────────────────────────

describe('getCoworkProjectStats', () => {
  it('returns session counts and user counts per project', async () => {
    await seedSession('s1', { userId: 'user-1', projectName: 'alpha', startedAt: NOW });
    await seedSession('s2', { userId: 'user-2', projectName: 'alpha', startedAt: NOW });
    await seedSession('s3', { userId: 'user-1', projectName: 'beta', startedAt: NOW });

    const stats = await getCoworkProjectStats(ONE_HOUR_AGO);

    const alpha = stats.find(s => s.project_name === 'alpha');
    const beta = stats.find(s => s.project_name === 'beta');

    expect(alpha).toBeDefined();
    expect(alpha!.session_count).toBe(2);
    expect(alpha!.user_count).toBe(2);

    expect(beta).toBeDefined();
    expect(beta!.session_count).toBe(1);
    expect(beta!.user_count).toBe(1);
  });

  it('excludes sessions without project_name', async () => {
    await seedSession('s1', { projectName: 'alpha', startedAt: NOW });
    await seedSession('s2', { projectName: null, startedAt: NOW });

    const stats = await getCoworkProjectStats(ONE_HOUR_AGO);
    expect(stats).toHaveLength(1);
    expect(stats[0].project_name).toBe('alpha');
  });

  it('excludes sessions older than since', async () => {
    const twoHoursAgo = NOW - 7200;
    await seedSession('s1', { projectName: 'old-proj', startedAt: twoHoursAgo });
    await seedSession('s2', { projectName: 'new-proj', startedAt: NOW });

    const stats = await getCoworkProjectStats(ONE_HOUR_AGO);
    expect(stats).toHaveLength(1);
    expect(stats[0].project_name).toBe('new-proj');
  });
});

// ─── getCoworkActiveProjectCount ────────────────────────────────────────

describe('getCoworkActiveProjectCount', () => {
  it('returns count of distinct projects', async () => {
    await seedSession('s1', { projectName: 'alpha', startedAt: NOW });
    await seedSession('s2', { projectName: 'alpha', startedAt: NOW });
    await seedSession('s3', { projectName: 'beta', startedAt: NOW });
    await seedSession('s4', { projectName: null, startedAt: NOW });

    expect(await getCoworkActiveProjectCount(ONE_HOUR_AGO)).toBe(2);
  });

  it('returns 0 when no projects exist', async () => {
    expect(await getCoworkActiveProjectCount(ONE_HOUR_AGO)).toBe(0);
  });
});

// ─── getCoworkTopFiles ──────────────────────────────────────────────────

describe('getCoworkTopFiles', () => {
  it('returns files ranked by session count', async () => {
    // shared.ts appears in 3 sessions, only-a.ts in 1, only-b.ts in 1
    await seedSession('s1', { filesTouched: ['shared.ts', 'only-a.ts'], startedAt: NOW });
    await seedSession('s2', { filesTouched: ['shared.ts', 'only-b.ts'], startedAt: NOW });
    await seedSession('s3', { filesTouched: ['shared.ts'], startedAt: NOW });

    const top = await getCoworkTopFiles(ONE_HOUR_AGO, 10);

    expect(top[0].file_path).toBe('shared.ts');
    expect(top[0].session_count).toBe(3);

    // The remaining two each have session_count 1
    const rest = top.filter(f => f.session_count === 1);
    expect(rest).toHaveLength(2);
  });

  it('respects the limit parameter', async () => {
    await seedSession('s1', { filesTouched: ['a.ts', 'b.ts', 'c.ts'], startedAt: NOW });

    const top = await getCoworkTopFiles(ONE_HOUR_AGO, 2);
    expect(top).toHaveLength(2);
  });

  it('skips sessions without files_touched', async () => {
    await seedSession('s1', { filesTouched: null, startedAt: NOW });
    await seedSession('s2', { filesTouched: ['x.ts'], startedAt: NOW });

    const top = await getCoworkTopFiles(ONE_HOUR_AGO);
    expect(top).toHaveLength(1);
    expect(top[0].file_path).toBe('x.ts');
  });
});

// ─── getCoworkUserProjects ──────────────────────────────────────────────

describe('getCoworkUserProjects', () => {
  it('returns projects and file lists for a specific user', async () => {
    await seedSession('s1', {
      userId: 'user-1', projectName: 'proj-a',
      filesTouched: ['a.ts', 'b.ts'], startedAt: NOW,
    });
    await seedSession('s2', {
      userId: 'user-1', projectName: 'proj-a',
      filesTouched: ['b.ts', 'c.ts'], startedAt: NOW,
    });
    await seedSession('s3', {
      userId: 'user-2', projectName: 'proj-a',
      filesTouched: ['d.ts'], startedAt: NOW,
    });

    const projects = await getCoworkUserProjects('user-1', ONE_HOUR_AGO);

    expect(projects).toHaveLength(1);
    expect(projects[0].project_name).toBe('proj-a');
    expect(projects[0].session_count).toBe(2);
    // Should include all distinct files from user-1's sessions
    expect(projects[0].files.sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('excludes sessions without project_name', async () => {
    await seedSession('s1', { userId: 'user-1', projectName: null, startedAt: NOW });

    const projects = await getCoworkUserProjects('user-1', ONE_HOUR_AGO);
    expect(projects).toHaveLength(0);
  });
});

// ─── getCoworkUserSessions ──────────────────────────────────────────────

describe('getCoworkUserSessions', () => {
  it('returns sessions with correct fields', async () => {
    await seedSession('s1', {
      userId: 'user-1', projectName: 'proj-x',
      filesTouched: ['a.ts', 'b.ts'], startedAt: NOW, endedAt: NOW + 600,
    });
    await seedSession('s2', {
      userId: 'user-1', projectName: null,
      filesTouched: null, startedAt: NOW - 60,
    });

    const sessions = await getCoworkUserSessions('user-1', ONE_HOUR_AGO);

    expect(sessions).toHaveLength(2);

    // Ordered by started_at DESC, so s1 (NOW) comes first
    const first = sessions[0];
    expect(first.id).toBe('s1');
    expect(first.project_name).toBe('proj-x');
    expect(first.files_touched_count).toBe(2);
    expect(first.started_at).toBe(NOW);
    expect(first.ended_at).toBe(NOW + 600);

    const second = sessions[1];
    expect(second.id).toBe('s2');
    expect(second.project_name).toBeNull();
    expect(second.files_touched_count).toBe(0);
    expect(second.ended_at).toBeNull();
  });

  it('only returns sessions for the specified user', async () => {
    await seedSession('s1', { userId: 'user-1', startedAt: NOW });
    await seedSession('s2', { userId: 'user-2', startedAt: NOW });

    const sessions = await getCoworkUserSessions('user-1', ONE_HOUR_AGO);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('s1');
  });

  it('respects the limit parameter', async () => {
    await seedSession('s1', { userId: 'user-1', startedAt: NOW });
    await seedSession('s2', { userId: 'user-1', startedAt: NOW - 10 });
    await seedSession('s3', { userId: 'user-1', startedAt: NOW - 20 });

    const sessions = await getCoworkUserSessions('user-1', ONE_HOUR_AGO, 2);
    expect(sessions).toHaveLength(2);
  });
});
