// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const t = await createTestDatabase();
  sql = t.sql; cleanup = t.cleanup;
});
afterAll(async () => cleanup());

describe('migration 082 — use_case_skill_drafts', () => {
  it('creates the table with one row per use case and cascades on use case delete', async () => {
    const { createUseCase } = await import('@/lib/usecases/queries');
    const uc = await createUseCase({ title: 'Schema UC', status: 'confirmed' });

    const { getTypedClient } = await import('@/lib/db/client');
    const { schema } = await import('@/lib/db/schema');
    const client = await getTypedClient();
    await client.insert(schema.useCaseSkillDrafts).values({
      use_case_id: uc.id, skill_name: 'schema-uc', description: 'd', body_md: '## Purpose\n',
      owner_questions_json: '[]', citations_json: '{}', corpus_stats_json: '{}',
      thin: 0, model: 'claude-haiku-4-5-20251001', generated_at: 1,
    } as never);

    const rows = await sql.all('SELECT skill_name, edited_at, downloaded_at, library_entry_id FROM use_case_skill_drafts');
    expect(rows).toHaveLength(1);
    expect(rows[0].skill_name).toBe('schema-uc');
    expect(rows[0].edited_at).toBeNull();

    // PK = use_case_id: a second insert for the same use case must fail.
    await expect(client.insert(schema.useCaseSkillDrafts).values({
      use_case_id: uc.id, skill_name: 'other', description: 'd', body_md: 'b',
      owner_questions_json: '[]', citations_json: '{}', corpus_stats_json: '{}',
      thin: 0, model: 'm', generated_at: 2,
    } as never)).rejects.toThrow();

    await sql.run('DELETE FROM use_cases WHERE id = ?', [uc.id]);
    expect(await sql.get('SELECT COUNT(*) AS n FROM use_case_skill_drafts')).toEqual({ n: 0 });
  });
});
