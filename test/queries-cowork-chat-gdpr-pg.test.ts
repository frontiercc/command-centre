// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Postgres coverage for the Cowork messages + Chat + GDPR +
// stats group of lib/db/queries.ts: insertCoworkMessage, getCoworkMessages,
// getRecentCoworkSessions, getCoworkMessageCount, hasCoworkContent,
// getChatMessages, getChatMessageCount, getChatFlaggedCount,
// getCoworkFlaggedCount, getCodeFlaggedCount, getAvgSessionsPerWeek,
// getRecentCoworkMessages, getRecentChatMessages, getCodeEventCount,
// exportUserData, deleteUserData, getDbStats.
//
// The central assertions this file proves:
//   1. token_usage (cowork_messages) / tool_input+token_usage+file_paths
//      (otel_events) / metadata (compliance_events) / raw_evidence (alerts)
//      all round-trip as the SAME JSON string (Policy A).
//   2. deleteUserData (GDPR right-to-erasure, compliance-critical) erases —
//      or, for the two tolerated non-destructive statements, anonymises —
//      the target user's rows across EVERY table it touches (with real
//      FKs enforced, so child-before-parent ordering matters), while a
//      control user's rows in the SAME tables survive
//      untouched (selectivity proof) and the audit alert (user_id=null)
//      survives (it must — that's the compliance trail).
//   3. getDbStats returns a sane size (pg_database_size()) plus correct
//      per-table counts.
//
// HARNESS RULE (copied from queries-alerts-pg.test.ts / queries-users-pg.
// test.ts): queries.ts reaches the database through getClient(), which binds
// to DATABASE_URL on first use, so the module-under-test (and
// schema) are DYNAMIC-imported AFTER createTestDbClient() has set
// DATABASE_URL + reset modules.
import { describe, it, expect } from 'vitest';

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

