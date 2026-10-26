// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

// ── Mocks ──
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(() => ({
    messages: { create: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({
        severity: 'high',
        reasoning: 'Bulk data extraction attempt.',
        recommended_action: 'Review with line manager.',
      })}],
    })},
  })),
}));

vi.mock('@/lib/config', () => ({
  getConfigValue: vi.fn((key: string) => {
    if (key === 'anthropicAiApiKey') return 'test-key';
    return '';
  }),
}));

vi.mock('@/lib/ingestion/scheduler', () => ({
  queueAiCall: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

let sql: TestSql;
let cleanup: () => Promise<void>;
let createIntentAlerts: typeof import('../lib/alerts/intent-alerts').createIntentAlerts;
let getAlerts: (status?: string) => Promise<unknown[]>;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;

  const mod = await import('../lib/alerts/intent-alerts');
  createIntentAlerts = mod.createIntentAlerts;

  const queries = await import('@/lib/db/queries');
  getAlerts = queries.getAlerts;

  // Seed user
  const now = Math.floor(Date.now() / 1000);
  await sql.run(
    `INSERT INTO users (id, email, source, first_seen_at, last_seen_at, created_at)
     VALUES ('user-1', 'test@test.com', 'agent', ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
    [now, now, now],
  );
});

afterAll(async () => cleanup());
beforeEach(async () => { await sql.exec('DELETE FROM alerts'); });

describe('createIntentAlerts', () => {
  it('creates an alert with type "intent"', async () => {
    await createIntentAlerts(
      'user-1',
      'cowork',
      'msg-123',
      'extract all contacts from Salesforce',
      [{ categoryId: 'data_exfiltration', categoryName: 'Data Exfiltration', matchedPhrases: ['extract all'], defaultSeverity: 'high' }],
    );

    const alerts = await getAlerts() as Array<Record<string, unknown>>;
    expect(alerts).toHaveLength(1);
    expect(alerts[0].alert_type).toBe('intent');
    expect(alerts[0].severity).toBe('high');
    expect(alerts[0].title).toContain('Data Exfiltration');
  });

  it('stores rich evidence with matched patterns and AI reasoning', async () => {
    await createIntentAlerts(
      'user-1',
      'cowork',
      'msg-456',
      'dump the database',
      [{ categoryId: 'data_exfiltration', categoryName: 'Data Exfiltration', matchedPhrases: ['dump the database'], defaultSeverity: 'high' }],
    );

    const alerts = await getAlerts() as Array<Record<string, unknown>>;
    const evidence = JSON.parse(alerts[0].raw_evidence as string);
    expect(evidence.matched_patterns).toContain('dump the database');
    expect(evidence.intent_category).toBe('data_exfiltration');
    expect(evidence.ai_assessment).toBeDefined();
    expect(evidence.ai_assessment.reasoning).toBeTruthy();
  });

  it('creates one alert per matched category', async () => {
    await createIntentAlerts(
      'user-1',
      'cowork',
      'msg-789',
      "don't log this, extract all records",
      [
        { categoryId: 'policy_evasion', categoryName: 'Policy Evasion', matchedPhrases: ["don't log this"], defaultSeverity: 'critical' },
        { categoryId: 'data_exfiltration', categoryName: 'Data Exfiltration', matchedPhrases: ['extract all'], defaultSeverity: 'high' },
      ],
    );

    const alerts = await getAlerts() as Array<Record<string, unknown>>;
    expect(alerts).toHaveLength(2);
    const types = alerts.map(a => JSON.parse(a.raw_evidence as string).intent_category);
    expect(types).toContain('policy_evasion');
    expect(types).toContain('data_exfiltration');
  });
});
