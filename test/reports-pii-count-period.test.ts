// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The GDPR / LGPD "PII detections in period" figure counts only the report
// period, from every source. Chat used to be counted all-time
// while Cowork/Code were period-filtered, so a monthly report showed every
// flagged Chat prompt ever plus that month's Cowork and Code ones.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createTestDatabase } from './helpers/db';
import { seedUserSql } from './helpers/seed';
import type { TestSql } from './helpers/sql';

vi.mock('@/lib/config', async (orig) => {
  const actual = await orig<typeof import('@/lib/config')>();
  return { ...actual, getDataSourceStatus: async () => ({}) };
});

let sql: TestSql;
let cleanup: () => Promise<void>;

const PERIOD_START = '2026-09-01T00:00:00Z';
const PERIOD_END = '2026-09-30T23:59:59Z';
const BEFORE = Math.floor(Date.UTC(2026, 7, 15) / 1000); // 15 Aug — outside
const DURING = Math.floor(Date.UTC(2026, 8, 15) / 1000); // 15 Sep — inside

beforeAll(async () => {
  ({ sql, cleanup } = await createTestDatabase());
  await seedUserSql(sql, 'u1');
  const chat = (id: string, at: number) => sql.run(
    `INSERT INTO chat_messages (id, user_id, prompt_text, prompt_length, flagged, flag_reason, occurred_at, ingested_at)
     VALUES (?, 'u1', 'x', 1, 1, 'PII detected: email', ?, ?)`, [id, at, at]);
  const cowork = (id: string, at: number) => sql.run(
    `INSERT INTO cowork_messages (id, session_id, user_id, message_type, role, content_preview, flagged, flag_reason, occurred_at, ingested_at)
     VALUES (?, 's1', 'u1', 'cowork_user_message', 'user', 'x', 1, 'PII detected: email', ?, ?)`, [id, at, at]);
  await chat('chat-old', BEFORE);
  await chat('chat-new', DURING);
  await cowork('cw-old', BEFORE);
  await cowork('cw-new', DURING);
});
afterAll(async () => cleanup());

describe('PII detections in period', () => {
  it('GDPR counts only the period, chat included (1 chat + 1 cowork)', async () => {
    const { buildGdprSection } = await import('@/lib/reports/compliance-sections');
    const md = await buildGdprSection(PERIOD_START, PERIOD_END);
    expect(md).toContain('2 detections in period');
  });

  it('LGPD reports the same figure', async () => {
    const { buildLgpdSection } = await import('@/lib/reports/compliance-sections');
    const md = await buildLgpdSection(PERIOD_START, PERIOD_END);
    expect(md).toContain('2 detections in period');
  });
});
