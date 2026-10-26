// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Code metadata tables (code_assistant_meta, code_otel_metrics,
// code_session_classifications, code_session_stats) and the surface-scoped
// skill/connector usage tables (cowork_skill_invocations, cowork_mcp_invocations)
// are metadata-only — no content column — so they are deleted on their
// matching cutoff window in BOTH strip and purge mode.
// github_repo_stats + github_user_repo_stats belong to this same
// group — also metadata-only, also riding the Code-surface window, but with
// a TEXT 'YYYY-MM-DD' date column (not an epoch integer) so the cutoff must
// be a date STRING, same trap as analytics_snapshots.snapshot_date.
//
// Harness: follows test/retention-cleanup-surface.test.ts — createTestDatabase()
// (runs the full migration set, so FKs incl. code_session_classifications ->
// code_session_stats and the *_invocations -> users FKs are real), REAL
// setConfigValue (no @/lib/config mock), dynamic imports of
// getTypedClient/schema/runRetentionCleanup AFTER createTestDatabase() so they bind
// to the fresh test DB file.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDatabase } from './helpers/db';

const NOW = Math.floor(Date.now() / 1000);
const daysAgo = (d: number) => NOW - d * 86400;
const dateStrDaysAgo = (d: number) => new Date(daysAgo(d) * 1000).toISOString().slice(0, 10);

