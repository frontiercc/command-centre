// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Which vendors count as connected (lib/sources/connected.ts): Claude from any
// Claude data or a Claude key, never the Anthropic API key alone; OpenAI from
// its key or any ChatGPT or Codex data.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;
let getConnectedProducts: typeof import('@/lib/sources/connected').getConnectedProducts;
let isOpenAiOnly: typeof import('@/lib/sources/connected').isOpenAiOnly;
let setConfigValue: typeof import('@/lib/config').setConfigValue;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
  ({ getConnectedProducts, isOpenAiOnly } = await import('@/lib/sources/connected'));
  ({ setConfigValue } = await import('@/lib/config'));
});

afterAll(async () => cleanup());

const savedKey = process.env.ANTHROPIC_AI_API_KEY;
beforeEach(async () => {
  await sql.exec(`DELETE FROM config; DELETE FROM cowork_messages; DELETE FROM code_otel_metrics;`);
  if (savedKey === undefined) delete process.env.ANTHROPIC_AI_API_KEY; else process.env.ANTHROPIC_AI_API_KEY = savedKey;
});

const msg = (id: string, surface: string, source: string | null) =>
  sql.run(`INSERT INTO cowork_messages (id, session_id, message_type, occurred_at, surface, source) VALUES (?, 's', 'cowork_user_message', 1, ?, ?)`, [id, surface, source]);

describe('getConnectedProducts', () => {
  it('a fresh install has nothing connected, and reads as Claude', async () => {
    const c = await getConnectedProducts();
    expect(c).toEqual({ claude: false, openai: false });
    expect(isOpenAiOnly(c)).toBe(false);
  });

  it('the Anthropic API key alone does not connect Claude', async () => {
    await setConfigValue('anthropicAiApiKey', 'sk-ant-test');
    await setConfigValue('openaiAdminApiKey', 'sk-admin-test');
    const c = await getConnectedProducts();
    expect(c).toEqual({ claude: false, openai: true });
    expect(isOpenAiOnly(c)).toBe(true);
  });

  it('ChatGPT or Codex data alone is OpenAI only', async () => {
    await msg('o1', 'code', 'codex');
    expect(await getConnectedProducts()).toEqual({ claude: false, openai: true });
  });

  it('Claude data, Claude metrics or a Claude key connect Claude', async () => {
    await msg('o1', 'cowork', 'chatgpt_work');
    await msg('c1', 'cowork', 'otel');
    expect(await getConnectedProducts()).toEqual({ claude: true, openai: true });

    await sql.exec(`DELETE FROM cowork_messages;`);
    await msg('o1', 'cowork', 'chatgpt_chat');
    await sql.run(`INSERT INTO code_otel_metrics (id, user_id, metric_name, value, occurred_at) VALUES ('m1', 'u1', 'claude_code.lines_of_code.count', 1, 1)`);
    expect((await getConnectedProducts()).claude).toBe(true);

    await sql.exec(`DELETE FROM code_otel_metrics;`);
    expect((await getConnectedProducts()).claude).toBe(false);
    await setConfigValue('complianceAccessKey', 'sk-ant-api01-test');
    expect(await getConnectedProducts()).toEqual({ claude: true, openai: true });
  });
});
