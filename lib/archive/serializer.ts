// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { gzipSync } from 'node:zlib';

interface ArchiveRow {
  [key: string]: unknown;
  occurred_at: number;
}

export function serializeToJsonlGzip(tableName: string, rows: ArchiveRow[]): Buffer {
  const lines = rows.map(row => {
    const enriched = {
      _table: tableName,
      ...row,
      occurred_at_iso: new Date(row.occurred_at * 1000).toISOString(),
    };
    return JSON.stringify(enriched);
  });

  const jsonl = lines.join('\n') + '\n';
  return gzipSync(Buffer.from(jsonl, 'utf-8'));
}

export function buildArchiveKey(tableName: string, rows: ArchiveRow[], cutoffTimestamp: number): string {
  const minTs = Math.min(...rows.map(r => r.occurred_at));
  const minDate = new Date(minTs * 1000).toISOString().slice(0, 10);
  const cutoffDate = new Date(cutoffTimestamp * 1000).toISOString().slice(0, 10);
  return `ccc-archive/${tableName}/${minDate}_to_${cutoffDate}.jsonl.gz`;
}

export interface ArchiveManifest {
  run_at: string;
  ccc_version: string;
  mode: 'strip' | 'purge';
  retention_policy: Record<string, number>;
  tables: Record<string, { rows: number; file: string | null }>;
}

export function buildManifest(
  mode: 'strip' | 'purge',
  retentionPolicy: Record<string, number>,
  tableResults: Record<string, { rows: number; file: string | null }>,
  version: string
): ArchiveManifest {
  return {
    run_at: new Date().toISOString(),
    ccc_version: version,
    mode,
    retention_policy: retentionPolicy,
    tables: tableResults,
  };
}