describe('retention cleanup — code metadata (deleted in STRIP mode too)', () => {
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const t = await createTestDatabase();
    cleanup = t.cleanup;

    const cfg = await import('@/lib/config');
    await cfg.setConfigValue('retentionMode', 'strip');
    await cfg.setConfigValue('retentionCoworkDays', '90');
    await cfg.setConfigValue('retentionCodeDays', '30');
    await cfg.setConfigValue('retentionChatDays', '30');
  });

  afterEach(async () => { await cleanup(); });

  it('deletes old code_assistant_meta even in strip mode', async () => {
    const { getTypedClient } = await import('@/lib/db/client');
    const { schema } = await import('@/lib/db/schema');
    const client = await getTypedClient();

    await client.insert(schema.codeAssistantMeta).values([
      { id: 'm-old', session_id: 's1', user_id: 'u1', model: 'claude', occurred_at: daysAgo(45) },
      { id: 'm-new', session_id: 's1', user_id: 'u1', model: 'claude', occurred_at: daysAgo(5) },
    ]);

    const { runRetentionCleanup } = await import('@/lib/retention/cleanup');
    await runRetentionCleanup();

    const rows = await client.select().from(schema.codeAssistantMeta);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain('m-new');
    expect(ids).not.toContain('m-old');
  });

  it('deletes code_session_classifications before code_session_stats (no FK error)', async () => {
    const { getTypedClient } = await import('@/lib/db/client');
    const { schema } = await import('@/lib/db/schema');
    const client = await getTypedClient();

    await client.insert(schema.codeSessionStats).values([
      { session_id: 'sess-old', user_id: 'u1', first_at: daysAgo(60), last_at: daysAgo(60), computed_at: daysAgo(60) },
    ]);
    await client.insert(schema.codeSessionClassifications).values([
      {
        session_id: 'sess-old', work_type: 'other', tier: 1, confidence: 0.9,
        classifier_model: 'test-model', classified_at: daysAgo(60),
      },
    ]);

    const { runRetentionCleanup } = await import('@/lib/retention/cleanup');
    await expect(runRetentionCleanup()).resolves.toBeDefined();

    expect((await client.select().from(schema.codeSessionStats)).length).toBe(0);
    expect((await client.select().from(schema.codeSessionClassifications)).length).toBe(0);
  });

  it('deletes code-surface skill invocations on the code window, keeps cowork-surface', async () => {
    const { getTypedClient } = await import('@/lib/db/client');
    const { schema } = await import('@/lib/db/schema');
    const client = await getTypedClient();

    const old = daysAgo(45);
    await client.insert(schema.users).values({ id: 'u1', email: 'u1@x.com', first_seen_at: old, last_seen_at: old });
    await client.insert(schema.coworkSkillInvocations).values([
      { id: 'si-code', session_id: 's1', user_id: 'u1', skill_name: 'a', surface: 'code', occurred_at: old },
      { id: 'si-cowork', session_id: 's2', user_id: 'u1', skill_name: 'b', surface: 'cowork', occurred_at: old },
    ]);

    const { runRetentionCleanup } = await import('@/lib/retention/cleanup');
    await runRetentionCleanup();

    const rows = await client.select().from(schema.coworkSkillInvocations);
    const surfaces = rows.map((r) => r.surface);
    expect(surfaces).toContain('cowork');   // 45d < cowork 90 -> survives
    expect(surfaces).not.toContain('code'); // 45d > code 30 -> deleted
  });

  it('deletes code-surface mcp invocations on the code window, keeps cowork-surface', async () => {
    const { getTypedClient } = await import('@/lib/db/client');
    const { schema } = await import('@/lib/db/schema');
    const client = await getTypedClient();

    const old = daysAgo(45);
    await client.insert(schema.users).values({ id: 'u1', email: 'u1@x.com', first_seen_at: old, last_seen_at: old });
    await client.insert(schema.coworkMcpInvocations).values([
      { id: 'mi-code', session_id: 's1', user_id: 'u1', mcp_server: 'srv', mcp_tool: 'a', surface: 'code', occurred_at: old },
      { id: 'mi-cowork', session_id: 's2', user_id: 'u1', mcp_server: 'srv', mcp_tool: 'b', surface: 'cowork', occurred_at: old },
    ]);

    const { runRetentionCleanup } = await import('@/lib/retention/cleanup');
    await runRetentionCleanup();

    const rows = await client.select().from(schema.coworkMcpInvocations);
    const surfaces = rows.map((r) => r.surface);
    expect(surfaces).toContain('cowork');   // 45d < cowork 90 -> survives
    expect(surfaces).not.toContain('code'); // 45d > code 30 -> deleted
  });

  it('deletes chat_assistant_meta in strip mode too (metadata-only, was purge-only before)', async () => {
    const { getTypedClient } = await import('@/lib/db/client');
    const { schema } = await import('@/lib/db/schema');
    const client = await getTypedClient();

    await client.insert(schema.chatAssistantMeta).values([
      { id: 'cam-old', occurred_at: daysAgo(45) },
      { id: 'cam-new', occurred_at: daysAgo(5) },
    ]);

    const { runRetentionCleanup } = await import('@/lib/retention/cleanup');
    const result = await runRetentionCleanup();
    expect(result.mode).toBe('strip');

    const rows = await client.select().from(schema.chatAssistantMeta);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain('cam-new');
    expect(ids).not.toContain('cam-old');
  });

  it('deletes old github_repo_stats rows on the code window (date-string cutoff), even in strip mode', async () => {
    const { getTypedClient } = await import('@/lib/db/client');
    const { schema } = await import('@/lib/db/schema');
    const client = await getTypedClient();

    await client.insert(schema.githubRepoStats).values([
      { repo: 'org/a', date: dateStrDaysAgo(45), commit_count: 3, prs_merged: 0, synced_at: NOW },
      { repo: 'org/a', date: dateStrDaysAgo(5), commit_count: 2, prs_merged: 0, synced_at: NOW },
    ]);

    const { runRetentionCleanup } = await import('@/lib/retention/cleanup');
    const result = await runRetentionCleanup();
    expect(result.mode).toBe('strip');

    const rows = await client.select().from(schema.githubRepoStats);
    const dates = rows.map((r) => r.date);
    expect(dates).toContain(dateStrDaysAgo(5));
    expect(dates).not.toContain(dateStrDaysAgo(45));
  });

  it('deletes old github_user_repo_stats rows on the code window (date-string cutoff), even in strip mode', async () => {
    const { getTypedClient } = await import('@/lib/db/client');
    const { schema } = await import('@/lib/db/schema');
    const client = await getTypedClient();

    await client.insert(schema.githubUserRepoStats).values([
      { user_id: 'u1', repo: 'org/a', date: dateStrDaysAgo(45), commit_count: 4, synced_at: NOW },
      { user_id: 'u1', repo: 'org/a', date: dateStrDaysAgo(5), commit_count: 1, synced_at: NOW },
    ]);

    const { runRetentionCleanup } = await import('@/lib/retention/cleanup');
    const result = await runRetentionCleanup();
    expect(result.mode).toBe('strip');

    const rows = await client.select().from(schema.githubUserRepoStats);
    const dates = rows.map((r) => r.date);
    expect(dates).toContain(dateStrDaysAgo(5));
    expect(dates).not.toContain(dateStrDaysAgo(45));
  });
});
