// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import { seedUserSql } from './helpers/seed';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;

type FileCategory = 'Code & scripts' | 'Web pages & styles' | 'Documents & reports' | 'Slides & decks' | 'Config & structured data' | 'Spreadsheets & tabular data' | 'Diagrams' | 'Other';

let categorizeFilePath: (p: string) => FileCategory;
let getFileCategoryMix: (windowDays?: number) => Promise<Array<{ category: FileCategory; count: number; share: number }>>;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;

  const mod = await import('@/lib/pulse/cowork/file-categories');
  categorizeFilePath = mod.categorizeFilePath;
  getFileCategoryMix = mod.getFileCategoryMix;

  await seedUserSql(sql, 'user-1');
});

afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec('DELETE FROM cowork_sessions');
});

async function insertSession(id: string, overrides: Partial<{
  conversation_id: string; user_id: string; files_touched: string | null; files_uploaded: string | null; started_at: number;
}> = {}) {
  const now = Math.floor(Date.now() / 1000);
  await sql.run(
    `INSERT INTO cowork_sessions (id, conversation_id, user_id, files_touched, files_uploaded, started_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
    id,
    overrides.conversation_id ?? `conv-${id}`,
    overrides.user_id ?? 'user-1',
    overrides.files_touched === undefined ? JSON.stringify(['a.ts']) : overrides.files_touched,
    overrides.files_uploaded ?? null,
    overrides.started_at ?? now],
  );
}

describe('categorizeFilePath', () => {
  const cases: Array<[string, FileCategory]> = [
    ['app.ts', 'Code & scripts'],
    ['foo.TS', 'Code & scripts'], // case-insensitive
    ['a/b.min.js', 'Code & scripts'], // final extension only
    ['script.py', 'Code & scripts'],
    ['main.go', 'Code & scripts'],
    ['notebook.ipynb', 'Code & scripts'],
    ['index.html', 'Web pages & styles'],
    ['styles.scss', 'Web pages & styles'],
    ['App.vue', 'Web pages & styles'],
    ['README.md', 'Documents & reports'],
    ['notes.txt', 'Documents & reports'],
    ['report.pdf', 'Documents & reports'],
    ['contract.docx', 'Documents & reports'],
    ['deck.pptx', 'Slides & decks'],
    ['slides.key', 'Slides & decks'],
    ['config.json', 'Config & structured data'],
    ['values.yaml', 'Config & structured data'],
    ['.env', 'Config & structured data'],
    ['data.xlsx', 'Spreadsheets & tabular data'],
    ['export.csv', 'Spreadsheets & tabular data'],
    ['diagram.svg', 'Diagrams'],
    ['flow.drawio', 'Diagrams'],
    ['Dockerfile', 'Other'], // no extension
    ['LICENSE', 'Other'],
    ['archive.zip', 'Other'],
  ];

  it.each(cases)('categorizes %s as %s', (path, expected) => {
    expect(categorizeFilePath(path)).toBe(expected);
  });
});

describe('getFileCategoryMix', () => {
  it('returns empty array when no sessions', async () => {
    expect(await getFileCategoryMix()).toEqual([]);
  });

  it('counts every file entry and computes shares summing to 1', async () => {
    await insertSession('s1', { files_touched: JSON.stringify(['a.ts', 'b.ts', 'index.html']) });
    await insertSession('s2', { files_touched: JSON.stringify(['c.py']) });

    const mix = await getFileCategoryMix();
    const total = mix.reduce((sum, m) => sum + m.count, 0);
    expect(total).toBe(4);

    const shareSum = mix.reduce((sum, m) => sum + m.share, 0);
    expect(shareSum).toBeCloseTo(1, 5);

    // sorted desc by count
    for (let i = 1; i < mix.length; i++) {
      expect(mix[i - 1].count).toBeGreaterThanOrEqual(mix[i].count);
    }

    const code = mix.find(m => m.category === 'Code & scripts');
    expect(code?.count).toBe(3);
    expect(code?.share).toBeCloseTo(0.75, 5);
  });

  it('skips rows with NULL files_touched without throwing', async () => {
    await insertSession('s1', { files_touched: null });
    await insertSession('s2', { files_touched: JSON.stringify(['a.ts']) });

    await expect(getFileCategoryMix()).resolves.not.toThrow();
    const mix = await getFileCategoryMix();
    expect(mix).toEqual([{ category: 'Code & scripts', count: 1, share: 1 }]);
  });

  it('skips rows with malformed JSON without throwing', async () => {
    await insertSession('s1', { files_touched: 'not valid json{{' });
    await insertSession('s2', { files_touched: JSON.stringify(['b.py']) });

    await expect(getFileCategoryMix()).resolves.not.toThrow();
    const mix = await getFileCategoryMix();
    expect(mix).toEqual([{ category: 'Code & scripts', count: 1, share: 1 }]);
  });

  it('respects the window — excludes sessions outside windowDays', async () => {
    const now = Math.floor(Date.now() / 1000);
    await insertSession('recent', { files_touched: JSON.stringify(['a.ts']), started_at: now - 5 * 86400 });
    await insertSession('old', { files_touched: JSON.stringify(['b.py']), started_at: now - 40 * 86400 });

    const mix = await getFileCategoryMix(30);
    const total = mix.reduce((sum, m) => sum + m.count, 0);
    expect(total).toBe(1);
  });

  // files_touched is legacy-agent-only (never written by the OTel receivers);
  // files_uploaded IS written by OTel (extracted from <uploaded_files> tags in
  // the prompt) — OTel-only deployments (every current real instance) would
  // otherwise never show anything in this card. Count both, union-style.
  it('also counts files_uploaded (OTel-populated) alongside files_touched (legacy-agent-only)', async () => {
    await insertSession('s1', { files_touched: null, files_uploaded: JSON.stringify(['report.pdf', 'data.xlsx']) });

    const mix = await getFileCategoryMix();
    const total = mix.reduce((sum, m) => sum + m.count, 0);
    expect(total).toBe(2);
    expect(mix.find(m => m.category === 'Documents & reports')?.count).toBe(1);
    expect(mix.find(m => m.category === 'Spreadsheets & tabular data')?.count).toBe(1);
  });

  it('counts a session with BOTH files_touched and files_uploaded without double-dipping either list', async () => {
    await insertSession('s1', {
      files_touched: JSON.stringify(['a.ts']),
      files_uploaded: JSON.stringify(['report.pdf']),
    });

    const mix = await getFileCategoryMix();
    const total = mix.reduce((sum, m) => sum + m.count, 0);
    expect(total).toBe(2);
    expect(mix.find(m => m.category === 'Code & scripts')?.count).toBe(1);
    expect(mix.find(m => m.category === 'Documents & reports')?.count).toBe(1);
  });

  it('skips rows with malformed files_uploaded JSON without throwing', async () => {
    await insertSession('s1', { files_touched: null, files_uploaded: 'not valid json{{' });
    await insertSession('s2', { files_touched: null, files_uploaded: JSON.stringify(['b.py']) });

    await expect(getFileCategoryMix()).resolves.not.toThrow();
    const mix = await getFileCategoryMix();
    expect(mix).toEqual([{ category: 'Code & scripts', count: 1, share: 1 }]);
  });
});
