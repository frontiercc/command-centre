// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';
import { seedUserSql } from './helpers/seed';

// ─── Mocks (hoisted by vitest) ───────────────────────────────────────────

const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(() => ({ messages: { create: mockCreate } })),
}));

vi.mock('@/lib/config', () => ({
  getConfigValue: vi.fn((key: string) => {
    if (key === 'anthropicAiApiKey') return 'test-key';
    return null;
  }),
  setConfigValue: vi.fn(),
  getAllConfig: vi.fn(() => ({
    riskTokenMultiplier: 3,
    riskFileAccessLimit: 50,
    riskInactivityDays: 14,
    riskSensitivity: 'balanced',
    riskAlertAnomalyEnabled: true,
    riskAlertPolicyEnabled: true,
    riskAlertAdoptionEnabled: true,
    riskAlertRiskEnabled: true,
    riskSeverityLowDesc: 'Informational.',
    riskSeverityMediumDesc: 'Worth a look.',
    riskSeverityHighDesc: 'Needs attention.',
    riskSeverityCriticalDesc: 'Actual incident.',
  })),
  getDataSourceStatus: vi.fn(() => ({
    complianceApi: false,
    analyticsApi: false,
    coworkContent: false,
    mode: 'max',
  })),
}));

vi.mock('@/lib/ingestion/scheduler', () => ({
  queueAiCall: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

// ─── Test state ──────────────────────────────────────────────────────────

let sql: TestSql;
let cleanup: () => Promise<void>;
let runAnomalyDetection: () => Promise<unknown[]>;
let getAlerts: (status?: string) => Promise<unknown[]>;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;

  const ai = await import('@/lib/anthropic/ai');
  runAnomalyDetection = ai.runAnomalyDetection;

  const queries = await import('@/lib/db/queries');
  getAlerts = queries.getAlerts;

  await seedUserSql(sql, 'user-1');
});

afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec('DELETE FROM alerts');
  await sql.exec('DELETE FROM compliance_events');
  await sql.exec('DELETE FROM chat_messages');
  await sql.exec('DELETE FROM analytics_snapshots');
  await sql.exec('DELETE FROM otel_events');
  try { await sql.exec('DELETE FROM cowork_messages'); } catch { /* table may not exist */ }
  mockCreate.mockReset();
});

// ─── Helpers ──────────────────────────────────────────────────────────────

function mockAiResponse(alerts: unknown[]) {
  mockCreate.mockResolvedValue({
    content: [{ type: 'text', text: JSON.stringify(alerts) }],
  });
}

async function insertAlertWithTimestamp(id: string, generatedAt: number, opts: {
  userId?: string | null; alertType?: string;
} = {}) {
  await sql.run(`
    INSERT INTO alerts (id, user_id, alert_type, severity, title, explanation, raw_evidence, generated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    id,
    opts.userId ?? 'user-1',
    opts.alertType ?? 'anomaly',
    'medium',
    'Existing alert',
    'Test',
    '{}',
    generatedAt,
  ]);
}

// Raw-SQL twins of seed.ts's seedComplianceEvent / seedChatMessage
// (same columns, same defaults) for createTestDatabase().
async function seedComplianceEvent(overrides: Partial<{
  id: string; user_id: string; event_type: string; surface: string;
  flagged: number; flag_reason: string | null; occurred_at: number;
}> = {}) {
  const now = Math.floor(Date.now() / 1000);
  await sql.run(`
    INSERT INTO compliance_events (id, user_id, event_type, surface, flagged, flag_reason, occurred_at, ingested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    overrides.id ?? `evt-${Math.random().toString(36).slice(2)}`,
    overrides.user_id ?? 'user-1',
    overrides.event_type ?? 'message',
    overrides.surface ?? 'chat',
    overrides.flagged ?? 0,
    overrides.flag_reason ?? null,
    overrides.occurred_at ?? now,
    now,
  ]);
}

