// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { TestSql } from './helpers/sql';
import { createTestDatabase } from './helpers/db';

let sql: TestSql;
let cleanup: () => Promise<void>;
let getCustomCategories: typeof import('../lib/intent/custom').getCustomCategories;
let saveCustomCategories: typeof import('../lib/intent/custom').saveCustomCategories;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;

  vi.resetModules();
  const mod = await import('../lib/intent/custom');
  getCustomCategories = mod.getCustomCategories;
  saveCustomCategories = mod.saveCustomCategories;
});

afterAll(async () => cleanup());
beforeEach(async () => {
  await sql.run("DELETE FROM config WHERE key = 'intent_custom_categories'");
});

describe('custom intent categories', () => {
  it('returns empty array when no custom categories configured', async () => {
    expect(await getCustomCategories()).toEqual([]);
  });

  it('saves and retrieves custom categories', async () => {
    const categories = [{
      id: 'phi_request',
      name: 'PHI Request',
      description: 'Protected health information requests',
      phrases: ['patient records', 'medical history'],
      defaultSeverity: 'critical' as const,
      builtIn: false,
      enabled: true,
    }];

    await saveCustomCategories(categories);
    const result = await getCustomCategories();

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('phi_request');
    expect(result[0].phrases).toContain('patient records');
  });

  it('overwrites existing custom categories on save', async () => {
    await saveCustomCategories([{
      id: 'first', name: 'First', description: 'test',
      phrases: ['old phrase'], defaultSeverity: 'low', builtIn: false, enabled: true,
    }]);

    await saveCustomCategories([{
      id: 'second', name: 'Second', description: 'test',
      phrases: ['new phrase'], defaultSeverity: 'high', builtIn: false, enabled: true,
    }]);

    const result = await getCustomCategories();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('second');
  });

  it('returns empty array on malformed JSON in config', async () => {
    await sql.run("INSERT INTO config (key, value) VALUES ('intent_custom_categories', 'not json') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    expect(await getCustomCategories()).toEqual([]);
  });
});
