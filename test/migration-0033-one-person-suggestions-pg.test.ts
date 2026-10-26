// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Migration 0033: open one-person department suggestions are
// retired; two-person ones, cross-department ones and other statuses are not.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
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

const canvas = (people: number) => JSON.stringify({ story: 's', valueHypothesis: 'v', people, sessions: 4, occasions: 4, windowDays: 28, rhythm: { label: 'weekly', display: 'Weekly' }, systems: [], activeHours: null, tierNote: null });

async function row(id: string, department: string | null, status: string, people: number | null) {
  await sql.run(`INSERT INTO use_case_suggestions (id, signal_key, title, description, matching_rule, evidence, status, generated_at, updated_at, department, canvas_json)
    VALUES (?, ?, ?, 'd', '{}', '{}', ?, 1, 1, ?, ?)`, [id, `k-${id}`, id, status, department, people === null ? null : canvas(people)]);
}

describe('migration 0033: dismiss open one-person department suggestions', () => {
  it('retires only open one-person department rows', async () => {
    await row('solo', 'Finance', 'open', 1);
    await row('pair', 'Finance', 'open', 2);
    await row('twelve', 'Finance', 'open', 12);
    await row('solo-added', 'Finance', 'added', 1);
    await row('across', null, 'open', 3);
    await row('old-tray', null, 'open', null);

    const file = path.join(process.cwd(), 'lib/db/migrations-pg/0033_dismiss_one_person_suggestions.sql');
    await sql.exec(readFileSync(file, 'utf8'));

    const rows = await sql.all<{ id: string; status: string }>(`SELECT id, status FROM use_case_suggestions ORDER BY id`);
    expect(Object.fromEntries(rows.map(r => [r.id, r.status]))).toEqual({
      across: 'open', 'old-tray': 'open', pair: 'open', solo: 'dismissed', 'solo-added': 'added', twelve: 'open',
    });
  });
});
