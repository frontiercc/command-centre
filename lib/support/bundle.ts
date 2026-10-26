// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The per-table row counts are read asynchronously and are
// moved BEFORE the `new Promise((resolve, reject) => {...})` executor (which
// can't itself be async — see the comment on the executor below), same
// treatment already given to the config-value reads.
//
// The db-stats block reports page_count/page_size/wal_pages as null — those
// storage-engine stats are not collected on Postgres.
import archiver from 'archiver';
import { Writable } from 'node:stream';
import { sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { queryErrorEvents } from '@/lib/db/error-queries';
import { getConfigValue } from '@/lib/config';
import { redactJson } from './redact';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Tables the support bundle reports row counts for, as Drizzle table objects
 * (keyed by the same literal names used in the bundled JSON) rather than raw
 * `SELECT COUNT(*) FROM ${table}` string interpolation — each key's value
 * keeps its own specific Drizzle type, so `.from(TABLE_SCHEMAS[table])` below
 * type-checks against the real per-table column shape with no cast needed.
 */
const TABLE_SCHEMAS = {
  cowork_messages: schema.coworkMessages,
  otel_events: schema.otelEvents,
  compliance_events: schema.complianceEvents,
  error_events: schema.errorEvents,
  config: schema.config,
} as const;

export async function generateSupportBundle(): Promise<Buffer> {
  // Reads happen up-front (async Drizzle); the archiver stream stays inside the
  // Promise executor, which cannot itself be async.
  const crashes = await queryErrorEvents({ severity: 'crash', limit: 50 });
  const errors = await queryErrorEvents({ limit: 100 });

  const [
    archiveEnabled, archiveProvider, archiveBucket, archiveRegion, archiveAccessKeyId, archiveSecretAccessKey,
    retentionCoworkDays, retentionOtelDays, retentionComplianceDays, retentionErrorDays,
    retentionMode, retentionLastRun, retentionLastResult,
  ] = await Promise.all([
    getConfigValue('archiveEnabled'),
    getConfigValue('archiveProvider'),
    getConfigValue('archiveBucket'),
    getConfigValue('archiveRegion'),
    getConfigValue('archiveAccessKeyId'),
    getConfigValue('archiveSecretAccessKey'),
    getConfigValue('retentionCoworkDays'),
    getConfigValue('retentionOtelDays'),
    getConfigValue('retentionComplianceDays'),
    getConfigValue('retentionErrorDays'),
    getConfigValue('retentionMode'),
    getConfigValue('retentionLastRun'),
    getConfigValue('retentionLastResult'),
  ]);

  const client = await getTypedClient();

  // Conversion — per-table row counts (was a prepared-statement .get() loop).
  const tableCounts: Record<string, number> = {};
  for (const table of Object.keys(TABLE_SCHEMAS) as Array<keyof typeof TABLE_SCHEMAS>) {
    try {
      const rows = await client.select({ count: sql<number | string>`count(*)` }).from(TABLE_SCHEMAS[table]);
      tableCounts[table] = Number(rows[0]?.count ?? 0);
    } catch {
      tableCounts[table] = -1;
    }
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const writable = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
    });

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(writable);

    writable.on('finish', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);

    // 1. crash.log — last 50 crash events from DB
    const crashLog = crashes.events.map(e => {
      let line = `[${new Date(e.occurred_at * 1000).toISOString()}] [${e.severity.toUpperCase()}] [${e.source}] ${e.message}`;
      if (e.stack_trace) line += '\n' + e.stack_trace.split('\n').map(l => `  ${l}`).join('\n');
      return line;
    }).join('\n\n');
    archive.append(crashLog || '(no crash events)', { name: 'crash.log' });

    // 2. error-events.json — last 100 events, all severities
    archive.append(JSON.stringify(errors.events, null, 2), { name: 'error-events.json' });

    // 3. db-stats.json
    // page_count/page_size/wal_pages are not collected on Postgres (kept as
    // null). The per-table row counts (tableCounts) come from getTypedClient.
    const dbStats: Record<string, unknown> = { tables: tableCounts };
    dbStats.page_count = null;
    dbStats.page_size = null;
    dbStats.wal_pages = null;
    archive.append(JSON.stringify(dbStats, null, 2), { name: 'db-stats.json' });

    // 4. system-info.json
    let cccVersion = '0.1.0';
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'));
      cccVersion = pkg.version || cccVersion;
    } catch { /* fallback to default */ }
    archive.append(JSON.stringify({
      ccc_version: cccVersion,
      node_version: process.version,
      platform: os.platform(),
      os_release: os.release(),
      uptime_seconds: os.uptime(),
      hostname: os.hostname(),
    }, null, 2), { name: 'system-info.json' });

    // 5. archive-config.json — redacted
    const archiveConfig = {
      archiveEnabled, archiveProvider, archiveBucket, archiveRegion, archiveAccessKeyId, archiveSecretAccessKey,
    };
    archive.append(JSON.stringify(redactJson(archiveConfig), null, 2), { name: 'archive-config.json' });

    // 6. retention-config.json
    const retentionConfig = {
      retentionCoworkDays, retentionOtelDays, retentionComplianceDays, retentionErrorDays,
      retentionMode, retentionLastRun, retentionLastResult,
    };
    archive.append(JSON.stringify(retentionConfig, null, 2), { name: 'retention-config.json' });

    archive.finalize();
  });
}
