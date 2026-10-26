// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The pg Pool MUST carry an 'error' listener. node-postgres emits 'error' on
// the Pool when an IDLE client's backend connection dies (RDS failover /
// maintenance kill = FATAL 57P01, or a testcontainer stopping in CI) — with
// no listener that is an unhandled 'error' event, which crashes the process
// in production and fails the vitest run in CI (observed: the Postgres CI
// leg failing with 57P01 "terminating connection due to administrator
// command" attributed to queries-cowork-chat-gdpr-pg.test.ts, all 82 tests
// green). Pool construction is lazy (no connection until first query), so a
// dummy connection string is safe here.
import { describe, it, expect } from 'vitest';
import { Pool } from 'pg';
import { buildPgPool } from '@/lib/db/client';

describe('buildPgPool', () => {
  it('attaches an error listener so an idle-client death never becomes an unhandled error', () => {
    const pool = buildPgPool(Pool);
    try {
      expect(pool.listenerCount('error')).toBeGreaterThanOrEqual(1);
    } finally {
      void pool.end();
    }
  });

  it('the handler swallows an emitted idle-client error (no throw)', () => {
    const pool = buildPgPool(Pool);
    try {
      // With no listener this line would THROW (Node's unhandled 'error'
      // semantics) — the assertion is that it does not.
      expect(() => pool.emit('error', new Error('terminating connection due to administrator command'))).not.toThrow();
    } finally {
      void pool.end();
    }
  });
});
