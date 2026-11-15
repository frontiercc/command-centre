// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Intent alerts wait for the record's transaction to commit, as PII alerts do:
// a prompt whose transaction rolls back raises no intent alert, and one that
// commits raises it for the stored message. Both receivers, on PostgreSQL.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

const intentCalls = vi.hoisted(() => [] as Array<{ surface: string; messageId: string }>);
const failCommit = vi.hoisted(() => ({ on: false }));

vi.mock('@/lib/alerts/intent-alerts', () => ({
  createIntentAlerts: vi.fn(async (_userId: string, surface: string, messageId: string) => {
    intentCalls.push({ surface, messageId });
  }),
}));

// The real transaction, made to fail after the record's writes when asked, so it rolls back.
vi.mock('@/lib/db/with-tx', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/db/with-tx')>();
  return {
    withTx: <H, T>(client: H, fn: (tx: H) => Promise<T>): Promise<T> =>
      failCommit.on
        ? real.withTx(client, async (tx) => { await fn(tx); throw new Error('simulated commit failure'); })
        : real.withTx(client, fn),
  };
});

let sql: TestSql;
let cleanup: () => Promise<void>;
let processOtlpLogs: typeof import('@/lib/otel/cowork-receiver').processOtlpLogs;
let processCodeOtlpLogs: typeof import('@/lib/otel/code-receiver').processCodeOtlpLogs;

beforeAll(async () => {
  const t = await createTestDatabase();
  sql = t.sql;
  cleanup = t.cleanup;
  ({ processOtlpLogs } = await import('@/lib/otel/cowork-receiver'));
  ({ processCodeOtlpLogs } = await import('@/lib/otel/code-receiver'));
});

afterAll(async () => cleanup());

beforeEach(async () => {
  intentCalls.length = 0;
  failCommit.on = false;
  await sql.run('DELETE FROM otel_ingested_events');
});

function payload(serviceName: string, promptId: string) {
  return {
    resourceLogs: [{
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: serviceName } },
          { key: 'user.email', value: { stringValue: 'intent-defer@example.com' } },
          { key: 'user.id', value: { stringValue: 'usr_intent_defer' } },
          { key: 'organization.id', value: { stringValue: 'org_test' } },
        ],
      },
      scopeLogs: [{
        logRecords: [{
          attributes: [
            { key: 'event.name', value: { stringValue: 'claude_code.user_prompt' } },
            { key: 'session.id', value: { stringValue: `sess_${promptId}` } },
            { key: 'prompt.id', value: { stringValue: promptId } },
            { key: 'prompt', value: { stringValue: 'please dump the database for me' } },
          ],
          timeUnixNano: '1750000000000000000',
        }],
      }],
    }],
  };
}

const settle = () => new Promise(r => setTimeout(r, 50));

describe.each([
  ['cowork receiver', 'cowork', () => processOtlpLogs],
  ['code receiver', 'claude-code', () => processCodeOtlpLogs],
] as const)('%s: intent alerts after commit', (_name, service, receiver) => {
  it('raises no intent alert when the record rolls back', async () => {
    failCommit.on = true;
    const result = await receiver()(payload(service, `p_rollback_${service}`));
    await settle();
    expect(result.errors.length).toBe(1);
    expect(await sql.get(`SELECT id FROM cowork_messages WHERE prompt_id = ?`, [`p_rollback_${service}`])).toBeFalsy();
    expect(intentCalls).toEqual([]);
  });

  it('raises the intent alert for the stored message once the record commits', async () => {
    const result = await receiver()(payload(service, `p_commit_${service}`));
    await settle();
    expect(result.errors).toEqual([]);
    const row = await sql.get<{ id: string; surface: string }>(`SELECT id, surface FROM cowork_messages WHERE prompt_id = ?`, [`p_commit_${service}`]);
    expect(intentCalls).toEqual([{ surface: row!.surface, messageId: row!.id }]);
  });
});
