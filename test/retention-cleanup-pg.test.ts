// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Postgres coverage for lib/retention/cleanup.ts's
// runRetentionCleanup(): the withTx deletion/strip batch, rowcount extraction
// (rowCount ?? 0), the granularity-aware pulse/code-metric +
// use-case-weekly retention, and a clean second run.
//
// HARNESS RULE (copied from queries-cowork-chat-gdpr-pg.test.ts / otel-
// receivers-pg.test.ts): lib/retention/cleanup.ts reaches the database
// through getClient(), which binds to DATABASE_URL on first use, so the
// module-under-test (and schema) are DYNAMIC-imported AFTER
// createTestDbClient() has set DATABASE_URL + reset modules. Postgres runs the
// full migrations-pg set via startPg(), so no manual DDL is needed.
import { describe, it, expect } from 'vitest';

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

async function runSpec(): Promise<void> {
  const { createTestDbClient } = await import('./helpers/db');
  const { client, cleanup } = await createTestDbClient('postgres');

  try {
    // Dynamic imports AFTER the DB env + module reset (harness rule).
    const { schema } = await import('@/lib/db/schema');
    const { runRetentionCleanup } = await import('@/lib/retention/cleanup');
    const { setConfigValue } = await import('@/lib/config');
    const { eq } = await import('drizzle-orm');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = client as any;

    // ══════════════════════════════════════════════════════════════════════
    // SECTION 1 — purge mode: cutoff deletion across all 4 content tables +
    // rowcount extraction (result.*_rows_affected).
    // ══════════════════════════════════════════════════════════════════════
    await setConfigValue('retentionMode', 'purge');
    await setConfigValue('retentionCoworkDays', '7');
    await setConfigValue('retentionOtelDays', '7');
    await setConfigValue('retentionComplianceDays', '7');
    await setConfigValue('retentionErrorDays', '7');
    await setConfigValue('retentionChatDays', '7');

    const oldTs = NOW - 10 * DAY; // past the 7-day cutoff
    const newTs = NOW - 1 * DAY; // inside the 7-day window

    await db.insert(schema.coworkMessages).values([
      { id: 'cw-old', session_id: 'sess-1', message_type: 'assistant', occurred_at: oldTs, surface: 'cowork', source: 'agent' },
      { id: 'cw-new', session_id: 'sess-1', message_type: 'assistant', occurred_at: newTs, surface: 'cowork', source: 'agent' },
    ]);
    await db.insert(schema.otelEvents).values([
      { id: 'otel-old', occurred_at: oldTs },
      { id: 'otel-new', occurred_at: newTs },
    ]);
    await db.insert(schema.complianceEvents).values([
      { id: 'ce-old', event_type: 'pii_detected', surface: 'cowork', occurred_at: oldTs },
      { id: 'ce-new', event_type: 'pii_detected', surface: 'cowork', occurred_at: newTs },
    ]);
    await db.insert(schema.errorEvents).values([
      { occurred_at: oldTs, severity: 'error', source: 'test', message: 'old error' },
      { occurred_at: newTs, severity: 'error', source: 'test', message: 'new error' },
    ]);
    await db.insert(schema.chatMessages).values([
      { id: 'chat-old', prompt_text: 'old prompt', prompt_length: 10, occurred_at: oldTs },
      { id: 'chat-new', prompt_text: 'new prompt', prompt_length: 10, occurred_at: newTs },
    ]);
    await db.insert(schema.chatAssistantMeta).values([
      { id: 'chat-meta-old', occurred_at: oldTs },
      { id: 'chat-meta-new', occurred_at: newTs },
    ]);

    const purgeResult = await runRetentionCleanup();
    expect(purgeResult.mode).toBe('purge');
    expect(purgeResult.cowork_rows_affected).toBe(1);
    expect(purgeResult.otel_rows_affected).toBe(1);
    expect(purgeResult.compliance_rows_affected).toBe(1);
    expect(purgeResult.error_rows_affected).toBe(1);
    // chat_rows_affected sums chat_messages (1) + chat_assistant_meta (1)
    // purged in the same window.
    expect(purgeResult.chat_rows_affected).toBe(2);

    const remainingCowork = await db.select().from(schema.coworkMessages);
    expect(remainingCowork.map((r: { id: string }) => r.id)).toEqual(['cw-new']);
    const remainingOtel = await db.select().from(schema.otelEvents);
    expect(remainingOtel.map((r: { id: string }) => r.id)).toEqual(['otel-new']);
    const remainingCompliance = await db.select().from(schema.complianceEvents);
    expect(remainingCompliance.map((r: { id: string }) => r.id)).toEqual(['ce-new']);
    const remainingErrors = await db.select().from(schema.errorEvents);
    expect(remainingErrors.map((r: { message: string }) => r.message)).toEqual(['new error']);
    const remainingChatMessages = await db.select().from(schema.chatMessages);
    expect(remainingChatMessages.map((r: { id: string }) => r.id)).toEqual(['chat-new']);
    const remainingChatMeta = await db.select().from(schema.chatAssistantMeta);
    expect(remainingChatMeta.map((r: { id: string }) => r.id)).toEqual(['chat-meta-new']);

    // ══════════════════════════════════════════════════════════════════════
    // SECTION 2 — strip mode: content-strip predicate is idempotent (a
    // second run affects 0 rows because the WHERE excludes already-stripped
    // rows — proves `or(isNull(...), ne(...))` excludes them).
    // ══════════════════════════════════════════════════════════════════════
    await setConfigValue('retentionMode', 'strip');
    await db.insert(schema.coworkMessages).values({
      id: 'cw-strip', session_id: 'sess-2', message_type: 'assistant', occurred_at: oldTs,
      content_full: 'secret content', content_preview: 'preview text',
      tool_input_preview: 'tool in', tool_output_preview: 'tool out',
      surface: 'cowork', source: 'agent',
    });
    // chat_messages: prompt_text is NOT NULL, so strip mode substitutes the
    // SAME marker used for cowork's content_preview rather than nulling it —
    // the row + its metadata (prompt_length, flagged, etc.) stay in place.
    await db.insert(schema.chatMessages).values({
      id: 'chat-strip', prompt_text: 'secret prompt content', prompt_length: 22, occurred_at: oldTs,
    });
    // chat_assistant_meta is metadata-only (no content column to strip), so
    // cleanup deletes it outright on the same window in BOTH modes rather
    // than leaving it in place — there is nothing for "strip" to mean here.
    await db.insert(schema.chatAssistantMeta).values({
      id: 'chat-meta-strip', occurred_at: oldTs, model: 'claude-sonnet-5',
    });

    const stripResult1 = await runRetentionCleanup();
    expect(stripResult1.mode).toBe('strip');
    expect(stripResult1.cowork_rows_affected).toBe(1);
    // chat_messages stripped (1) + chat_assistant_meta deleted (1), same window.
    expect(stripResult1.chat_rows_affected).toBe(2);

    const stripped = (await db.select().from(schema.coworkMessages).where(eq(schema.coworkMessages.id, 'cw-strip')))[0];
    expect(stripped.content_full).toBeNull();
    expect(stripped.content_preview).toBe('[Content removed — retention policy]');
    expect(stripped.tool_input_preview).toBeNull();
    expect(stripped.tool_output_preview).toBeNull();

    const strippedChat = (await db.select().from(schema.chatMessages).where(eq(schema.chatMessages.id, 'chat-strip')))[0];
    expect(strippedChat.prompt_text).toBe('[Content removed — retention policy]');
    expect(strippedChat.prompt_length).toBe(22); // metadata (length) unchanged — only content blanked

    const deletedChatMeta = await db.select().from(schema.chatAssistantMeta).where(eq(schema.chatAssistantMeta.id, 'chat-meta-strip'));
    expect(deletedChatMeta.length).toBe(0); // deleted even in strip mode — metadata-only, both-modes delete

    // Second run: the row is already stripped, so the WHERE predicate
    // excludes it — 0 rows affected this time (idempotency).
    const stripResult2 = await runRetentionCleanup();
    expect(stripResult2.cowork_rows_affected).toBe(0);
    expect(stripResult2.chat_rows_affected).toBe(0);

    // ══════════════════════════════════════════════════════════════════════
    // SECTION 3 — granularity-aware pulse/code-metric retention + the
    // future-dated-row safety net + the use-case weekly-history horizon (all
    // exercised inside the SAME withTx batch as the content cleanup above).
    // ══════════════════════════════════════════════════════════════════════
    const oldRolling40d = NOW - 40 * DAY;
    const oldWeekly40d = NOW - 40 * DAY;
    const recentRolling = NOW - 10 * DAY;
    const oldWeekly401d = NOW - 401 * DAY;
    const future = NOW + 350 * DAY;

    for (const table of [schema.codeMetrics, schema.pulseMetrics]) {
      await db.insert(table).values([
        { scope_type: 'user', scope_id: 'user1', period_start: oldRolling40d, period_end: oldRolling40d + 3600, granularity: 'rolling', computed_at: oldRolling40d },
        { scope_type: 'user', scope_id: 'user1', period_start: oldWeekly40d, period_end: oldWeekly40d + 604800, granularity: 'week', computed_at: oldWeekly40d },
        { scope_type: 'user', scope_id: 'user1', period_start: recentRolling, period_end: recentRolling + 3600, granularity: 'rolling', computed_at: recentRolling },
        { scope_type: 'user', scope_id: 'user1', period_start: oldWeekly401d, period_end: oldWeekly401d + 604800, granularity: 'week', computed_at: oldWeekly401d },
        { scope_type: 'user', scope_id: 'user2', period_start: future, period_end: future + 3600, granularity: 'rolling', computed_at: future },
      ]);
    }

    await db.insert(schema.useCases).values({ id: 'uc-1', title: 'Test use case' });
    const oldWeekStart = NOW - 401 * DAY;
    const recentWeekStart = NOW - 40 * DAY;
    await db.insert(schema.useCaseActivationWeeks).values([
      { use_case_id: 'uc-1', week_start: oldWeekStart },
      { use_case_id: 'uc-1', week_start: recentWeekStart },
    ]);
    await db.insert(schema.useCaseWeekMatches).values([
      { use_case_id: 'uc-1', week_start: oldWeekStart, user_id: 'u1' },
      { use_case_id: 'uc-1', week_start: recentWeekStart, user_id: 'u1' },
    ]);

    await runRetentionCleanup();

    for (const table of [schema.codeMetrics, schema.pulseMetrics]) {
      const afterRows = await db.select().from(table).where(eq(table.scope_id, 'user1'));
      // old rolling (40d) gone, old weekly (40d, within 400d) kept, recent
      // rolling kept, old weekly (401d) gone.
      expect(afterRows.map((r: { granularity: string; computed_at: number }) => `${r.granularity}:${r.computed_at}`).sort())
        .toEqual([`rolling:${recentRolling}`, `week:${oldWeekly40d}`].sort());

      // future-dated row (scope user2) is always corrupt — pruned.
      const futureRows = await db.select().from(table).where(eq(table.scope_id, 'user2'));
      expect(futureRows.length).toBe(0);
    }

    const weeksAfter = await db.select().from(schema.useCaseActivationWeeks);
    expect(weeksAfter.map((r: { week_start: number }) => r.week_start)).toEqual([recentWeekStart]);
    const matchesAfter = await db.select().from(schema.useCaseWeekMatches);
    expect(matchesAfter.map((r: { week_start: number }) => r.week_start)).toEqual([recentWeekStart]);

    // ══════════════════════════════════════════════════════════════════════
    // SECTION 4 — a further runRetentionCleanup() over the already-cleaned
    // data resolves without throwing (there is no manual disk-reclaim step;
    // Postgres autovacuum handles it).
    // ══════════════════════════════════════════════════════════════════════
    await expect(runRetentionCleanup()).resolves.toBeDefined();
  } finally {
    await cleanup();
  }
}

describe('runRetentionCleanup (postgres)', () => {
  it(
    'cutoff deletion, content-strip idempotency, and granularity-aware metric/use-case retention behave correctly on postgres — and a further cleanup run resolves without error',
    async () => {
      await runSpec();
    },
    180_000,
  );
});
