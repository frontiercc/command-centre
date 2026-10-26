// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;
let createUseCase: typeof import('@/lib/usecases/queries').createUseCase;
let updateUseCase: typeof import('@/lib/usecases/queries').updateUseCase;
let getUseCase: typeof import('@/lib/usecases/queries').getUseCase;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
  ({ createUseCase, updateUseCase, getUseCase } = await import('@/lib/usecases/queries'));
});
afterAll(async () => cleanup());
beforeEach(async () => { await sql.exec(`DELETE FROM use_cases;`); });

describe('use-case strategic flag', () => {
  it('defaults to 0 on create', async () => {
    const uc = await createUseCase({ title: 'Contract review', status: 'confirmed' });
    expect(uc.strategic).toBe(0);
  });

  it('is settable via updateUseCase and read back', async () => {
    const uc = await createUseCase({ title: 'RFP drafting', status: 'confirmed' });
    await updateUseCase(uc.id, { strategic: 1 });
    expect((await getUseCase(uc.id))!.strategic).toBe(1);
  });

  it('star-and-confirm in ONE update promotes a candidate to a governance-visible bet', async () => {
    // Locks the contract the detail page's star-on-candidate prompt relies on
    // (a papercut: a star on a candidate surfaced nowhere because the
    // governance rollup requires status='confirmed' AND strategic=1).
    const uc = await createUseCase({ title: 'Timesheet automation', status: 'candidate' });
    await updateUseCase(uc.id, { strategic: 1, status: 'confirmed' });
    const after = (await getUseCase(uc.id))!;
    expect(after.strategic).toBe(1);
    expect(after.status).toBe('confirmed');
  });
});

// The route-level `strategic ? 1 : 0` coercion in
// app/api/use-cases/[id]/route.ts is exercised end-to-end (through the actual
// PATCH handler, asserting a real numeric 0|1) by
// 'PATCH coerces strategic to a numeric 0|1 (route handler, not the queries
// layer)' in test/use-cases-routes.test.ts. This file only covers the
// queries-layer contract above (createUseCase default + updateUseCase
// passthrough when already-coerced values are supplied directly).
