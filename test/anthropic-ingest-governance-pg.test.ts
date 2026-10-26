// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Postgres coverage for lib/anthropic/{analytics,ai}.ts.
// (The compliance.ts module this file originally also covered was retired
// in the Compliance API rewrite — replaced by lib/compliance/
// {chat-sync,activity-sync,job}.ts, covered by their own test files.)
//
// The central thing this proves, on Postgres:
//
//   1. ingestAnalyticsSnapshots: the per-page write (upsertUser + the
//      analytics_snapshots insert) now runs inside a top-level `withTx` PER
//      PAGE instead of the old sync `db.transaction(() => …)` — proven by
//      exercising TWO pages (next_page-driven), each its own transaction,
//      with the Anthropic API `fetch` mocked (never hits the real API). The
//      analytics date-window watermark (today-3-days, resumed from
//      `analyticsLastDate`) advances exactly as before.
//   2. analytics.ts's upsertUser lets a non-null new value win (COALESCE(new,
//      existing)) — proven across TWO separate per-page transactions writing
//      the SAME (user_id, snapshot_date) conflict target, exercising the
//      composite onConflictDoUpdate target.
//   3. generateGovernanceReport's three converted raw-`.prepare` COUNT reads
//      (cowork flagged / code total / code flagged — the users.source='otel'
//      count is exercised too, though its result was already unused dead
//      code before this conversion and stays that way) surface the correct
//      numbers in the LLM prompt payload (Anthropic SDK mocked; its
//      `system` argument is inspected directly).
//
// HARNESS RULE (copied from otel-receivers-pg.test.ts / code-pulse-
// aggregator-classifier-pg.test.ts): the modules under test reach the
// database through getClient(), which binds to DATABASE_URL on first use,
// so the modules-under-test (and schema/json helpers) are DYNAMIC-imported
// AFTER createTestDbClient('postgres') has set DATABASE_URL + reset modules. The
// Anthropic SDK is mocked at the top level (vi.mock is hoisted) so it stays
// intercepted across the resetModules()+dynamic-import dance.
import { describe, it, expect, vi } from 'vitest';

vi.mock('@anthropic-ai/sdk', () => {
  const mockCreate = vi.fn();
  return {
    default: vi.fn().mockImplementation(() => ({ messages: { create: mockCreate } })),
    __mockCreate: mockCreate,
  };
});

const NOW = Math.floor(Date.now() / 1000);

async function getMockCreate() {
  const mod = await import('@anthropic-ai/sdk');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (mod as any).__mockCreate as ReturnType<typeof vi.fn>;
}

/** Minimal fetch Response stand-in — only what withBackoff/the callers use. */
function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

