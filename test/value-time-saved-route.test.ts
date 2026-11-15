// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { TestSql } from './helpers/sql';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';
import { seedUserSql } from './helpers/seed';

let sessionResult: { authenticated: boolean; role?: string; userId?: string; email?: string };
vi.mock('@/lib/auth/admin-auth', () => ({
  getAdminSession: vi.fn(() => sessionResult),
  canAccessOrgOverview: vi.fn((role: string | undefined) => role === 'admin'),
}));

let sql: TestSql;
let cleanup: () => Promise<void>;
let route: typeof import('../app/api/pulse/code/value/route');
let setConfigValue: typeof import('@/lib/config').setConfigValue;
let ORG_SCOPE_ID: string;

const NOW = Math.floor(Date.now() / 1000);
const DAY = 24 * 60 * 60;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
  route = await import('../app/api/pulse/code/value/route');
  const cfg = await import('@/lib/config');
  setConfigValue = cfg.setConfigValue;
  const agg = await import('@/lib/pulse/code/aggregator');
  ORG_SCOPE_ID = agg.ORG_SCOPE_ID;
  await seedUserSql(sql, 'user-1');
});

afterAll(async () => cleanup());

beforeEach(async () => {
  sessionResult = { authenticated: true, role: 'admin', userId: 'admin-1', email: 'admin@example.com' };
  await sql.exec(`DELETE FROM code_assistant_meta;
           DELETE FROM code_metrics;
           DELETE FROM cowork_messages;
           DELETE FROM config WHERE key IN (
             'code_value_enabled', 'time_saved_min_per_pr', 'time_saved_min_per_commit',
             'time_saved_min_per_cowork_session', 'time_saved_min_per_chat_conversation'
           );`);
  await setConfigValue('codeValueEnabled', 'true');
});

// The org code_metrics row is a *rolling* window: 7d here, deliberately distinct from the page's
// 30 days, so tests can assert the per-row window is read from the row, NOT a blanket 30-day claim.
const METRICS_WINDOW_DAYS = 7;

async function seedOrgMetrics(opts: { commitCount?: number; prCount?: number } = {}) {
  await sql.run(`INSERT INTO code_metrics
       (scope_type, scope_id, granularity, period_start, period_end, commit_count, pr_count, session_count,
        active_time_user_s, active_time_cli_s, spend_usd, computed_at)
     VALUES ('organisation', ?, 'rolling', ?, ?, ?, ?, 0, 0, 0, 0, ?)`, [ORG_SCOPE_ID, NOW - METRICS_WINDOW_DAYS * DAY, NOW, opts.commitCount ?? 0, opts.prCount ?? 0, NOW]);
}

async function seedCoworkMessage(sessionId: string, occurredAt: number) {
  await sql.run(`INSERT INTO cowork_messages (id, user_id, session_id, message_type, role, surface, occurred_at, ingested_at)
     VALUES (?, 'user-1', ?, 'cowork_user_message', 'user', 'cowork', ?, ?)`, [`cm-${sessionId}-${Math.random().toString(36).slice(2)}`, sessionId, occurredAt, NOW]);
}

// A Claude Chat prompt: a cowork_messages row with surface 'chat', whose
// session_id is the conversation id (migration 0041).
async function seedChatMessage(conversationId: string, occurredAt: number) {
  await sql.run(`INSERT INTO cowork_messages (id, user_id, session_id, message_type, surface, source, content_preview, content_full, occurred_at, ingested_at)
     VALUES (?, 'user-1', ?, 'cowork_user_message', 'chat', 'compliance', 'hi', 'hi', ?, ?)`, [`chm-${conversationId}-${Math.random().toString(36).slice(2)}`, conversationId, occurredAt, NOW]);
}

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost/api/pulse/code/value');
}

describe('GET /api/pulse/code/value — timeSaved', () => {
  it('returns null when all counts are zero', async () => {
    await seedOrgMetrics({ commitCount: 0, prCount: 0 });
    const res = await route.GET(makeRequest());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.timeSaved).toBeNull();
  });

  it('computes totalHours and rows from measured PR/commit counts, at defaults', async () => {
    await seedOrgMetrics({ commitCount: 10, prCount: 2 });

    const res = await route.GET(makeRequest());
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.timeSaved).not.toBeNull();
    expect(data.timeSaved.windowDays).toBeUndefined(); // no blanket top-level window — each row carries its own

    const rowsByLabel = Object.fromEntries(
      data.timeSaved.rows.map((r: { label: string; count: number; windowDays: number | null }) => [r.label, r])
    );
    expect(rowsByLabel['pull requests opened'].count).toBe(2);
    expect(rowsByLabel['AI-assisted commits'].count).toBe(10);

    // PR/commit rows are drawn from the rolling code_metrics window (7d fixture), NOT a blanket 30d.
    expect(rowsByLabel['pull requests opened'].windowDays).toBe(METRICS_WINDOW_DAYS);
    expect(rowsByLabel['AI-assisted commits'].windowDays).toBe(METRICS_WINDOW_DAYS);

    // Defaults: minPerPr=150, minPerCommit=20
    const expectedTotalMinutes = 2 * 150 + 10 * 20;
    expect(data.timeSaved.totalHours).toBe(Math.round(expectedTotalMinutes / 60));
  });

  // The owner's rule, 2026-11-15: the Value page's Time saved counts coding work only (Claude
  // Code and Codex). Claude Cowork and Claude Chat time saved belongs on Work Pulse.
  it('leaves Claude Cowork sessions and Claude Chat conversations out of Time saved', async () => {
    await seedOrgMetrics({ commitCount: 10, prCount: 2 });
    await seedCoworkMessage('sess-a', NOW - DAY);
    await seedCoworkMessage('sess-b', NOW - 2 * DAY);
    await seedChatMessage('conv-a', NOW - DAY);
    await setConfigValue('timeSavedMinPerCoworkSession', '600');
    await setConfigValue('timeSavedMinPerChatConversation', '600');

    const data = await (await route.GET(makeRequest())).json();
    const labels = data.timeSaved.rows.map((r: { label: string }) => r.label).sort();
    expect(labels).toEqual(['AI-assisted commits', 'pull requests opened']);
    expect(data.timeSaved.totalHours).toBe(Math.round((2 * 150 + 10 * 20) / 60));
  });

  it('is null with Cowork and Chat activity but no coding output', async () => {
    await seedOrgMetrics({ commitCount: 0, prCount: 0 });
    await seedCoworkMessage('sess-a', NOW - DAY);
    await seedChatMessage('conv-a', NOW - DAY);
    const data = await (await route.GET(makeRequest())).json();
    expect(data.timeSaved).toBeNull();
  });

  it('respects a config override for minutes-per-PR', async () => {
    await seedOrgMetrics({ commitCount: 0, prCount: 1 });
    await setConfigValue('timeSavedMinPerPr', '60');

    const res = await route.GET(makeRequest());
    const data = await res.json();
    const prRow = data.timeSaved.rows.find((r: { label: string }) => r.label === 'pull requests opened');
    expect(prRow.minutesEach).toBe(60);
    expect(prRow.hours).toBe(1);
  });

  it('returns enabled:false payload (no timeSaved) when codeValueEnabled is off', async () => {
    await seedOrgMetrics({ commitCount: 5, prCount: 5 });
    await setConfigValue('codeValueEnabled', 'false');

    const res = await route.GET(makeRequest());
    const data = await res.json();
    expect(data.enabled).toBe(false);
    expect(data.timeSaved).toBeUndefined();
  });
});
