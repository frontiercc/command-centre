// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// "Turn this into a skill" reads a process-mined use case's canvas. A use case
// confirmed from a cross-department suggestion (department NULL) must
// find its canvas too.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const t = await createTestDatabase();
  sql = t.sql;
  cleanup = t.cleanup;
});
afterAll(async () => cleanup());

const canvas = JSON.stringify({ story: 'People compile a daily briefing.', valueHypothesis: 'v', departments: ['Finance', 'Sales'], people: 3, sessions: 5, occasions: 4, windowDays: 28, rhythm: { label: 'weekly', display: 'Weekly' }, systems: ['gmail'], activeHours: 1.5, tierNote: null });

describe('findCanvasForUseCase', () => {
  it('finds the canvas of a use case confirmed from a cross-department suggestion', async () => {
    await sql.run(`INSERT INTO use_case_suggestions (id, signal_key, title, description, matching_rule, evidence, status, generated_at, updated_at, department, canvas_json)
      VALUES ('s1', 'k1', 'Daily briefing', 'd', '{}', '{}', 'added', 1, 1, NULL, ?)`, [canvas]);
    const { createUseCase } = await import('@/lib/usecases/queries');
    const uc = await createUseCase({ title: 'Daily briefing', description: 'd', departments: ['Finance', 'Sales'], status: 'confirmed', captureMethod: 'process_mined', origin: 'emergent' });
    const { findCanvasForUseCase } = await import('@/lib/usecases/skill-draft-service');
    expect(await findCanvasForUseCase(uc)).not.toBeNull();
  });

  it('ignores an old tray row with the same title (no canvas)', async () => {
    await sql.run(`INSERT INTO use_case_suggestions (id, signal_key, title, description, matching_rule, evidence, status, generated_at, updated_at, department, canvas_json)
      VALUES ('s2', 'k2', 'Old tray title', 'd', '{}', '{}', 'added', 1, 1, NULL, NULL)`);
    const { createUseCase } = await import('@/lib/usecases/queries');
    const uc = await createUseCase({ title: 'Old tray title', description: 'd', departments: ['Finance'], status: 'confirmed', captureMethod: 'process_mined', origin: 'emergent' });
    const { findCanvasForUseCase } = await import('@/lib/usecases/skill-draft-service');
    expect(await findCanvasForUseCase(uc)).toBeNull();
  });
});