async function runSpec(): Promise<void> {
  const { createTestDbClient } = await import('./helpers/db');
  const { client, cleanup } = await createTestDbClient('postgres');
  try {
    // Dynamic import AFTER the DATABASE_URL env + module reset (harness rule).
    const { schema } = await import('@/lib/db/schema');
    const queries = await import('@/lib/db/queries');
    const {
      insertCoworkMessage, getCoworkMessages, getRecentCoworkSessions,
      getCoworkMessageCount, hasCoworkContent, getChatMessages, getChatMessageCount,
      getChatFlaggedCount, getCoworkFlaggedCount, getCodeFlaggedCount,
      getAvgSessionsPerWeek, getRecentCoworkMessages, getRecentChatMessages,
      getCodeEventCount, exportUserData, deleteUserData, getDbStats, upsertCoworkSession,
    } = queries;
    const { eq, inArray } = await import('drizzle-orm');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = client as any;

    // ── Seed the two users used throughout ──────────────────────────────
    await db.insert(schema.users).values([
      { id: 'erase-user', email: 'erase@test.local', display_name: 'Erase Me', department: 'Eng' },
      { id: 'keep-user', email: 'keep@test.local', display_name: 'Keep Me', department: 'Sales' },
    ]);

    // ═══════════════════════════════════════════════════════════════════
    // SECTION 0 — getAvgSessionsPerWeek, in isolation (no other data yet)
    // ═══════════════════════════════════════════════════════════════════
    expect(await getAvgSessionsPerWeek()).toEqual({ cowork: 0, code: 0, chat: 0 });

    // cowork: 2 distinct sessions (one explicit surface='cowork', one with a
    // NULL surface — pre-migration data shape) → isNull()/eq()
    // branch. firstSeen = NOW-10d → weeksActive = ceil(10/7) = 2 →
    // avg = round((2/2)*10)/10 = 1.0.
    await db.insert(schema.coworkMessages).values([
      { id: 'avg-cw-1', session_id: 'sess-avg-1', user_id: 'erase-user', message_type: 'cowork_message', surface: 'cowork', flagged: 0, occurred_at: NOW - 3 * DAY, source: 'agent' },
      { id: 'avg-cw-2', session_id: 'sess-avg-2', user_id: 'erase-user', message_type: 'cowork_message', surface: null, flagged: 0, occurred_at: NOW - 10 * DAY, source: 'agent' },
    ]);
    // code: reads code_session_stats (NOT cowork_messages) — rowA within the
    // 28-day window (contributes to count), rowB outside it (excluded from
    // count but its first_at still counts toward the unconditional MIN).
    // firstSeen = NOW-20d → weeksActive = ceil(20/7) = 3 → avg = round((1/3)*10)/10 = 0.3.
    await db.insert(schema.codeSessionStats).values([
      { session_id: 'avg-code-a', first_at: NOW - 3 * DAY, last_at: NOW - 3 * DAY, computed_at: NOW },
      { session_id: 'avg-code-b', first_at: NOW - 20 * DAY, last_at: NOW - 35 * DAY, computed_at: NOW },
    ]);
    // chat: 2 distinct conversation_ids, firstSeen = NOW-2d → weeksActive =
    // ceil(2/7) = 1 → avg = round((2/1)*10)/10 = 2.0.
    await db.insert(schema.chatMessages).values([
      // user_id deliberately NULL — getAvgSessionsPerWeek's chat query has no
      // user_id filter, and this keeps Section 0 fully decoupled from the
      // per-user assertions in Section 4.
      { id: 'avg-chat-1', conversation_id: 'chatconv-avg-1', user_id: null, prompt_text: 'hi', prompt_length: 2, occurred_at: NOW - 2 * DAY },
      { id: 'avg-chat-2', conversation_id: 'chatconv-avg-2', user_id: null, prompt_text: 'yo', prompt_length: 2, occurred_at: NOW - 2 * DAY },
    ]);

    const avg = await getAvgSessionsPerWeek();
    expect(avg).toEqual({ cowork: 1, code: 0.3, chat: 2 });
    for (const v of Object.values(avg)) expect(typeof v).toBe('number');

    // ═══════════════════════════════════════════════════════════════════
    // SECTION 1 — insertCoworkMessage (Policy A write) / getCoworkMessages
    // (Policy A read + NOT IN type filter) / getCoworkMessageCount /
    // hasCoworkContent
    // ═══════════════════════════════════════════════════════════════════
    // NOTE: 'cowork_message' is itself one of getCoworkMessages' EXCLUDED
    // types (it's the raw agent-flush envelope, not user-visible thread
    // content) — use 'assistant' for rows meant to survive that filter.
    await insertCoworkMessage({
      id: 'msg-1', session_id: 'sess-A', user_id: 'erase-user', agent_id: null,
      message_type: 'assistant', role: 'user', content_preview: 'original preview',
      content_full: null, tool_name: null, tool_input_preview: null, tool_output_preview: null,
      token_usage: JSON.stringify({ input: 10, output: 20 }), model: 'claude-fable-5',
      flagged: 0, flag_reason: null, occurred_at: NOW - DAY, surface: 'cowork',
    });
    // Excluded-from-read message_type, same session.
    await insertCoworkMessage({
      id: 'msg-2', session_id: 'sess-A', user_id: 'erase-user', agent_id: null,
      message_type: 'cowork_api_request', role: null, content_preview: null,
      content_full: null, tool_name: null, tool_input_preview: null, tool_output_preview: null,
      token_usage: null, model: null, flagged: 0, flag_reason: null,
      occurred_at: NOW - DAY, surface: 'cowork',
    });
    // Duplicate id, different content — onConflictDoNothing() must NOT overwrite.
    await insertCoworkMessage({
      id: 'msg-1', session_id: 'sess-A', user_id: 'erase-user', agent_id: null,
      message_type: 'assistant', role: 'user', content_preview: 'SHOULD NOT WIN',
      content_full: null, tool_name: null, tool_input_preview: null, tool_output_preview: null,
      token_usage: JSON.stringify({ input: 999, output: 999 }), model: null,
      flagged: 0, flag_reason: null, occurred_at: NOW - DAY, surface: 'cowork',
    });

    expect(await hasCoworkContent()).toBe(true);
    expect(await getCoworkMessageCount()).toBe(4); // avg-cw-1/2 (Section 0) + msg-1, msg-2 (dup ignored)

    const sessA = await getCoworkMessages('sess-A', 100);
    expect(sessA.map((m) => m.id)).toEqual(['msg-1']); // msg-2 excluded by type
    expect(sessA[0].content_preview).toBe('original preview'); // dup did NOT overwrite
    expect(sessA[0].token_usage).toBe(JSON.stringify({ input: 10, output: 20 }));
    expect(typeof sessA[0].token_usage).toBe('string');
    // A second parse must still work — proves it's real JSON text, not a
    // double-encoded string (the pg jsonb write-inverse landmine).
    expect(JSON.parse(sessA[0].token_usage!)).toEqual({ input: 10, output: 20 });

    // ═══════════════════════════════════════════════════════════════════
    // SECTION 2 — flagged counts / getCodeEventCount / getRecentCoworkMessages
    // ═══════════════════════════════════════════════════════════════════
    await insertCoworkMessage({
      id: 'msg-4', session_id: 'sess-A', user_id: 'erase-user', agent_id: null,
      message_type: 'cowork_message', role: null, content_preview: null, content_full: null,
      tool_name: null, tool_input_preview: null, tool_output_preview: null, token_usage: null,
      model: null, flagged: 1, flag_reason: 'pii', occurred_at: NOW - DAY, surface: 'cowork',
    });
    await insertCoworkMessage({
      id: 'msg-5', session_id: 'sess-C', user_id: 'erase-user', agent_id: null,
      message_type: 'code_user_message', role: null, content_preview: null, content_full: null,
      tool_name: null, tool_input_preview: null, tool_output_preview: null, token_usage: null,
      model: null, flagged: 0, flag_reason: null, occurred_at: NOW - DAY, surface: 'code',
    });
    // Outside the 7-day getCodeEventCount window.
    await insertCoworkMessage({
      id: 'msg-6', session_id: 'sess-C', user_id: 'erase-user', agent_id: null,
      message_type: 'code_user_message', role: null, content_preview: null, content_full: null,
      tool_name: null, tool_input_preview: null, tool_output_preview: null, token_usage: null,
      model: null, flagged: 0, flag_reason: null, occurred_at: NOW - 10 * DAY, surface: 'code',
    });
    await insertCoworkMessage({
      id: 'msg-8', session_id: 'sess-C', user_id: 'erase-user', agent_id: null,
      message_type: 'code_user_message', role: null, content_preview: null, content_full: null,
      tool_name: null, tool_input_preview: null, tool_output_preview: null, token_usage: null,
      model: null, flagged: 1, flag_reason: 'pii', occurred_at: NOW - DAY, surface: 'code',
    });
    // NULL surface, direct insert (insertCoworkMessage's `|| 'cowork'` write
    // path can't produce a NULL — this exercises the read-side COALESCE).
    await db.insert(schema.coworkMessages).values({
      id: 'msg-7', session_id: 'sess-D', user_id: 'erase-user', message_type: 'assistant',
      surface: null, flagged: 0, occurred_at: NOW - DAY, source: 'agent',
    });
    // A control keep-user message, needed as a real FK target in Section 6.
    await insertCoworkMessage({
      id: 'msg-keep-1', session_id: 'sess-keep', user_id: 'keep-user', agent_id: null,
      message_type: 'cowork_message', role: null, content_preview: null, content_full: null,
      tool_name: null, tool_input_preview: null, tool_output_preview: null, token_usage: null,
      model: null, flagged: 0, flag_reason: null, occurred_at: NOW - DAY, surface: 'cowork',
    });

    expect(await getCoworkFlaggedCount()).toBe(1); // msg-4 (surface cowork, flagged)
    expect(await getCodeFlaggedCount()).toBe(1); // msg-8 (surface code, flagged)
    expect(await getCodeEventCount()).toBe(2); // msg-5, msg-8 (msg-6 outside 7d window)

    const recent = await getRecentCoworkMessages(100);
    // avg-cw-1/2 (Section 0) + msg-1,2,4,5,6,7,8,keep-1 (getRecentCoworkMessages has no type filter) = 10.
    expect(recent.length).toBe(10);
    // COALESCE(surface, 'cowork') — msg-7's DB column is really NULL (the
    // point of this fixture; getCoworkMessages' plain SELECT * does NOT
    // apply the COALESCE, so it would still read back NULL there), but
    // getRecentCoworkMessages must coalesce it: no NULL ever appears here.
    expect(recent.every((m) => m.surface !== null && m.surface !== undefined)).toBe(true);
    const msg7Raw = (await db.select().from(schema.coworkMessages).where(eq(schema.coworkMessages.id, 'msg-7')))[0];
    expect(msg7Raw.surface).toBeNull(); // the underlying column really is NULL

    expect(await getCoworkMessageCount()).toBe(10);

    // ═══════════════════════════════════════════════════════════════════
    // SECTION 3 — getRecentCoworkSessions (Policy A jsonb read, 3 columns)
    // ═══════════════════════════════════════════════════════════════════
    // upsertCoworkSession's WRITE contract for these 3 columns is the raw JS
    // value (array/object) — its jsonbCol() helper serialises it
    // itself. The CoworkSession interface types them as the
    // READ shape (`string | null`, a pre-encoded JSON string), so a raw
    // array here is a deliberate, narrow type escape.
    await upsertCoworkSession({
      id: 'cwsess-1', conversation_id: 'conv-1', user_id: 'erase-user',
      tools_available: ['bash', 'grep'], mcp_servers: ['github'],
      user_selected_folders: ['/tmp'], started_at: NOW - 2 * DAY,
    } as unknown as Parameters<typeof upsertCoworkSession>[0]);
    await upsertCoworkSession({
      id: 'cwsess-2', conversation_id: 'conv-2', user_id: 'keep-user',
      model: 'claude-x', started_at: NOW - DAY,
    });

    const sessions = await getRecentCoworkSessions(10);
    // created_at defaults to extract(epoch from now()) — 1-second
    // resolution, so two inserts in the same second
    // can tie; assert the SET (not a strict order) to avoid a timing flake.
    expect(sessions.map((s) => s.id).sort()).toEqual(['cwsess-1', 'cwsess-2']);
    const s1 = sessions.find((s) => s.id === 'cwsess-1')!;
    expect(s1.tools_available).toBe(JSON.stringify(['bash', 'grep']));
    expect(s1.mcp_servers).toBe(JSON.stringify(['github']));
    expect(s1.user_selected_folders).toBe(JSON.stringify(['/tmp']));
    expect(JSON.parse(s1.tools_available!)).toEqual(['bash', 'grep']);

    // ═══════════════════════════════════════════════════════════════════
    // SECTION 4 — chat messages
    // ═══════════════════════════════════════════════════════════════════
    await db.insert(schema.chatMessages).values([
      { id: 'chat-1', conversation_id: 'chatconv-1', user_id: 'erase-user', prompt_text: 'a', prompt_length: 1, flagged: 0, occurred_at: NOW - DAY },
      { id: 'chat-2', conversation_id: 'chatconv-1', user_id: 'erase-user', prompt_text: 'b', prompt_length: 1, flagged: 1, occurred_at: NOW - 2 * DAY },
      { id: 'chat-3', conversation_id: 'chatconv-2', user_id: 'keep-user', prompt_text: 'c', prompt_length: 1, flagged: 0, occurred_at: NOW - DAY },
    ]);

    // Running total including avg-chat-1/2 from Section 0 = 5.
    expect(await getChatMessageCount()).toBe(5);
    expect(await getChatFlaggedCount()).toBe(1); // chat-2 only

    const eraseChats = await getChatMessages({ userId: 'erase-user' });
    expect(eraseChats.map((m) => m.id)).toEqual(['chat-1', 'chat-2']); // desc by occurred_at
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((eraseChats[0] as any).user_display_name).toBe('Erase Me');

    const flaggedInConv1 = await getChatMessages({ conversationId: 'chatconv-1', flaggedOnly: true });
    expect(flaggedInConv1.map((m) => m.id)).toEqual(['chat-2']);

    const recentChat = await getRecentChatMessages(50);
    expect(recentChat.length).toBe(5);
    expect(recentChat.every((m) => typeof m.occurred_at === 'number')).toBe(true);

    // ═══════════════════════════════════════════════════════════════════
    // SECTION 5 — exportUserData (Policy A across 4 jsonb columns)
    // ═══════════════════════════════════════════════════════════════════
    await db.insert(schema.otelEvents).values([
      { id: 'otel-erase-1', user_id: 'erase-user', occurred_at: NOW - DAY, tool_input: JSON.stringify({ cmd: 'ls' }), token_usage: JSON.stringify({ input: 1, output: 2 }), file_paths: JSON.stringify(['a.ts']) },
      { id: 'otel-keep-1', user_id: 'keep-user', occurred_at: NOW - DAY },
    ]);
    await db.insert(schema.complianceEvents).values([
      { id: 'ce-erase-1', user_id: 'erase-user', event_type: 'pii_detected', surface: 'cowork', occurred_at: NOW - DAY, metadata: JSON.stringify({ flag: 'pii' }) },
      { id: 'ce-keep-1', user_id: 'keep-user', event_type: 'pii_detected', surface: 'cowork', occurred_at: NOW - DAY },
    ]);
    await db.insert(schema.analyticsSnapshots).values([
      { id: 'snap-erase-1', user_id: 'erase-user', snapshot_date: '2026-07-01' },
      { id: 'snap-keep-1', user_id: 'keep-user', snapshot_date: '2026-07-01' },
    ]);
    await db.insert(schema.alerts).values([
      { id: 'alert-erase-1', user_id: 'erase-user', alert_type: 'policy', severity: 'low', title: 'x', explanation: 'y', raw_evidence: JSON.stringify({ foo: 'bar' }) },
      { id: 'alert-keep-1', user_id: 'keep-user', alert_type: 'policy', severity: 'low', title: 'x', explanation: 'y' },
    ]);

    const exported = await exportUserData('erase-user');
    expect(exported).not.toBeNull();
    expect(exported!.user.id).toBe('erase-user');
    expect(exported!.cowork_messages.every((m) => m.user_id === 'erase-user')).toBe(true);
    // The export includes the person's Claude Chat prompts (chat-1, chat-2), not another person's.
    expect(exported!.chat_messages.map((m) => m.id)).toEqual(['chat-1', 'chat-2']);
    expect(exported!.chat_reply_metadata).toEqual([]);
    expect(exported!.otel_events.map((e) => e.id)).toEqual(['otel-erase-1']);
    expect(exported!.otel_events[0].tool_input).toBe(JSON.stringify({ cmd: 'ls' }));
    expect(exported!.otel_events[0].token_usage).toBe(JSON.stringify({ input: 1, output: 2 }));
    expect(exported!.otel_events[0].file_paths).toBe(JSON.stringify(['a.ts']));
    expect(exported!.compliance_events.map((e) => e.id)).toEqual(['ce-erase-1']);
    expect(exported!.compliance_events[0].metadata).toBe(JSON.stringify({ flag: 'pii' }));
    expect(exported!.analytics_snapshots.map((s) => s.id)).toEqual(['snap-erase-1']);
    expect(exported!.alerts.map((a) => a.id)).toEqual(['alert-erase-1']);
    expect(exported!.alerts[0].raw_evidence).toBe(JSON.stringify({ foo: 'bar' }));
    expect(await exportUserData('does-not-exist')).toBeNull();

    // ── getDbStats, pre-erasure — sane size + correct per-table counts ──
    const statsBefore = await getDbStats();
    expect(statsBefore.fileSizeBytes).toBeGreaterThan(0);
    expect(statsBefore.coworkCount).toBe(10);
    expect(statsBefore.otelCount).toBe(2);
    expect(statsBefore.complianceCount).toBe(2);
    expect(statsBefore.chatCount).toBe(5);
    expect(statsBefore.userCount).toBe(2);

    // ═══════════════════════════════════════════════════════════════════
    // SECTION 6 — deleteUserData (GDPR erasure, compliance-critical)
    // ═══════════════════════════════════════════════════════════════════
    await db.insert(schema.coworkSessions).values([
      { id: 'gdpr-cwsess-erase', conversation_id: 'gdpr-conv-erase', user_id: 'erase-user' },
      { id: 'gdpr-cwsess-keep', conversation_id: 'gdpr-conv-keep', user_id: 'keep-user' },
    ]);
    await db.insert(schema.agents).values([
      { id: 'agent-erase-1', user_id: 'erase-user', hostname: 'h1', os_type: 'linux', token_hash: 'th-erase-1', enrolled_at: NOW },
      { id: 'agent-keep-1', user_id: 'keep-user', hostname: 'h2', os_type: 'linux', token_hash: 'th-keep-1', enrolled_at: NOW },
    ]);
    const skillRows = await db
      .insert(schema.pulseSkills)
      .values([
        { skill_name: 'erase-skill', author_user_id: 'erase-user', first_seen_at: NOW, last_seen_at: NOW },
        { skill_name: 'keep-skill', author_user_id: 'keep-user', first_seen_at: NOW, last_seen_at: NOW },
      ])
      .returning({ id: schema.pulseSkills.id });
    const eraseSkillId: number = skillRows[0].id;
    const keepSkillId: number = skillRows[1].id;
    // pulse_skill_runs/pulse_classifications/pulse_events reference REAL
    // cowork_messages rows (msg-1 for erase-user, msg-keep-1 for keep-user)
    // — required on postgres, which enforces the FK for real.
    await db.insert(schema.pulseSkillRuns).values([
      { skill_id: eraseSkillId, user_id: 'erase-user', cowork_message_id: 'msg-1', ran_at: NOW },
      { skill_id: keepSkillId, user_id: 'keep-user', cowork_message_id: 'msg-keep-1', ran_at: NOW },
    ]);
    await db.insert(schema.pulseClassifications).values([
      { cowork_message_id: 'msg-1', user_id: 'erase-user', tier: 2, task_type: 'coding', classifier_confidence: 0.9, classifier_model: 'haiku', classified_at: NOW },
      { cowork_message_id: 'msg-keep-1', user_id: 'keep-user', tier: 1, task_type: 'coding', classifier_confidence: 0.9, classifier_model: 'haiku', classified_at: NOW },
    ]);
    await db.insert(schema.pulseEvents).values([
      { user_id: 'erase-user', event_type: 'frontier_push', title: 'x', cowork_message_id: 'msg-1', detected_at: NOW },
      { user_id: 'keep-user', event_type: 'frontier_push', title: 'x', cowork_message_id: 'msg-keep-1', detected_at: NOW },
    ]);
    await db.insert(schema.pulseTeamAssessments).values([
      { team_id: 'team-erase', assessment_date: '2026-07-01', assessed_by: 'erase-user', assessed_at: NOW },
      { team_id: 'team-keep', assessment_date: '2026-07-01', assessed_by: 'keep-user', assessed_at: NOW },
    ]);
    await db.insert(schema.pulseBaselines).values([
      { team_id: 'baseline-team-erase', set_by: 'erase-user', set_at: NOW },
      { team_id: 'baseline-team-keep', set_by: 'keep-user', set_at: NOW },
    ]);
    await db.insert(schema.pulseMetrics).values([
      { scope_type: 'user', scope_id: 'erase-user', period_start: NOW - DAY, period_end: NOW, computed_at: NOW },
      { scope_type: 'user', scope_id: 'keep-user', period_start: NOW - DAY, period_end: NOW, computed_at: NOW },
    ]);
    // GDPR erasure must also cover the per-user GitHub
    // attribution tables (migration 069). One row per user in
    // each of github_user_repo_stats / github_identity_map;
    // github_unmatched_authors is identity-keyed (not user-keyed) and
    // self-rewrites every sync, so it is deliberately excluded here too.
    await db.insert(schema.githubUserRepoStats).values([
      { user_id: 'erase-user', repo: 'org/repo-erase', date: '2026-08-01', commit_count: 3, synced_at: NOW },
      { user_id: 'keep-user', repo: 'org/repo-keep', date: '2026-08-01', commit_count: 5, synced_at: NOW },
    ]);
    await db.insert(schema.githubIdentityMap).values([
      { identity: 'login:erase-user', user_id: 'erase-user', created_at: NOW, created_by: null },
      { identity: 'login:keep-user', user_id: 'keep-user', created_at: NOW, created_by: null },
    ]);

    // Non-existent user → null, no side effects.
    expect(await deleteUserData('does-not-exist')).toBeNull();

    const result = await deleteUserData('erase-user');
    expect(result).not.toBeNull();
    // cowork_messages for erase-user: msg-1,2,4,5,6,7,8 = 7 (msg-keep-1 is
    // keep-user's, avg-cw-1/2 are erase-user's too from Section 0 → +2 = 9).
    // NOTE: the return TYPE only declares 6 fields, but the runtime `counts`
    // object (and therefore the actual return VALUE) also carries
    // chat_messages — matching the pre-existing behaviour exactly (the
    // original sync function had the same type/value mismatch).
    expect(result).toEqual({
      chat_messages: 2, // chat-1, chat-2 (Section 4)
      cowork_messages: 9,
      cowork_sessions: 2, // cwsess-1 (Section 3) + gdpr-cwsess-erase
      otel_events: 1,
      compliance_events: 1,
      analytics_snapshots: 1,
      alerts: 1, // alert-erase-1 only (the audit alert has user_id=null, never counted)
    });

    // ── Erasure completeness: erase-user's rows are GONE from every table ──
    expect((await db.select().from(schema.users).where(eq(schema.users.id, 'erase-user'))).length).toBe(0);
    expect((await db.select().from(schema.coworkMessages).where(eq(schema.coworkMessages.user_id, 'erase-user'))).length).toBe(0);
    expect((await db.select().from(schema.coworkSessions).where(eq(schema.coworkSessions.user_id, 'erase-user'))).length).toBe(0);
    expect((await db.select().from(schema.otelEvents).where(eq(schema.otelEvents.user_id, 'erase-user'))).length).toBe(0);
    expect((await db.select().from(schema.complianceEvents).where(eq(schema.complianceEvents.user_id, 'erase-user'))).length).toBe(0);
    expect((await db.select().from(schema.analyticsSnapshots).where(eq(schema.analyticsSnapshots.user_id, 'erase-user'))).length).toBe(0);
    expect((await db.select().from(schema.alerts).where(eq(schema.alerts.user_id, 'erase-user'))).length).toBe(0);
    expect((await db.select().from(schema.chatMessages).where(eq(schema.chatMessages.user_id, 'erase-user'))).length).toBe(0);
    expect((await db.select().from(schema.agents).where(eq(schema.agents.user_id, 'erase-user'))).length).toBe(0);
    expect((await db.select().from(schema.pulseSkillRuns).where(eq(schema.pulseSkillRuns.user_id, 'erase-user'))).length).toBe(0);
    expect((await db.select().from(schema.pulseClassifications).where(eq(schema.pulseClassifications.user_id, 'erase-user'))).length).toBe(0);
    expect((await db.select().from(schema.pulseEvents).where(eq(schema.pulseEvents.user_id, 'erase-user'))).length).toBe(0);
    expect((await db.select().from(schema.pulseTeamAssessments).where(eq(schema.pulseTeamAssessments.assessed_by, 'erase-user'))).length).toBe(0);
    expect((await db.select().from(schema.pulseBaselines).where(eq(schema.pulseBaselines.set_by, 'erase-user'))).length).toBe(0);
    expect((await db.select().from(schema.pulseMetrics).where(eq(schema.pulseMetrics.scope_id, 'erase-user'))).length).toBe(0);
    expect((await db.select().from(schema.githubUserRepoStats).where(eq(schema.githubUserRepoStats.user_id, 'erase-user'))).length).toBe(0);
    expect((await db.select().from(schema.githubIdentityMap).where(eq(schema.githubIdentityMap.user_id, 'erase-user'))).length).toBe(0);

    // pulse_skills is ANONYMISED (author_user_id → NULL), not deleted.
    const eraseSkillRow = (await db.select().from(schema.pulseSkills).where(eq(schema.pulseSkills.id, eraseSkillId)))[0];
    expect(eraseSkillRow).toBeDefined();
    expect(eraseSkillRow.author_user_id).toBeNull();

    // ── Selectivity: keep-user's rows in every one of the same tables survive ──
    expect((await db.select().from(schema.users).where(eq(schema.users.id, 'keep-user'))).length).toBe(1);
    expect((await db.select().from(schema.coworkMessages).where(eq(schema.coworkMessages.user_id, 'keep-user'))).length).toBeGreaterThan(0);
    expect((await db.select().from(schema.coworkSessions).where(eq(schema.coworkSessions.user_id, 'keep-user'))).length).toBe(2);
    expect((await db.select().from(schema.otelEvents).where(eq(schema.otelEvents.user_id, 'keep-user'))).length).toBe(1);
    expect((await db.select().from(schema.complianceEvents).where(eq(schema.complianceEvents.user_id, 'keep-user'))).length).toBe(1);
    expect((await db.select().from(schema.analyticsSnapshots).where(eq(schema.analyticsSnapshots.user_id, 'keep-user'))).length).toBe(1);
    expect((await db.select().from(schema.alerts).where(eq(schema.alerts.user_id, 'keep-user'))).length).toBe(1);
    expect((await db.select().from(schema.chatMessages).where(eq(schema.chatMessages.user_id, 'keep-user'))).length).toBeGreaterThan(0);
    expect((await db.select().from(schema.agents).where(eq(schema.agents.user_id, 'keep-user'))).length).toBe(1);
    expect((await db.select().from(schema.pulseSkillRuns).where(eq(schema.pulseSkillRuns.user_id, 'keep-user'))).length).toBe(1);
    expect((await db.select().from(schema.pulseClassifications).where(eq(schema.pulseClassifications.user_id, 'keep-user'))).length).toBe(1);
    expect((await db.select().from(schema.pulseEvents).where(eq(schema.pulseEvents.user_id, 'keep-user'))).length).toBe(1);
    expect((await db.select().from(schema.pulseTeamAssessments).where(eq(schema.pulseTeamAssessments.assessed_by, 'keep-user'))).length).toBe(1);
    expect((await db.select().from(schema.pulseBaselines).where(eq(schema.pulseBaselines.set_by, 'keep-user'))).length).toBe(1);
    expect((await db.select().from(schema.pulseMetrics).where(eq(schema.pulseMetrics.scope_id, 'keep-user'))).length).toBe(1);
    expect((await db.select().from(schema.githubUserRepoStats).where(eq(schema.githubUserRepoStats.user_id, 'keep-user'))).length).toBe(1);
    expect((await db.select().from(schema.githubIdentityMap).where(eq(schema.githubIdentityMap.user_id, 'keep-user'))).length).toBe(1);
    const keepSkillRow = (await db.select().from(schema.pulseSkills).where(eq(schema.pulseSkills.id, keepSkillId)))[0];
    expect(keepSkillRow.author_user_id).toBe('keep-user');

    // ── The audit alert (user_id=null) survives — the compliance trail itself. ──
    const auditAlerts = await db.select().from(schema.alerts).where(eq(schema.alerts.title, 'User data erased (GDPR)'));
    expect(auditAlerts.length).toBe(1);
    expect(auditAlerts[0].user_id).toBeNull();
    expect(auditAlerts[0].alert_type).toBe('policy');

    // ── getDbStats, post-erasure — counts reflect the erasure ──
    const statsAfter = await getDbStats();
    expect(statsAfter.userCount).toBe(1); // keep-user only
    expect(statsAfter.otelCount).toBe(1);
    expect(statsAfter.complianceCount).toBe(1);
    expect(statsAfter.fileSizeBytes).toBeGreaterThan(0);

    // ═══════════════════════════════════════════════════════════════════
    // SECTION 7 — Erasure blockers: NO ACTION FKs on
    // cowork_session_stats.user_id / chat_assistant_meta.user_id / the
    // users.manager_id self-FK. Fresh users, distinct from Section 6's
    // erase-user/keep-user, to keep this section's counts self-contained.
    // ═══════════════════════════════════════════════════════════════════
    await db.insert(schema.users).values([
      { id: 'gdpr-blk-target', email: 'gdpr-blk-target@test.local' },
      { id: 'gdpr-blk-report', email: 'gdpr-blk-report@test.local', manager_id: 'gdpr-blk-target' },
      { id: 'gdpr-blk-control', email: 'gdpr-blk-control@test.local' },
    ]);
    // cowork_session_stats.session_id also carries a real FK → cowork_sessions
    // (postgres migration), so a matching parent row is required.
    await db.insert(schema.coworkSessions).values([
      { id: 'gdpr-blk-sess-1', conversation_id: 'gdpr-blk-conv-1', user_id: 'gdpr-blk-target' },
      { id: 'gdpr-blk-sess-2', conversation_id: 'gdpr-blk-conv-2', user_id: 'gdpr-blk-control' },
    ]);
    await db.insert(schema.coworkSessionStats).values([
      { session_id: 'gdpr-blk-sess-1', user_id: 'gdpr-blk-target', computed_at: NOW },
      { session_id: 'gdpr-blk-sess-2', user_id: 'gdpr-blk-control', computed_at: NOW },
    ]);
    await db.insert(schema.chatAssistantMeta).values([
      { id: 'gdpr-blk-cam-1', user_id: 'gdpr-blk-target', occurred_at: NOW },
      { id: 'gdpr-blk-cam-2', user_id: 'gdpr-blk-control', occurred_at: NOW },
    ]);

    // Erasure must complete although stats, chat metadata and a manager link
    // reference the target, and must remove or clear only the target's rows.
    await deleteUserData('gdpr-blk-target');

    const statsLeft = await db.select().from(schema.coworkSessionStats);
    expect(statsLeft.map((r: { session_id: string }) => r.session_id)).toEqual(['gdpr-blk-sess-2']);
    const chatMetaLeft = await db.select().from(schema.chatAssistantMeta);
    expect(chatMetaLeft.map((r: { id: string }) => r.id)).toEqual(['gdpr-blk-cam-2']);
    const report = await db.select().from(schema.users).where(eq(schema.users.id, 'gdpr-blk-report'));
    expect(report[0].manager_id).toBeNull();
    const target = await db.select().from(schema.users).where(eq(schema.users.id, 'gdpr-blk-target'));
    expect(target).toEqual([]);

    // ═══════════════════════════════════════════════════════════════════
    // SECTION 8 — Erasure remnants: code tables + use-case ownership.
    // Fresh users again, self-contained from Sections 6/7.
    // ═══════════════════════════════════════════════════════════════════
    await db.insert(schema.users).values([
      { id: 'gdpr-rem-target', email: 'gdpr-rem-target@test.local' },
      { id: 'gdpr-rem-control', email: 'gdpr-rem-control@test.local' },
    ]);

    await db.insert(schema.codeAssistantMeta).values([
      { id: 'gdpr-rem-a1', user_id: 'gdpr-rem-target', session_id: 's1', occurred_at: NOW },
      { id: 'gdpr-rem-a2', user_id: 'gdpr-rem-control', session_id: 's2', occurred_at: NOW },
    ]);
    // first_at/last_at/computed_at: NOT NULL on the real schema.
    await db.insert(schema.codeSessionStats).values([
      { session_id: 's1', user_id: 'gdpr-rem-target', first_at: NOW, last_at: NOW, computed_at: NOW },
      { session_id: 's2', user_id: 'gdpr-rem-control', first_at: NOW, last_at: NOW, computed_at: NOW },
    ]);
    await db.insert(schema.codeOtelMetrics).values([
      { id: 'gdpr-rem-o1', user_id: 'gdpr-rem-target', metric_name: 'claude_code.lines_of_code.count', value: 5, occurred_at: NOW },
    ]);
    // classified_at: NOT NULL on the real schema — same note as above.
    await db.insert(schema.codeSessionClassifications).values([
      { session_id: 's1', user_id: 'gdpr-rem-target', work_type: 'other', tier: 1, confidence: 0.9, classifier_model: 'm', classified_at: NOW },
    ]);
    // period_start/period_end: NOT NULL on the real schema — same note.
    await db.insert(schema.codeMetrics).values([
      { scope_type: 'user', scope_id: 'gdpr-rem-target', granularity: 'rolling', period_start: NOW - DAY, period_end: NOW, computed_at: NOW },
      { scope_type: 'organisation', scope_id: '__org__', granularity: 'rolling', period_start: NOW - DAY, period_end: NOW, computed_at: NOW },
    ]);
    await db.insert(schema.useCases).values([
      { id: 'gdpr-rem-uc', title: 'T', owner_user_id: 'gdpr-rem-target', created_at: NOW },
    ]);
    await db.insert(schema.useCaseWeekMatches).values([
      { use_case_id: 'gdpr-rem-uc', week_start: NOW, user_id: 'gdpr-rem-target' },
      { use_case_id: 'gdpr-rem-uc', week_start: NOW, user_id: 'gdpr-rem-control' },
    ]);
    // Coaching acknowledgements (migration 072): a target row
    // must be erased, a control row on the same use case survives.
    await db.insert(schema.coachingAcks).values([
      { user_id: 'gdpr-rem-target', use_case_id: 'gdpr-rem-uc', acked_by: 'admin@test.local', acked_at: NOW },
      { user_id: 'gdpr-rem-control', use_case_id: 'gdpr-rem-uc', acked_by: 'admin@test.local', acked_at: NOW },
    ]);
    // pulse_briefings: a user-scope row (contains the
    // target's display name in generated prose) must be erased; an org-scope
    // row is not personal data and must survive.
    await db.insert(schema.pulseBriefings).values([
      { scope_type: 'user', scope_id: 'gdpr-rem-target', period_start: NOW - 7 * DAY, period_end: NOW, body: 'Target briefing prose naming the person.', model: 'claude-haiku-4-5-20251001', generated_at: NOW },
      { scope_type: 'organisation', scope_id: '__org__', period_start: NOW - 7 * DAY, period_end: NOW, body: 'Org-wide briefing prose.', model: 'claude-haiku-4-5-20251001', generated_at: NOW },
    ]);

    await deleteUserData('gdpr-rem-target');

    expect((await db.select().from(schema.codeAssistantMeta)).map((r: { id: string }) => r.id)).toEqual(['gdpr-rem-a2']);
    // Scoped to this section's own session ids — Section 0 already left
    // unrelated (user_id-less) rows ('avg-code-a'/'avg-code-b') in this
    // table that deleteUserData correctly never touches.
    const sessionStatsLeft = await db.select().from(schema.codeSessionStats).where(inArray(schema.codeSessionStats.session_id, ['s1', 's2']));
    expect(sessionStatsLeft.map((r: { session_id: string }) => r.session_id)).toEqual(['s2']);
    expect(await db.select().from(schema.codeOtelMetrics)).toEqual([]);
    expect(await db.select().from(schema.codeSessionClassifications)).toEqual([]);
    const metricsLeft = await db.select().from(schema.codeMetrics);
    expect(metricsLeft).toHaveLength(1);                        // org row SURVIVES
    expect(metricsLeft[0].scope_type).toBe('organisation');
    const uc = await db.select().from(schema.useCases).where(eq(schema.useCases.id, 'gdpr-rem-uc'));
    expect(uc[0].owner_user_id).toBeNull();                     // row survives, attribution gone
    const matches = await db.select().from(schema.useCaseWeekMatches);
    expect(matches.map((m: { user_id: string }) => m.user_id)).toEqual(['gdpr-rem-control']);
    const acksLeft = await db.select().from(schema.coachingAcks);
    expect(acksLeft.map((r: { user_id: string }) => r.user_id)).toEqual(['gdpr-rem-control']);
    // pulse_briefings: user-scope row gone, org-scope row survives.
    const briefingsLeft = await db.select().from(schema.pulseBriefings);
    expect(briefingsLeft.map((r: { scope_type: string; scope_id: string }) => `${r.scope_type}:${r.scope_id}`)).toEqual(['organisation:__org__']);
  } finally {
    await cleanup();
  }
}

describe('cowork/chat/gdpr/stats (postgres)', () => {
  it(
    'insertCoworkMessage/getCoworkMessages/getRecentCoworkSessions/chat/exportUserData/deleteUserData/getDbStats behave correctly on postgres — proves the jsonb round trips + GDPR erasure completeness (incl. FK-ordered deletes + savepointEach tolerance) + pg_database_size()',
    async () => {
      await runSpec();
    },
    180_000,
  );
});
