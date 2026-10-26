// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';
import { jsonText, type TestSql } from './helpers/sql';

// createTestDatabase resets the module cache, so we must dynamic-import the receiver
// inside beforeAll (see test/otel-code-receiver.test.ts for the same pattern).
let sql: TestSql;
let cleanup: () => Promise<void>;
let processOtlpLogs: (payload: unknown) => Promise<{
  logsInserted: number;
  skipped: number;
  alertsFired: number;
  errors: string[];
}>;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;

  const mod = await import('@/lib/otel/cowork-receiver');
  processOtlpLogs = mod.processOtlpLogs;
});

afterAll(async () => cleanup());

const TEST_EMAIL = 'finops-test@example.com';
const TEST_USER_ID = 'usr_finops01';
const TEST_SESSION_ID = 'sess_finops_001';
const TEST_PROMPT_ID = 'prompt_finops_001';

function makePayload(eventName: string, attrs: Record<string, string | number> = {}) {
  return {
    resourceLogs: [{
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: 'cowork' } },
          { key: 'user.email', value: { stringValue: TEST_EMAIL } },
          { key: 'user.id', value: { stringValue: TEST_USER_ID } },
          { key: 'organization.id', value: { stringValue: 'org_test' } },
        ]
      },
      scopeLogs: [{
        logRecords: [{
          attributes: [
            { key: 'event.name', value: { stringValue: eventName } },
            { key: 'session.id', value: { stringValue: TEST_SESSION_ID } },
            { key: 'prompt.id', value: { stringValue: TEST_PROMPT_ID } },
            ...Object.entries(attrs).map(([key, value]) => ({
              key,
              value: typeof value === 'number'
                ? { doubleValue: value }
                : { stringValue: value as string },
            }))
          ],
          timeUnixNano: '1750000000000000000'
        }]
      }]
    }]
  };
}

describe('finance: cowork_messages.token_usage persisted at OTel ingest', () => {
  it('persists inputTokens/outputTokens/cacheReadTokens/cacheCreationTokens on claude_code.api_request', async () => {
    const result = await processOtlpLogs(
      makePayload('claude_code.api_request', {
        input_tokens: 1000,
        output_tokens: 200,
        cache_read_tokens: 50,
        cache_creation_tokens: 10,
        cost_usd: 0.01,
        model: 'claude-haiku-4-5',
      }),
    );
    expect(result.logsInserted).toBe(1);

    const row = await sql.get(
      "SELECT * FROM cowork_messages WHERE message_type = 'cowork_api_request' AND prompt_id = ?",
      [TEST_PROMPT_ID]) as { token_usage: unknown } | undefined;

    expect(row).toBeTruthy();
    expect(row!.token_usage).toBeTruthy();
    expect(JSON.parse(jsonText(row!.token_usage))).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 50,
      cacheCreationTokens: 10,
    });
  });
});
