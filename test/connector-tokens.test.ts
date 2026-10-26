// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;
let tokens: typeof import('@/lib/connector/tokens');

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
  tokens = await import('@/lib/connector/tokens');
});

afterAll(async () => cleanup());

describe('connector token lifecycle', () => {
  it('mint returns a plaintext token (43+ chars) and a record', async () => {
    const { token, record } = await tokens.mintConnectorToken('CI pipeline');
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(record.name).toBe('CI pipeline');
    expect(record.id).toBeTruthy();
    expect(record.createdAt).toBeGreaterThan(0);
    expect(record.lastUsedAt).toBeNull();
    expect(record.revokedAt).toBeNull();
  });

  it('never persists the plaintext token', async () => {
    const { token } = await tokens.mintConnectorToken('no-plaintext-check');
    const row = (await sql.get('SELECT token_hash FROM connector_tokens WHERE name = ?', ['no-plaintext-check'])) as { token_hash: string };
    expect(row.token_hash).not.toBe(token);
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex digest
  });

  it('verify(minted) returns the record and bumps last_used_at', async () => {
    const { token, record } = await tokens.mintConnectorToken('verify-me');
    expect(record.lastUsedAt).toBeNull();

    const verified = await tokens.verifyConnectorToken(token);
    expect(verified).not.toBeNull();
    expect(verified?.id).toBe(record.id);
    expect(verified?.lastUsedAt).toBeGreaterThan(0);
  });

  it('verify accepts a raw token or a "Bearer <token>" string', async () => {
    const { token, record } = await tokens.mintConnectorToken('bearer-form');
    const viaBearer = await tokens.verifyConnectorToken(`Bearer ${token}`);
    expect(viaBearer?.id).toBe(record.id);
  });

  it('verify accepts the Bearer scheme case-insensitively (RFC 7235)', async () => {
    const { token, record } = await tokens.mintConnectorToken('bearer-case-insensitive');
    expect((await tokens.verifyConnectorToken(`bearer ${token}`))?.id).toBe(record.id);
    expect((await tokens.verifyConnectorToken(`BEARER ${token}`))?.id).toBe(record.id);
    expect((await tokens.verifyConnectorToken(`BeArEr ${token}`))?.id).toBe(record.id);
  });

  it('verify returns null for garbage, missing, or unknown tokens', async () => {
    expect(await tokens.verifyConnectorToken('garbage-not-a-real-token')).toBeNull();
    expect(await tokens.verifyConnectorToken(null)).toBeNull();
    expect(await tokens.verifyConnectorToken(undefined)).toBeNull();
    expect(await tokens.verifyConnectorToken('')).toBeNull();
  });

  it('verify returns null for a revoked token', async () => {
    const { token, record } = await tokens.mintConnectorToken('to-be-revoked');
    expect(await tokens.revokeConnectorToken(record.id)).toBe(true);
    expect(await tokens.verifyConnectorToken(token)).toBeNull();
  });

  it('list never exposes token hashes and reflects mint/revoke state', async () => {
    const { record } = await tokens.mintConnectorToken('list-me');
    const list = await tokens.listConnectorTokens();
    const entry = list.find((r) => r.id === record.id);
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty('token_hash');
    expect(entry).not.toHaveProperty('tokenHash');
    expect(Object.keys(entry as object).sort()).toEqual(
      ['createdAt', 'id', 'lastUsedAt', 'name', 'revokedAt'].sort()
    );
  });

  it('revoke is idempotent: true once, false thereafter, false for unknown id', async () => {
    const { record } = await tokens.mintConnectorToken('idempotent-revoke');
    expect(await tokens.revokeConnectorToken(record.id)).toBe(true);
    expect(await tokens.revokeConnectorToken(record.id)).toBe(false);
    expect(await tokens.revokeConnectorToken('does-not-exist')).toBe(false);
  });
});