async function runSpec(): Promise<void> {
  const { createTestDbClient } = await import('./helpers/db');
  const { client, cleanup } = await createTestDbClient('postgres');
  const originalFetch = global.fetch;

  try {
    // Dynamic imports AFTER the DATABASE_URL env + module reset (harness rule).
    const { schema } = await import('@/lib/db/schema');
    const { eq, and } = await import('drizzle-orm');
    const cfg = await import('@/lib/config');
    const analytics = await import('@/lib/anthropic/analytics');
    const ai = await import('@/lib/anthropic/ai');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = client as any;

    await cfg.setConfigValue('anthropicAdminApiKey', 'admin-test-key');
    await cfg.setConfigValue('anthropicAnalyticsApiKey', 'analytics-test-key');
    await cfg.setConfigValue('anthropicAiApiKey', 'ai-test-key');

    // ════════════════════════════════════════════════════════════════════
    // SECTION B — ingestAnalyticsSnapshots against the REAL Enterprise
    // Analytics API shape (GET /v1/organizations/analytics/users). Proves:
    // date-window/watermark math, withTx-per-page across the SAME
    // (user_id, snapshot_date) conflict target on two separate pages for
    // the SAME user (upsertUser's new-wins COALESCE on email), and the
    // full 13-field snapshot mapping off the nested chat_metrics /
    // claude_code_metrics.core_metrics / cowork_metrics record shape.
    // ════════════════════════════════════════════════════════════════════
    const now = new Date();
    const maxDate = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000); // 3-day delay
    const maxDateStr = maxDate.toISOString().split('T')[0];
    const lastDateStr = new Date(maxDate.getTime() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    await cfg.setConfigValue('analyticsLastDate', lastDateStr); // resumes exactly at maxDateStr — one date processed

    const PAGE2_CURSOR = 'cursor-page-2';
    const requestedUrls: string[] = [];

    // Page 1: a stale/partial record for user_ana1 (proves page 2 overwrites
    // it — same onConflictDoUpdate target across two independent withTx
    // calls, and upsertUser's new-wins email COALESCE).
    const anaStale = {
      user: { id: 'user_ana1', email_address: 'ana-old@test.local' },
      chat_metrics: {
        message_count: 1, distinct_conversation_count: 1,
        distinct_projects_created_count: 0, distinct_files_uploaded_count: 0,
        distinct_artifacts_created_count: 0, distinct_skills_used_count: 0,
        connectors_used_count: 0,
      },
      claude_code_metrics: { core_metrics: {
        distinct_session_count: 0, commit_count: 0, pull_request_count: 0,
        lines_of_code: { added_count: 0, removed_count: 0 },
      } },
      cowork_metrics: { message_count: 0 },
      last_activity_date: maxDateStr,
    };

    // Page 2 (same date, `page` cursor set): the authoritative record —
    // final row must hold these values.
    const anaFull = {
      user: { id: 'user_ana1', email_address: 'ana@test.local' },
      chat_metrics: {
        message_count: 12, distinct_conversation_count: 3,
        distinct_projects_created_count: 1, distinct_files_uploaded_count: 2,
        distinct_artifacts_created_count: 4, distinct_skills_used_count: 2,
        connectors_used_count: 5,
      },
      claude_code_metrics: { core_metrics: {
        distinct_session_count: 2, commit_count: 3, pull_request_count: 1,
        lines_of_code: { added_count: 100, removed_count: 40 },
      } },
      cowork_metrics: { message_count: 7, distinct_session_count: 1 },
      last_activity_date: maxDateStr,
    };

    global.fetch = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      requestedUrls.push(u);
      if (u.includes(`page=${PAGE2_CURSOR}`)) {
        return jsonResponse({ data: [anaFull], has_more: false, next_page: null });
      }
      if (u.includes('/v1/organizations/analytics/users')) {
        return jsonResponse({ data: [anaStale], has_more: true, next_page: PAGE2_CURSOR });
      }
      throw new Error(`unexpected fetch in Section B: ${u}`);
    }) as unknown as typeof fetch;

    const analyticsResult = await analytics.ingestAnalyticsSnapshots();
    expect(analyticsResult.errors).toEqual([]);
    expect(analyticsResult.snapshotsUpserted).toBe(2); // page 1 + page 2, each counted once

    expect(await cfg.getConfigValue('analyticsLastDate')).toBe(maxDateStr);

    // Every request hit the real endpoint with a date param.
    expect(requestedUrls.length).toBe(2);
    for (const u of requestedUrls) {
      expect(u).toContain('/v1/organizations/analytics/users');
      expect(u).toContain('date=');
    }

    // ON CONFLICT DO UPDATE: exactly ONE row for (user_ana1, maxDateStr),
    // holding page 2's values (excluded.* wins over page 1's) — the full
    // 13-field mapping off the nested real-API record shape.
    const snapA = await db.select().from(schema.analyticsSnapshots)
      .where(and(eq(schema.analyticsSnapshots.user_id, 'user_ana1'), eq(schema.analyticsSnapshots.snapshot_date, maxDateStr)));
    expect(snapA.length).toBe(1);
    expect(Number(snapA[0].conversations)).toBe(3);
    expect(Number(snapA[0].messages_sent)).toBe(12);
    expect(Number(snapA[0].projects_created)).toBe(1);
    expect(Number(snapA[0].files_uploaded)).toBe(2);
    expect(Number(snapA[0].artifacts_created)).toBe(4);
    expect(Number(snapA[0].skills_used)).toBe(2);
    expect(Number(snapA[0].connectors_used)).toBe(5);
    expect(Number(snapA[0].code_commits)).toBe(3);
    expect(Number(snapA[0].code_prs)).toBe(1);
    expect(Number(snapA[0].code_lines)).toBe(140); // 100 + 40
    expect(Number(snapA[0].surface_chat)).toBe(12);
    expect(Number(snapA[0].surface_code)).toBe(2);
    expect(Number(snapA[0].surface_cowork)).toBe(7);

    // upsertUser COALESCE semantics: a non-null NEW email wins (page 2's
    // ana@test.local overwrites page 1's stale placeholder).
    const userAna = await db.select().from(schema.users).where(eq(schema.users.id, 'user_ana1'));
    expect(userAna.length).toBe(1);
    expect(userAna[0].email).toBe('ana@test.local');

    // A second run before the watermark advances again fetches NOTHING new.
    const secondRun = await analytics.ingestAnalyticsSnapshots();
    expect(secondRun.snapshotsUpserted).toBe(0);
    expect(secondRun.errors).toEqual([]);

    // ════════════════════════════════════════════════════════════════════
    // SECTION C — generateGovernanceReport: converted raw-.prepare COUNT
    // reads surface the correct numbers in the (mocked) LLM prompt payload.
    // ════════════════════════════════════════════════════════════════════
    await db.insert(schema.users).values([
      { id: 'user-otel', email: 'otel@test.local', source: 'otel', first_seen_at: NOW, last_seen_at: NOW },
      // Section B no longer creates user-A/user-B (real API fixture only
      // exercises user_ana1) — Postgres FK-enforces cowork_messages.user_id,
      // so these need an explicit users row here.
      { id: 'user-A', email: 'a@test.local', source: 'otel', first_seen_at: NOW, last_seen_at: NOW },
      { id: 'user-B', email: 'b@test.local', source: 'otel', first_seen_at: NOW, last_seen_at: NOW },
    ]);

    await db.insert(schema.coworkMessages).values([
      { id: 'cm-1', session_id: 'sess-1', user_id: 'user-A', message_type: 'cowork_user_message', surface: 'cowork', flagged: 1, occurred_at: NOW - 10 },
      { id: 'cm-2', session_id: 'sess-1', user_id: 'user-A', message_type: 'cowork_user_message', surface: 'cowork', flagged: 0, occurred_at: NOW - 9 },
      { id: 'cm-3', session_id: 'sess-2', user_id: 'user-B', message_type: 'code_user_message', surface: 'code', flagged: 1, occurred_at: NOW - 8 },
      { id: 'cm-4', session_id: 'sess-2', user_id: 'user-B', message_type: 'code_user_message', surface: 'code', flagged: 0, occurred_at: NOW - 7 },
      { id: 'cm-5', session_id: 'sess-2', user_id: 'user-B', message_type: 'code_user_message', surface: 'code', flagged: 0, occurred_at: NOW - 6 },
    ]);

    const mockCreate = await getMockCreate();
    mockCreate.mockReset();
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: '# Report\n\nok' }] });

    const reportMd = await ai.generateGovernanceReport('2026-01-01', '2026-01-31', ['cowork_audit', 'code_audit']);
    expect(reportMd).toContain('# Report');
    expect(mockCreate).toHaveBeenCalledTimes(1);

    const systemPrompt = mockCreate.mock.calls[0][0].system as string;
    // messageCount (ALL cowork_messages rows, both surfaces) = 5.
    expect(systemPrompt).toContain('**Total Cowork messages:** 5');
    // flaggedCount (flagged=1, both surfaces: cm-1 + cm-3) = 2.
    expect(systemPrompt).toContain('**Flagged messages (PII/policy):** 2');
    // totalCodeMessages (surface='code': cm-3/4/5) = 3.
    expect(systemPrompt).toContain('**Total Code events:** 3');
    // codeFlaggedCount (surface='code' AND flagged=1: cm-3) = 1.
    expect(systemPrompt).toContain('**Flagged events (PII/policy):** 1');
  } finally {
    global.fetch = originalFetch;
    await cleanup();
  }
}

describe('anthropic ingest + governance reads (postgres)', () => {
  it(
    'analytics withTx-per-page ingest and governance-report count reads behave correctly on postgres',
    async () => {
      await runSpec();
    },
    180_000,
  );
});
