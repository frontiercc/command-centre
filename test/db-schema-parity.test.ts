// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// AUTHORITATIVE drift guard for the Postgres schema.
//
// Migrates a fresh Postgres database from lib/db/migrations-pg — the measured
// "migration end-state" — and asserts the Drizzle Postgres schema declares
// EXACTLY the same tables + columns. Also guards the partial weekly-history
// unique indexes, and that the audit Drizzle schema matches the
// access_audit_log table getAuditClient() bootstraps.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { getTableColumns, getTableName, type Table } from 'drizzle-orm';
import { getTableConfig as getPgTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { schema, pgSchema } from '@/lib/db/schema';
import { auditSchema, auditPgSchema } from '@/lib/db/schema-audit';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

const tableName = (t: Table) => getTableName(t);
type Row = { name: string };

let sql: TestSql;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const t = await createTestDatabase();
  sql = t.sql;
  cleanup = t.cleanup;
});

afterAll(async () => cleanup());

async function liveColumns(table: string): Promise<string[]> {
  const rows = await sql.all<Row>(
    `SELECT column_name AS name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ?`,
    [table],
  );
  return rows.map((r) => r.name);
}

describe('drizzle schema ↔ Postgres migration end-state parity', () => {
  it('schema is the Postgres schema', () => {
    expect(schema).toBe(pgSchema);
  });

  it('declares exactly the same tables as the migration end-state', async () => {
    // access_audit_log is the audit schema's table (guarded below), created by
    // getAuditClient() rather than the migrations.
    const actual = new Set(
      (
        await sql.all<Row>(
          `SELECT table_name AS name FROM information_schema.tables
            WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
              AND table_name <> 'access_audit_log'`,
        )
      ).map((r) => r.name),
    );
    const declared = new Set(Object.values(pgSchema).map((t) => tableName(t)));
    expect([...declared].sort()).toEqual([...actual].sort());
  });

  it('declares exactly the same columns per table (incl. generated columns)', async () => {
    // information_schema.columns lists generated columns alongside ordinary
    // ones, so a generated column like pulse_team_assessments.checklist_score
    // can't silently drop out of both the migrations AND the Drizzle schema.
    for (const table of Object.values(pgSchema)) {
      const name = tableName(table);
      const cols = await liveColumns(name);
      const declared = Object.values(getTableColumns(table)).map((c) => c.name);
      expect({ table: name, cols: [...declared].sort() }).toEqual({
        table: name,
        cols: [...cols].sort(),
      });
    }
  });
});

// The two weekly-history unique indexes are PARTIAL (`WHERE granularity =
// 'week'`) because each metric table holds BOTH a 'rolling' snapshot row AND
// 'week' history rows for the same (scope_type, scope_id, period_start) — a
// FULL unique index would forbid the second 'rolling' upsert and throw. This
// block guards that the partial predicate is declared in the Drizzle schema,
// emitted into the generated Postgres migrations AND present in the migrated
// database, so a full-vs-partial divergence (the class of bug that forced a
// per-writer ON CONFLICT workaround in lib/pulse/aggregator.ts) fails loudly.
describe('partial unique-index predicate parity (pulse_metrics + code_metrics week indexes)', () => {
  const WEEK_INDEXES = [
    { key: 'codeMetrics', index: 'idx_code_metrics_week', sqlTable: 'code_metrics' },
    { key: 'pulseMetrics', index: 'idx_pulse_metrics_week', sqlTable: 'pulse_metrics' },
  ] as const;
  const PREDICATE = /granularity\s*=\s*'week'/i;

  for (const { key, index: indexName, sqlTable } of WEEK_INDEXES) {
    it(`${indexName} is declared PARTIAL in the Postgres Drizzle schema`, () => {
      const table = (pgSchema as Record<string, Table>)[key];
      const cfg = getPgTableConfig(table);
      const idx = cfg.indexes.find((i) => i.config.name === indexName);
      expect(idx, `${indexName} not found on pgSchema.${key}`).toBeDefined();
      expect(idx!.config.unique).toBe(true);
      expect(idx!.config.where, `${indexName} must be a PARTIAL index (missing .where())`).toBeDefined();
      const predicate = new PgDialect().sqlToQuery(idx!.config.where!).sql;
      expect(predicate).toMatch(PREDICATE);
    });

    it(`${indexName} is emitted PARTIAL in the generated Postgres migration baseline`, () => {
      const dir = 'lib/db/migrations-pg';
      const pgSql = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.sql'))
        .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
        .join('\n');
      // Every CREATE UNIQUE INDEX for this name in the baseline must carry the
      // partial WHERE predicate; a FULL (predicate-less) create must not exist.
      const createRe = new RegExp(`CREATE UNIQUE INDEX "${indexName}"[^;]*`, 'gi');
      const creates = pgSql.match(createRe) ?? [];
      expect(creates.length, `no CREATE UNIQUE INDEX for ${indexName} in ${dir}`).toBeGreaterThan(0);
      for (const stmt of creates) {
        expect(stmt, `${indexName} emitted FULL (no WHERE) in ${dir}`).toMatch(PREDICATE);
      }
    });

    it(`${indexName} is PARTIAL in the migrated Postgres database`, async () => {
      const row = await sql.get<{ def: string }>(
        `SELECT indexdef AS def FROM pg_indexes
          WHERE schemaname = current_schema() AND tablename = ? AND indexname = ?`,
        [sqlTable, indexName],
      );
      expect(row?.def, `${indexName} missing on ${sqlTable} in the migrated DB`).toBeDefined();
      expect(row!.def, `${indexName} is FULL in the migrated DB (expected partial)`).toMatch(
        PREDICATE
      );
    });
  }
});

describe('audit schema parity', () => {
  it('auditSchema is the Postgres audit schema', () => {
    expect(auditSchema).toBe(auditPgSchema);
  });

  it('pg audit schema matches the access_audit_log columns getAuditClient() creates', async () => {
    const { getAuditClient } = await import('@/lib/db/client');
    await getAuditClient();
    const cols = await liveColumns('access_audit_log');
    const declared = Object.values(getTableColumns(auditPgSchema.accessAuditLog)).map((c) => c.name);
    expect([...declared].sort()).toEqual([...cols].sort());
  });
});
