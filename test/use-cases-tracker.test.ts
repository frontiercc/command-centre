// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The tracker now that use cases are defined by the work: it no
// longer matches telemetry (the session judge does, see
// use-case-session-judge-pg.test.ts); it keeps the weekly measured marker and
// the adoption stage, and asks for a judging run when a use case changes.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';
import { seedUserSql } from './helpers/seed';

let sql: TestSql;
let cleanup: () => Promise<void>;

let weekStart: typeof import('@/lib/pulse/period').weekStart;
let createUseCase: typeof import('@/lib/usecases/queries').createUseCase;
let getUseCase: typeof import('@/lib/usecases/queries').getUseCase;
let runUseCaseTracker: typeof import('@/lib/usecases/tracker').runUseCaseTracker;
let bootstrapUseCase: typeof import('@/lib/usecases/tracker').bootstrapUseCase;
let getCurrentWeek: typeof import('@/lib/usecases/weeks').getCurrentWeek;
let addSessionMatch: typeof import('@/lib/usecases/weeks').addSessionMatch;
let refreshWeekFromJunction: typeof import('@/lib/usecases/weeks').refreshWeekFromJunction;
let setConfigValue: typeof import('@/lib/config').setConfigValue;
let getConfigValue: typeof import('@/lib/config').getConfigValue;

const NOW = Math.floor(Date.now() / 1000);

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
  ({ weekStart } = await import('@/lib/pulse/period'));
  ({ createUseCase, getUseCase } = await import('@/lib/usecases/queries'));
  ({ runUseCaseTracker, bootstrapUseCase } = await import('@/lib/usecases/tracker'));
  ({ getCurrentWeek, addSessionMatch, refreshWeekFromJunction } = await import('@/lib/usecases/weeks'));
  ({ setConfigValue, getConfigValue } = await import('@/lib/config'));
  await seedUserSql(sql, 'u1');
});

afterAll(async () => cleanup());

describe('use case tracker', () => {
  it('writes a measured row for every live use case every run, even with no clues at all', async () => {
    const uc = await createUseCase({ title: 'no clues', description: 'Some work.', status: 'confirmed' });
    await runUseCaseTracker(NOW);
    expect(await getCurrentWeek(uc.id, NOW)).not.toBeNull();
  });

  it('skips archived use cases', async () => {
    const archived = await createUseCase({ title: 'archived', status: 'archived' });
    await runUseCaseTracker(NOW);
    expect(await getCurrentWeek(archived.id, NOW)).toBeNull();
  });

  it('moves the adoption stage from the judged weekly matches and fires the hook', async () => {
    const uc = await createUseCase({ title: 'lifecycle hook', description: 'Work.', status: 'confirmed' });
    await addSessionMatch(uc.id, weekStart(NOW), 'u1', 's1');
    await refreshWeekFromJunction(uc.id, weekStart(NOW));
    const transitions: string[] = [];
    await runUseCaseTracker(NOW, { onLifecycleChange: (_u, from, to) => transitions.push(`${from}->${to}`) });
    expect((await getUseCase(uc.id))?.lifecycle).toBe('piloting');
    expect(transitions).toContain('not_seen->piloting');
  });

  it('a changed use case asks the next scheduler cycle for a judging run', async () => {
    const uc = await createUseCase({ title: 'new one', description: 'Work.', status: 'confirmed' });
    await setConfigValue('useCaseJudgeLastRun', new Date().toISOString());
    await bootstrapUseCase(uc.id, NOW);
    expect(await getConfigValue('useCaseJudgeLastRun')).toBe('');
    expect(await getCurrentWeek(uc.id, NOW)).not.toBeNull();
  });
});
