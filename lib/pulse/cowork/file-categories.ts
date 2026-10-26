// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Cowork files-by-category mix.
 *
 * Categorises file paths touched during Cowork sessions into coarse
 * content-type buckets, and produces an org-wide mix (count + share) over a
 * rolling window. Reads BOTH cowork_sessions.files_touched (legacy-agent-only
 * — never written by the OTel receivers) and files_uploaded (OTel-populated,
 * extracted from <uploaded_files> tags in the prompt) — on an OTel-only
 * deployment (every current real instance), files_touched is always empty,
 * so files_uploaded is the only source that will ever have data.
 *
 * Counts every file entry (not distinct) — this is a volume signal, like
 * the native Desktop "files by type" card, not a coverage signal.
 *
 * Called by: /api/pulse/cio (fileCategoryMix in the response).
 */

import { gte, isNotNull, and, or } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';

export type FileCategory =
  | 'Code & scripts'
  | 'Web pages & styles'
  | 'Documents & reports'
  | 'Slides & decks'
  | 'Config & structured data'
  | 'Spreadsheets & tabular data'
  | 'Diagrams'
  | 'Other';

const EXTENSION_MAP: Record<string, FileCategory> = {
  // Code & scripts
  ts: 'Code & scripts', tsx: 'Code & scripts', js: 'Code & scripts', jsx: 'Code & scripts',
  py: 'Code & scripts', rb: 'Code & scripts', go: 'Code & scripts', rs: 'Code & scripts',
  java: 'Code & scripts', kt: 'Code & scripts', c: 'Code & scripts', cpp: 'Code & scripts',
  h: 'Code & scripts', cs: 'Code & scripts', sh: 'Code & scripts', ps1: 'Code & scripts',
  bat: 'Code & scripts', sql: 'Code & scripts', r: 'Code & scripts', ipynb: 'Code & scripts',
  // Web pages & styles
  html: 'Web pages & styles', htm: 'Web pages & styles', css: 'Web pages & styles',
  scss: 'Web pages & styles', sass: 'Web pages & styles', less: 'Web pages & styles',
  vue: 'Web pages & styles', svelte: 'Web pages & styles',
  // Documents & reports
  md: 'Documents & reports', mdx: 'Documents & reports', txt: 'Documents & reports',
  doc: 'Documents & reports', docx: 'Documents & reports', pdf: 'Documents & reports',
  rtf: 'Documents & reports', odt: 'Documents & reports',
  // Slides & decks
  ppt: 'Slides & decks', pptx: 'Slides & decks', key: 'Slides & decks', odp: 'Slides & decks',
  // Config & structured data
  json: 'Config & structured data', yaml: 'Config & structured data', yml: 'Config & structured data',
  toml: 'Config & structured data', xml: 'Config & structured data', ini: 'Config & structured data',
  env: 'Config & structured data', lock: 'Config & structured data', cfg: 'Config & structured data',
  conf: 'Config & structured data',
  // Spreadsheets & tabular data
  xls: 'Spreadsheets & tabular data', xlsx: 'Spreadsheets & tabular data', csv: 'Spreadsheets & tabular data',
  tsv: 'Spreadsheets & tabular data', ods: 'Spreadsheets & tabular data',
  // Diagrams
  svg: 'Diagrams', drawio: 'Diagrams', mmd: 'Diagrams', puml: 'Diagrams',
};

/** Categorise a file path by its final (lowercased) extension. No extension → Other. */
export function categorizeFilePath(p: string): FileCategory {
  const base = p.split(/[\\/]/).pop() ?? p;
  const dotIndex = base.lastIndexOf('.');
  if (dotIndex < 0) return 'Other'; // no extension at all, e.g. "Dockerfile"
  const ext = base.slice(dotIndex + 1).toLowerCase();
  if (!ext) return 'Other';
  return EXTENSION_MAP[ext] ?? 'Other';
}

/**
 * Org-wide files-by-category mix over the last `windowDays` days.
 * Counts every file entry across cowork_sessions.files_touched JSON arrays
 * (skipping NULL/invalid JSON rows). Sorted descending by count.
 */
export async function getFileCategoryMix(windowDays = 30): Promise<Array<{ category: FileCategory; count: number; share: number }>> {
  const client = await getTypedClient();
  const t = schema.coworkSessions;
  const now = Math.floor(Date.now() / 1000);
  const since = now - windowDays * 86400;

  const rows = await client
    .select({ files_touched: t.files_touched, files_uploaded: t.files_uploaded })
    .from(t)
    .where(and(
      gte(t.started_at, since),
      or(isNotNull(t.files_touched), isNotNull(t.files_uploaded)),
    ));

  const counts = new Map<FileCategory, number>();
  let total = 0;

  const countFileList = (json: string | null) => {
    if (!json) return;
    let files: unknown;
    try {
      files = JSON.parse(json);
    } catch {
      return;
    }
    if (!Array.isArray(files)) return;
    for (const f of files) {
      if (typeof f !== 'string') continue;
      const category = categorizeFilePath(f);
      counts.set(category, (counts.get(category) ?? 0) + 1);
      total++;
    }
  };

  for (const row of rows) {
    countFileList(row.files_touched);
    countFileList(row.files_uploaded);
  }

  if (total === 0) return [];

  return Array.from(counts.entries())
    .map(([category, count]) => ({ category, count, share: count / total }))
    .sort((a, b) => b.count - a.count);
}
