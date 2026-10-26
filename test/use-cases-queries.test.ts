// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;

interface UseCase {
  id: string; title: string; description: string | null; ownerUserId: string | null;
  departments: string[]; surfaces: string[]; keywords: string[]; skills: string[]; connectors: string[]; taskTypes: string[];
  origin: 'planned' | 'emergent' | 'ideated'; status: 'candidate' | 'confirmed' | 'archived';
  captureMethod: 'guided' | 'ideation' | 'transcript' | 'suggested' | 'process_mined'; sourceExcerpt: string | null; createdBy: string | null;
  activateResult: unknown | null; lastActivatedAt: number | null; createdAt: number; updatedAt: number;
}

let createUseCase: (input: Partial<UseCase> & { title: string; createdBy?: string }) => Promise<UseCase>;
let listUseCases: (filter?: { status?: string; origin?: string }) => Promise<UseCase[]>;
let getUseCase: (id: string) => Promise<UseCase | undefined>;
let updateUseCase: (id: string, patch: Partial<UseCase>) => Promise<UseCase | undefined>;
let deleteUseCase: (id: string) => Promise<boolean>;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;

  const queries = await import('@/lib/usecases/queries');
  createUseCase = queries.createUseCase;
  listUseCases = queries.listUseCases;
  getUseCase = queries.getUseCase;
  updateUseCase = queries.updateUseCase;
  deleteUseCase = queries.deleteUseCase;
});

afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec('DELETE FROM use_cases');
});

