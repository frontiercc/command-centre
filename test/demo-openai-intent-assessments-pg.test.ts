// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The sample data's written assessments for the intent alerts its ChatGPT and
// Codex prompts raise (scripts/demo/openai-intent-assessments.ts): the Hub's
// no-key fallback is replaced, a model's own assessment and every real alert
// are left alone.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

const config = vi.hoisted(() => ({ key: '' }));
vi.mock('@/lib/config', () => ({
  getConfigValue: vi.fn(async (k: string) => (k === 'anthropicAiApiKey' ? config.key : '')),
}));
vi.mock('@/lib/anthropic/client', () => ({
  createAnthropicClient: vi.fn(() => ({ messages: { create: vi.fn().mockRejectedValue(new Error('down')) } })),
}));
vi.mock('@/lib/anthropic/model', () => ({ getCoreAiModel: vi.fn(async () => 'test-model') }));
vi.mock('@/lib/ingestion/scheduler', () => ({ queueAiCall: vi.fn((fn: () => Promise<unknown>) => fn()) }));

let sql: TestSql;
let cleanup: () => Promise<void>;
let mod: typeof import('../scripts/demo/openai-intent-assessments');
let createIntentAlerts: typeof import('../lib/alerts/intent-alerts').createIntentAlerts;
let assessIntent: typeof import('../lib/intent/assess').assessIntent;
const NOW = Math.floor(Date.now() / 1000);

const match = (categoryId: string, categoryName: string, defaultSeverity: 'medium' | 'high' | 'critical') =>
  [{ categoryId, categoryName, matchedPhrases: ['x'], defaultSeverity }];

async function prompt(id: string, userId: string, source: string, surface: string) {
  await sql.run(
    `INSERT INTO cowork_messages (id, session_id, user_id, message_type, occurred_at, surface, source, flagged, flag_reason)
     VALUES (?, ?, ?, 'cowork_user_message', ?, ?, ?, 1, 'Intent detected: x')`,
    [id, id, userId, NOW, surface, source]);
}

beforeAll(async () => {
  const t = await createTestDatabase();
  sql = t.sql; cleanup = t.cleanup;
  mod = await import('../scripts/demo/openai-intent-assessments');
  createIntentAlerts = (await import('../lib/alerts/intent-alerts')).createIntentAlerts;
  assessIntent = (await import('../lib/intent/assess')).assessIntent;
  await sql.run(`INSERT INTO users (id, email) VALUES ('acme', 'jo@acmecorp.example'), ('real', 'sam@realco.example')`);
});
afterAll(async () => cleanup());

describe('sample ChatGPT and Codex intent assessments', () => {
  it('knows the fallback reasoning assessIntent stores with no key and when the call fails', async () => {
    config.key = '';
    expect(mod.FALLBACK_REASONINGS).toContain((await assessIntent('t', match('shadow_it', 'Shadow IT', 'high'))).reasoning);
    config.key = 'test-key';
    expect(mod.FALLBACK_REASONINGS).toContain((await assessIntent('t', match('shadow_it', 'Shadow IT', 'high'))).reasoning);
    config.key = '';
  });

  it('replaces the no-key fallback on sample alerts only, and keeps a model-written assessment', async () => {
    await prompt('gpt-1', 'acme', 'chatgpt_work', 'cowork');
    await prompt('codex-1', 'acme', 'codex', 'code');
    await prompt('gpt-model', 'acme', 'chatgpt_chat', 'cowork');
    await prompt('real-1', 'real', 'chatgpt_chat', 'cowork');
    await createIntentAlerts('acme', 'cowork', 'gpt-1', 't', match('reconnaissance', 'Reconnaissance', 'medium'), 'ChatGPT Work');
    await createIntentAlerts('acme', 'code', 'codex-1', 't', match('shadow_it', 'Shadow IT', 'high'), 'Codex');
    await createIntentAlerts('real', 'cowork', 'real-1', 't', match('shadow_it', 'Shadow IT', 'high'), 'ChatGPT Chat');
    // As the Hub writes it when a key was configured during the load.
    const modelWritten = { severity: 'low', reasoning: 'Routine export to an approved tool.', recommended_action: 'None.' };
    await sql.run(
      `INSERT INTO alerts (id, user_id, alert_type, severity, title, explanation, raw_evidence)
       VALUES ('a-model', 'acme', 'intent', 'low', 'Shadow IT intent detected in ChatGPT Chat', ?, ?::jsonb)`,
      [modelWritten.reasoning, JSON.stringify({ message_id: 'gpt-model', intent_category: 'shadow_it', ai_assessment: modelWritten })]);

    const result = await mod.writeSampleIntentAssessments({ waitMs: 0 });
    expect(result).toMatchObject({ written: 2, kept: 1 });

    const rows = await sql.all<{ message_id: string; severity: string; explanation: string; ai: { severity: string; reasoning: string; recommended_action: string } }>(
      `SELECT raw_evidence->>'message_id' AS message_id, severity, explanation, raw_evidence->'ai_assessment' AS ai FROM alerts WHERE alert_type = 'intent'`);
    const by = Object.fromEntries(rows.map(r => [r.message_id, r]));

    const recon = mod.SAMPLE_INTENT_ASSESSMENTS.reconnaissance;
    expect(by['gpt-1']).toMatchObject({ severity: recon.severity, explanation: recon.reasoning, ai: recon });
    expect(by['codex-1']).toMatchObject({ explanation: mod.SAMPLE_INTENT_ASSESSMENTS.shadow_it.reasoning, ai: mod.SAMPLE_INTENT_ASSESSMENTS.shadow_it });
    expect(by['gpt-model']).toMatchObject({ severity: 'low', explanation: modelWritten.reasoning, ai: modelWritten });
    // Not a sample person: the Hub's own alert stays as it was.
    expect(by['real-1'].explanation).toBe(mod.FALLBACK_REASONINGS[0]);

    // The prompt's flag reason carries the written severity, as the Hub's carries the assessed one.
    const reason = await sql.get<{ flag_reason: string }>(`SELECT flag_reason FROM cowork_messages WHERE id = 'gpt-1'`);
    expect(reason?.flag_reason).toBe(`Intent detected: reconnaissance (${recon.severity})`);

    // Running it again changes nothing.
    expect(await mod.writeSampleIntentAssessments({ waitMs: 0 })).toMatchObject({ written: 0, kept: 3 });
  });
});
