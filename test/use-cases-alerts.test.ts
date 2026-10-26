// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;

let createUseCase: typeof import('@/lib/usecases/queries').createUseCase;
let runUseCaseAtRiskAlerts: typeof import('@/lib/alerts/use-case-alerts').runUseCaseAtRiskAlerts;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;

  ({ createUseCase } = await import('@/lib/usecases/queries'));
  ({ runUseCaseAtRiskAlerts } = await import('@/lib/alerts/use-case-alerts'));
});

afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec(`DELETE FROM alerts; DELETE FROM use_cases;`);
});

describe('use-case at-risk alerts', () => {
  it('inserts an alert on transition to at_risk', async () => {
    const uc = await createUseCase({ title: 'Contract triage', keywords: ['x'], status: 'confirmed' });
    await runUseCaseAtRiskAlerts(uc, 'adopted');
    // raw_evidence is jsonb on Postgres; CAST to text so LIKE works on both.
    const row = await sql.get<{ title: string; severity: string }>(
      `SELECT title, severity FROM alerts WHERE alert_type = 'use_case_at_risk' AND CAST(raw_evidence AS TEXT) LIKE ?`,
      [`%${uc.id}%`],
    );
    expect(row).toBeDefined();
    expect(row!.title).toContain('Contract triage');
    expect(row!.severity).toBe('medium');
  });

  it('dedupes within 7 days', async () => {
    const uc = await createUseCase({ title: 'Dedup case', keywords: ['x'], status: 'confirmed' });
    await runUseCaseAtRiskAlerts(uc, 'piloting');
    await runUseCaseAtRiskAlerts(uc, 'piloting');
    const n = (await sql.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM alerts WHERE alert_type = 'use_case_at_risk' AND CAST(raw_evidence AS TEXT) LIKE ?`,
      [`%${uc.id}%`],
    ))!;
    expect(n.n).toBe(1);
  });
});