async function seedChatMessage(overrides: Partial<{
  id: string; user_id: string; prompt_length: number;
  flagged: number; flag_reason: string | null; occurred_at: number;
}> = {}) {
  const now = Math.floor(Date.now() / 1000);
  await sql.run(`
    INSERT INTO chat_messages (id, user_id, prompt_text, prompt_length, flagged, flag_reason, occurred_at, ingested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    overrides.id ?? `chat-${Math.random().toString(36).slice(2)}`,
    overrides.user_id ?? 'user-1',
    'test prompt',
    overrides.prompt_length ?? 100,
    overrides.flagged ?? 0,
    overrides.flag_reason ?? null,
    overrides.occurred_at ?? now,
    now,
  ]);
}

// ─── Watermark filtering ─────────────────────────────────────────────────

describe('runAnomalyDetection — watermark filtering', () => {
  it('only passes events newer than watermark to AI', async () => {
    // Watermark at 1000
    await insertAlertWithTimestamp('old-alert', 1000);

    // Old event (should be filtered out)
    await seedComplianceEvent({ id: 'evt-old', user_id: 'user-1', occurred_at: 900 });
    // New event (should pass through)
    await seedComplianceEvent({ id: 'evt-new', user_id: 'user-1', occurred_at: 1100 });

    mockAiResponse([]);
    await runAnomalyDetection();

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const prompt = mockCreate.mock.calls[0][0].messages[0].content as string;
    expect(prompt).not.toContain('evt-old');
  });

  it('returns early without calling AI when no events pass watermark', async () => {
    await insertAlertWithTimestamp('recent-alert', 5000);

    // All events are older than watermark
    await seedComplianceEvent({ occurred_at: 1000 });
    await seedChatMessage({ occurred_at: 2000 });

    const result = await runAnomalyDetection();

    expect(result).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('calls AI when watermark is 0 (no previous alerts)', async () => {
    await seedComplianceEvent({ occurred_at: 100 });

    mockAiResponse([]);
    await runAnomalyDetection();

    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});

// ─── Dedup on insert ─────────────────────────────────────────────────────

describe('runAnomalyDetection — dedup on insert', () => {
  it('inserts first alert for user+type', async () => {
    await seedComplianceEvent({ occurred_at: Math.floor(Date.now() / 1000) });

    mockAiResponse([{
      alert_type: 'anomaly',
      severity: 'medium',
      user_id: 'user-1',
      title: 'New anomaly',
      explanation: 'Something happened',
      evidence: { test: true },
    }]);

    const result = await runAnomalyDetection();

    expect(result).toHaveLength(1);
    expect(await getAlerts()).toHaveLength(1);
  });

  it('skips duplicate alert for same user+type', async () => {
    // Existing alert — recent enough to be within 7-day dedup window
    const recentTs = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
    await insertAlertWithTimestamp('existing', recentTs, { userId: 'user-1', alertType: 'anomaly' });

    // New event after watermark
    await seedComplianceEvent({ occurred_at: recentTs + 100 });

    mockAiResponse([{
      alert_type: 'anomaly',
      severity: 'high',
      user_id: 'user-1',
      title: 'Duplicate anomaly',
      explanation: 'Same issue again',
      evidence: {},
    }]);

    const result = await runAnomalyDetection();

    expect(result).toHaveLength(0);
    // Still only the original alert
    expect(await getAlerts()).toHaveLength(1);
  });

  it('allows different type for same user', async () => {
    // Existing anomaly — recent enough to be within dedup window
    const recentTs = Math.floor(Date.now() / 1000) - 3600;
    await insertAlertWithTimestamp('existing', recentTs, { userId: 'user-1', alertType: 'anomaly' });

    await seedComplianceEvent({ occurred_at: recentTs + 100 });

    mockAiResponse([{
      alert_type: 'policy',
      severity: 'high',
      user_id: 'user-1',
      title: 'Policy breach',
      explanation: 'Different type',
      evidence: {},
    }]);

    const result = await runAnomalyDetection();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ alert_type: 'policy' });
    // Original anomaly + new policy
    expect(await getAlerts()).toHaveLength(2);
  });
});

// The model is only shown user ids, and the Slack sweep sends stored text as
// it is, so an id the model writes into an alert is replaced with the name.
describe('runAnomalyDetection — no raw ids in alert text', () => {
  const HASH = '3c9e1f0a7b2d4e6f8a1c3e5f7b9d2a4c6e8f0a1b3d5c7e9f1a2b4c6d8e0f1a3b';

  it('replaces full and shortened ids the model writes with the person name', async () => {
    await seedUserSql(sql, HASH, 'jane.smith@test.local');
    await sql.run('UPDATE users SET display_name = ? WHERE id = ?', ['Jane Smith', HASH]);
    await seedComplianceEvent({ user_id: HASH, occurred_at: Math.floor(Date.now() / 1000) });

    mockAiResponse([{
      alert_type: 'anomaly',
      severity: 'high',
      user_id: HASH,
      title: 'Token spike for 3c9e1f0a...',
      explanation: `${HASH} used five times their usual tokens in one session.`,
      evidence: {},
    }]);

    await runAnomalyDetection();
    const row = (await sql.get(`SELECT title, explanation FROM alerts WHERE user_id = ?`, [HASH])) as { title: string; explanation: string };
    expect(row.title).toBe('Token spike for Jane Smith');
    expect(row.explanation).toBe('Jane Smith used five times their usual tokens in one session.');
  });
});
