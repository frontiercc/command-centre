// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Raw SQL for tests: seed and inspect the test database directly.
//
//   const { sql, cleanup } = await createTestDatabase();
//   await sql.run('INSERT INTO users (id, email) VALUES (?, ?)', ['u1', 'a@b.c']);
//   const row = await sql.get<{ c: number }>('SELECT COUNT(*) AS c FROM users');
//
// `?` placeholders are rewritten to $1..$n, so SQL reads the same as a
// prepared statement; bind timestamps rather than computing them in SQL.
//
// Reads through THIS helper parse Postgres int8/numeric results as numbers
// (per query, via pg's `types` option), so `COUNT(*)` compares equal to a
// number. That parsing never reaches application code,
// which still sees Postgres's strings: the app's own handling of them is
// what the tests are checking.
import type { Pool, QueryResultRow } from 'pg';

export type Params = ReadonlyArray<unknown>;

export interface TestSql {
  /** One or more statements, no parameters. */
  exec(text: string): Promise<void>;
  run(text: string, params?: Params): Promise<void>;
  get<T = Record<string, unknown>>(text: string, params?: Params): Promise<T | undefined>;
  all<T = Record<string, unknown>>(text: string, params?: Params): Promise<T[]>;
}

/** Rewrite `?` placeholders to `$1..$n`, leaving quoted text alone. */
export function toPgPlaceholders(text: string): string {
  let out = '';
  let n = 0;
  let quote: string | null = null;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === '?') {
      out += `$${++n}`;
      continue;
    }
    out += ch;
  }
  return out;
}

const INT8_OID = 20;
const NUMERIC_OID = 1700;

// Postgres int8/numeric → number for test reads only. Anything else keeps
// pg's default parsing.
async function testTypes() {
  const pg = await import('pg');
  return {
    getTypeParser(oid: number, format?: 'text' | 'binary') {
      if (oid === INT8_OID || oid === NUMERIC_OID) {
        return (v: string) => (v === null ? null : Number(v));
      }
      return pg.types.getTypeParser(oid, format as 'text');
    },
  };
}

export function pgTestSql(pool: Pool): TestSql {
  let types: Awaited<ReturnType<typeof testTypes>> | null = null;
  async function query<T extends QueryResultRow>(text: string, params: Params) {
    types ??= await testTypes();
    return pool.query<T>({ text: toPgPlaceholders(text), values: [...params], types });
  }
  return {
    async exec(text) {
      await pool.query(text);
    },
    async run(text, params = []) {
      await query(text, params);
    },
    async get<T>(text: string, params: Params = []) {
      const { rows } = await query<QueryResultRow>(text, params);
      return rows[0] as T | undefined;
    },
    async all<T>(text: string, params: Params = []) {
      const { rows } = await query<QueryResultRow>(text, params);
      return rows as T[];
    },
  };
}

/**
 * A JSON column's value as compact JSON text: pg parses jsonb into an object
 * (and Postgres's own ::text form adds spaces after ':' and ','), so
 * re-serialise it; a text column's string passes through unchanged.
 */
export function jsonText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}
