// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Database TLS is decided by CCC_PG_SSL when set, otherwise by the address:
// the bundled database and this machine get none, anything else gets
// verified TLS. scripts/pg-ssl.mjs must give the same answers.
import { describe, it, expect } from 'vitest';
import { resolvePgSslMode, pgSslOption } from '@/lib/db/pg-ssl';
import * as script from '../scripts/pg-ssl.mjs';

const BUNDLED = 'postgresql://ccc:pw@postgres:5432/ccc';
const MANAGED = 'postgresql://ccc:pw@db.abc123.eu-west-2.rds.amazonaws.com:5432/ccc';

const cases: Array<[string | undefined, string | undefined, string]> = [
  [undefined, BUNDLED, 'disable'],
  ['', BUNDLED, 'disable'],
  [undefined, 'postgresql://ccc:pw@localhost:5432/ccc', 'disable'],
  [undefined, 'postgresql://ccc:pw@127.0.0.1:5432/ccc', 'disable'],
  [undefined, 'postgresql://ccc:pw@[::1]:5432/ccc', 'disable'],
  [undefined, MANAGED, 'require'],
  ['', MANAGED, 'require'],
  [undefined, 'postgresql://ccc:pw@myserver.postgres.database.azure.com:5432/ccc', 'require'],
  [undefined, 'not a url', 'require'],
  [undefined, undefined, 'require'],
  ['disable', MANAGED, 'disable'],
  ['require', BUNDLED, 'require'],
  ['no-verify', MANAGED, 'no-verify'],
  [' REQUIRE ', BUNDLED, 'require'],
  ['true', BUNDLED, 'require'],
];

describe('database TLS', () => {
  it.each(cases)('CCC_PG_SSL=%j with %s gives %s', (setting, url, expected) => {
    expect(resolvePgSslMode(setting, url)).toBe(expected);
    expect(script.resolvePgSslMode(setting, url)).toBe(expected);
  });

  it('maps each mode to the pg ssl option', () => {
    expect(pgSslOption(undefined, BUNDLED)).toBeUndefined();
    expect(pgSslOption(undefined, MANAGED)).toEqual({ rejectUnauthorized: true });
    expect(pgSslOption('no-verify', MANAGED)).toEqual({ rejectUnauthorized: false });
    expect(script.pgSslOption(undefined, MANAGED)).toEqual({ rejectUnauthorized: true });
  });
});