describe('use_cases data layer', () => {
  it('creates and round-trips all JSON-array fields + enums via getUseCase', async () => {
    const created = await createUseCase({
      title: 'Draft weekly status reports',
      description: 'Summarise progress from tickets',
      ownerUserId: 'user-1',
      departments: ['Engineering', 'Product'],
      surfaces: ['cowork', 'code'],
      keywords: ['status', 'report'],
      skills: ['status-report'],
      connectors: ['linear'],
      taskTypes: ['reporting'],
      origin: 'ideated',
      status: 'confirmed',
      captureMethod: 'ideation',
      sourceExcerpt: 'We should automate the weekly report',
      createdBy: 'user-1',
    });

    expect(created.id).toBeTruthy();
    expect(created.title).toBe('Draft weekly status reports');
    expect(created.origin).toBe('ideated');
    expect(created.status).toBe('confirmed');
    expect(created.captureMethod).toBe('ideation');
    expect(created.createdAt).toBeGreaterThan(0);
    expect(created.updatedAt).toBeGreaterThan(0);

    const fetched = await getUseCase(created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.departments).toEqual(['Engineering', 'Product']);
    expect(fetched!.surfaces).toEqual(['cowork', 'code']);
    expect(fetched!.keywords).toEqual(['status', 'report']);
    expect(fetched!.skills).toEqual(['status-report']);
    expect(fetched!.connectors).toEqual(['linear']);
    expect(fetched!.taskTypes).toEqual(['reporting']);
    expect(fetched!.ownerUserId).toBe('user-1');
    expect(fetched!.sourceExcerpt).toBe('We should automate the weekly report');
    expect(fetched!.createdBy).toBe('user-1');
  });

  it('applies defaults for origin/status/captureMethod and empty arrays for omitted JSON fields', async () => {
    const created = await createUseCase({ title: 'Minimal use case' });

    expect(created.origin).toBe('planned');
    expect(created.status).toBe('candidate');
    expect(created.captureMethod).toBe('guided');
    expect(created.departments).toEqual([]);
    expect(created.surfaces).toEqual([]);
    expect(created.keywords).toEqual([]);
    expect(created.skills).toEqual([]);
    expect(created.connectors).toEqual([]);
    expect(created.taskTypes).toEqual([]);
    expect(created.description).toBeNull();
    expect(created.ownerUserId).toBeNull();
    expect(created.activateResult).toBeNull();
    expect(created.lastActivatedAt).toBeNull();

    const fetched = await getUseCase(created.id);
    expect(fetched!.departments).toEqual([]);
  });

  it('getUseCase returns undefined for a missing id', async () => {
    expect(await getUseCase('does-not-exist')).toBeUndefined();
  });

  it('lists newest-first and filters by status and origin', async () => {
    const a = await createUseCase({ title: 'A', status: 'candidate', origin: 'planned' });
    // Ensure ordering is deterministic even if created within the same second.
    // Force distinct created_at values for all three rows: the ORDER BY tiebreak
    // is `id DESC` (a random uuid — Postgres has no rowid), which is
    // deterministic but does NOT encode
    // insertion order, so this test must not rely on the tiebreak to disambiguate
    // same-second rows.
    await sql.run('UPDATE use_cases SET created_at = created_at - 10 WHERE id = ?', [a.id]);
    const b = await createUseCase({ title: 'B', status: 'confirmed', origin: 'emergent' });
    await sql.run('UPDATE use_cases SET created_at = created_at - 5 WHERE id = ?', [b.id]);
    const c = await createUseCase({ title: 'C', status: 'confirmed', origin: 'ideated' });

    const all = await listUseCases();
    expect(all.map(u => u.id)).toEqual([c.id, b.id, a.id]);

    const confirmedOnly = await listUseCases({ status: 'confirmed' });
    expect(confirmedOnly.map(u => u.id).sort()).toEqual([b.id, c.id].sort());

    const emergentOnly = await listUseCases({ origin: 'emergent' });
    expect(emergentOnly.map(u => u.id)).toEqual([b.id]);

    const confirmedAndIdeated = await listUseCases({ status: 'confirmed', origin: 'ideated' });
    expect(confirmedAndIdeated.map(u => u.id)).toEqual([c.id]);
  });

  it('updates fields, bumps updated_at, and preserves untouched fields', async () => {
    const created = await createUseCase({
      title: 'Original title',
      description: 'Original description',
      departments: ['Sales'],
      status: 'candidate',
    });

    // Force updated_at back so the bump is observable even at second resolution.
    await sql.run('UPDATE use_cases SET updated_at = updated_at - 10 WHERE id = ?', [created.id]);
    const before = await getUseCase(created.id);

    const updated = await updateUseCase(created.id, { status: 'archived', departments: ['Sales', 'Marketing'] });

    expect(updated).toBeDefined();
    expect(updated!.status).toBe('archived');
    expect(updated!.departments).toEqual(['Sales', 'Marketing']);
    expect(updated!.title).toBe('Original title');
    expect(updated!.description).toBe('Original description');
    expect(updated!.updatedAt).toBeGreaterThan(before!.updatedAt);
    expect(updated!.createdAt).toBe(before!.createdAt);
  });

  it('updateUseCase returns undefined for a missing id', async () => {
    expect(await updateUseCase('does-not-exist', { status: 'archived' })).toBeUndefined();
  });

  it('deletes a use case and returns false on a second delete', async () => {
    const created = await createUseCase({ title: 'To delete' });
    expect(await deleteUseCase(created.id)).toBe(true);
    expect(await getUseCase(created.id)).toBeUndefined();
    expect(await deleteUseCase(created.id)).toBe(false);
  });
});

describe('use cases config flag', () => {
  it('defaults useCasesEnabled to false and round-trips true', async () => {
    const { getAllConfig, saveConfig } = await import('@/lib/config');

    expect((await getAllConfig()).useCasesEnabled).toBe(false);

    await saveConfig({ useCasesEnabled: 'true' });
    expect((await getAllConfig()).useCasesEnabled).toBe(true);

    await saveConfig({ useCasesEnabled: 'false' });
    expect((await getAllConfig()).useCasesEnabled).toBe(false);
  });

  it('defaults the extract and ideate model keys', async () => {
    const { getAllConfig } = await import('@/lib/config');
    const cfg = await getAllConfig();
    expect(cfg.useCasesExtractModel).toBe('claude-haiku-4-5-20251001');
    expect(cfg.useCasesIdeateModel).toBe('claude-sonnet-5');
  });
});
