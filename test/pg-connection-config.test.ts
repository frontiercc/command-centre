// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The scheduler leader election opens its own pg.Client, outside the app
// pool. It must connect exactly as the pool does — RDS requires TLS and the
// CCC_PG_SSL mapping decides how — so the config is a single shared function
// rather than a second copy that could drift.
import { describe, it, expect, afterEach } from 'vitest';
import { pgConnectionConfig } from '@/lib/db/client';

const originalUrl = process.env.DATABASE_URL;
const originalSsl = process.env.CCC_PG_SSL;

afterEach(() => {
  if (originalUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalUrl;
  if (originalSsl === undefined) delete process.env.CCC_PG_SSL;
  else process.env.CCC_PG_SSL = originalSsl;
});

describe('pgConnectionConfig', () => {
  it('carries DATABASE_URL and verifies TLS by default', () => {
    process.env.DATABASE_URL = 'postgresql://ccc:pw@db.example:5432/ccc';
    delete process.env.CCC_PG_SSL;
    expect(pgConnectionConfig()).toEqual({
      connectionString: 'postgresql://ccc:pw@db.example:5432/ccc',
      ssl: { rejectUnauthorized: true },
    });
  });

  it('disables TLS only for the literal "disable"', () => {
    process.env.DATABASE_URL = 'postgresql://ccc:pw@localhost:5432/ccc';
    process.env.CCC_PG_SSL = 'disable';
    expect(pgConnectionConfig().ssl).toBeUndefined();
  });

  it('keeps TLS but skips verification for "no-verify"', () => {
    process.env.DATABASE_URL = 'postgresql://ccc:pw@localhost:5432/ccc';
    process.env.CCC_PG_SSL = 'no-verify';
    expect(pgConnectionConfig().ssl).toEqual({ rejectUnauthorized: false });
  });
});
