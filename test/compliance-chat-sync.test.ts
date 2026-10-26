// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// lib/compliance/chat-sync.ts (part 1: resolveUserByEmail + syncChat).
//
// Covers, against a mocked getChatMessages (global.fetch dispatched by URL):
//   1. Prompts inserted: user messages -> chat_messages (prompt_text/length,
//      conversation_id, attachments_count = files.length, agent_id NULL,
//      occurred_at from created_at).
//   2. Assistant metadata: assistant messages -> chat_assistant_meta (model
//      from the CHAT object, artifacts/generated_files counts) — no text
//      column exists on that table at all, so "no text stored" is structural.
//   3. Flagging: a prompt containing a credit-card-shaped string gets
//      flagged=1, flag_reason containing 'PII detected', and ONE alert row.
//   4. Alert-once gating: syncChat run twice for the same fixture creates the
//      flagged row once and does not create a second alert.
//   5. Retention/backfill floor: a message older than minOccurredAtS is
//      skipped entirely (no row in chat_messages or chat_assistant_meta).
//   6. User resolution: an existing users.email matches case-insensitively
//      and reuses that row's id; an unknown email creates both a users row
//      (id = claude.ai user id) and an admin_users row with password_hash
//      '__otel_pending__'.
//   7. Pagination: has_more=true then a second page — both pages ingested.
//
// Part 2: runChatSync (the run loop: cursor discipline, backfill
// window, per-run cap). Covers, against the same URL-dispatched fetch mock
// plus the REAL getConfigValue/setConfigValue (config table from the real
// Postgres migrations):
//   1. No key configured -> zeros, no fetch calls at all.
//   2. First run (no saved cursor): listChats called with updated_at.gte,
//      no after_id; after a successful page, complianceChatCursor is set to
//      the page's last_id.
//   3. Subsequent run: listChats called with after_id = the saved cursor,
//      no updated_at.gte.
//   4. Batch cap: complianceChatsPerRun='1' against a 2-chat page. The cap
//      check runs BEFORE processing the page (chatsProcessed + page length
//      > cap), so the whole page is skipped this run — zero chats synced,
//      no per-chat message fetch at all, cursor unchanged. Raising the cap
//      and re-running re-lists the SAME page (cursor untouched) and this
//      time processes it in full — the capped page is free to re-list.
//   5. Abort-on-failure: syncChat's message fetch 500s for a chat -> the run
//      records the error and returns immediately; the cursor does NOT
//      advance past its pre-run value.
//   6. 404 on a chat's messages (hard-deleted between list and fetch): that
//      chat is counted as a legitimate skip, the run continues to the next
//      chat in the page, and the cursor advances past the whole page.
//   7. Regression: a chat spans 2 message pages; page 1's
//      PII-flagged message commits + alerts, page 2 501s. The run records
//      the error AND the page-1 alert survives (per-page alert flush, not
//      flushed once after the whole while-loop).
//   8. Regression: complianceChatsPerRun below the API's
//      default page size (100) no longer stalls forever — runChatSync
//      requests limit = min(100, cap), so a limit-honouring mock shows
//      real chats processed and the cursor advancing across runs.
//
// HARNESS RULE (copied from test/anthropic-ingest-governance-pg.test.ts): the
// modules under test reach the database through getClient(), which binds
// to DATABASE_URL on first use, so the module under test (and
// schema/json helpers) are DYNAMIC-imported AFTER createTestDbClient('postgres')
// has set DATABASE_URL + reset modules.
import { describe, it, expect, vi } from 'vitest';

const NOW = Math.floor(Date.now() / 1000);

/** Minimal fetch Response stand-in — only what complianceGet uses. */
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
    const { eq } = await import('drizzle-orm');
    const { resolveUserByEmail, syncChat } = await import('@/lib/compliance/chat-sync');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = client as any;

    // Pre-existing user for the case-insensitive email-match branch of
    // Behaviour 6 (below).
    await db.insert(schema.users).values({
      id: 'user-exist', email: 'user@test.local', first_seen_at: NOW - 10_000, last_seen_at: NOW - 10_000,
    });

    const minOccurredAtS = NOW - 3_600; // backfill/retention floor for Behaviour 5

    // ════════════════════════════════════════════════════════════════════
    // chat-A fixture: covers Behaviours 1, 2, 3, 5, 7 (prompts, assistant
    // metadata, PII flagging + alert, retention floor, pagination) and the
    // KNOWN-email branch of Behaviour 6 (case-insensitive match reuses
    // 'user-exist').
    // ════════════════════════════════════════════════════════════════════
    const chatA = {
      id: 'chat-a', name: null, created_at: new Date(NOW * 1000).toISOString(),
      updated_at: new Date(NOW * 1000).toISOString(), deleted_at: null,
      model: 'claude-sonnet-5', project_id: null, organization_uuid: null,
      user: { id: 'claude-user-known-1', email_address: 'USER@Test.Local' },
    };

    const m1CreatedAt = new Date((NOW - 100) * 1000).toISOString();
    const m2CreatedAt = new Date((NOW - 90) * 1000).toISOString();
    const m3CreatedAt = new Date((NOW - 80) * 1000).toISOString();
    const m4CreatedAt = new Date((NOW - 100_000) * 1000).toISOString(); // older than the floor
    const m5CreatedAt = new Date((NOW - 50) * 1000).toISOString();

    // fix/compliance-sync-efficiency: every messages request must carry the
    // retention floor as created_at.gte, so Anthropic omits pre-floor history
    // instead of us paging through it and discarding it.
    const messagesUrls: string[] = [];

    global.fetch = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes('/messages')) messagesUrls.push(u);
      if (u.includes('/compliance/apps/chats/chat-a/messages')) {
        if (u.includes('after_id=m4')) {
          return jsonResponse({
            chat_messages: [
              { id: 'm5', role: 'user', created_at: m5CreatedAt, content: [{ type: 'text', text: 'Another normal prompt' }], files: [] },
            ],
            has_more: false, first_id: 'm5', last_id: 'm5',
          });
        }
        return jsonResponse({
          chat_messages: [
            { id: 'm1', role: 'user', created_at: m1CreatedAt, content: [{ type: 'text', text: 'Please summarise this document' }], files: [{ id: 'f1', filename: 'a.pdf', mime_type: 'application/pdf' }] },
            {
              id: 'm2', role: 'assistant', created_at: m2CreatedAt, content: [{ type: 'text', text: 'Sure — here is a summary.' }],
              artifacts: [{ id: 'art-1', version_id: 'v1', title: 'Summary', artifact_type: 'text' }],
              generated_files: [{ id: 'gf-1', filename: 'summary.txt', mime_type: 'text/plain' }],
            },
            { id: 'm3', role: 'user', created_at: m3CreatedAt, content: [{ type: 'text', text: 'my card 4111 1111 1111 1111' }], files: [] },
            { id: 'm4', role: 'user', created_at: m4CreatedAt, content: [{ type: 'text', text: 'Ancient message before the floor' }], files: [] },
          ],
          has_more: true, first_id: 'm1', last_id: 'm4',
        });
      }
      if (u.includes('/compliance/apps/chats/chat-b/messages')) {
        return jsonResponse({
          chat_messages: [
            { id: 'm6', role: 'user', created_at: new Date((NOW - 20) * 1000).toISOString(), content: [{ type: 'text', text: 'Hi there' }], files: [] },
          ],
          has_more: false, first_id: 'm6', last_id: 'm6',
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as unknown as typeof fetch;

    const result1 = await syncChat(db, 'test-key', chatA, minOccurredAtS);

    // fix/compliance-sync-efficiency — the retention floor is sent to the API
    // on EVERY page, not just the first, so a paginated walk never re-reads
    // pre-floor history.
    const floorIso = new Date(minOccurredAtS * 1000).toISOString();
    expect(messagesUrls.length).toBeGreaterThanOrEqual(2);
    for (const u of messagesUrls) {
      expect(u).toContain(`created_at.gte=${encodeURIComponent(floorIso)}`);
    }

    // Behaviour 7 — pagination: both pages' user messages landed (m1, m3 from
    // page 1; m5 from page 2). m4 was skipped by the floor (Behaviour 5).
    expect(result1.prompts).toBe(3);
    expect(result1.assistantMeta).toBe(1);
    expect(result1.connectors).toBe(0); // no tool_use blocks in this fixture

    // Behaviour 1 — prompt fields.
    const m1Row = (await db.select().from(schema.chatMessages).where(eq(schema.chatMessages.id, 'm1')))[0];
    expect(m1Row).toBeTruthy();
    expect(m1Row.prompt_text).toBe('Please summarise this document');
    expect(m1Row.prompt_length).toBe('Please summarise this document'.length);
    expect(m1Row.conversation_id).toBe('chat-a');
    expect(m1Row.attachments_count).toBe(1);
    expect(m1Row.agent_id).toBeNull();
    expect(m1Row.source).toBe('compliance'); // CT9: explicit provenance, not inferred from agent_id
    expect(Number(m1Row.occurred_at)).toBe(NOW - 100);

    // Behaviour 6 (known-email branch) — case-insensitive match reused the
    // EXISTING row id, not the chat's claude.ai user id.
    expect(m1Row.user_id).toBe('user-exist');

    // Behaviour 2 — assistant metadata only, no text column exists on the
    // table at all (structural guarantee), model/counts from the chat + arrays.
    const m2Row = (await db.select().from(schema.chatAssistantMeta).where(eq(schema.chatAssistantMeta.id, 'm2')))[0];
    expect(m2Row).toBeTruthy();
    expect(m2Row.model).toBe('claude-sonnet-5');
    expect(m2Row.artifacts_count).toBe(1);
    expect(m2Row.generated_files_count).toBe(1);
    expect(m2Row.user_id).toBe('user-exist');
    expect(Object.keys(m2Row)).not.toContain('text');
    expect(Object.keys(m2Row)).not.toContain('prompt_text');

    // Behaviour 3 — PII flagging + exactly one alert.
    // NOTE: 4111 1111 1111 1111 with single spaces between groups matches
    // lib/pii/detect.ts's credit_card pattern (\d{4}[\s-]?\d{4}[\s-]?\d{4}
    // [\s-]?\d{4}) exactly — no fixture adaptation needed.
    const m3Row = (await db.select().from(schema.chatMessages).where(eq(schema.chatMessages.id, 'm3')))[0];
    expect(m3Row).toBeTruthy();
    expect(m3Row.flagged).toBe(1);
    expect(m3Row.flag_reason).toContain('PII detected');
    expect(m3Row.flag_reason).toContain('credit_card');

    const alertsAfterFirstRun = await db.select().from(schema.alerts);
    expect(alertsAfterFirstRun.length).toBe(1);
    expect(alertsAfterFirstRun[0].alert_type).toBe('policy');

    // Behaviour 5 — retention/backfill floor: m4 (older than minOccurredAtS)
    // produced no row in either table.
    const m4Rows = await db.select().from(schema.chatMessages).where(eq(schema.chatMessages.id, 'm4'));
    expect(m4Rows.length).toBe(0);

    // Behaviour 7 (page 2) — m5 landed too.
    const m5Row = (await db.select().from(schema.chatMessages).where(eq(schema.chatMessages.id, 'm5')))[0];
    expect(m5Row).toBeTruthy();
    expect(m5Row.prompt_text).toBe('Another normal prompt');

    // ════════════════════════════════════════════════════════════════════
    // Behaviour 4 — alert-once gating: re-run syncChat for the SAME chat-A
    // fixture. The flagged row (m3) already exists so it's skipped before
    // PII detection even runs again; the alert count must stay at 1.
    // ════════════════════════════════════════════════════════════════════
    const result2 = await syncChat(db, 'test-key', chatA, minOccurredAtS);
    expect(result2.prompts).toBe(0); // all three user messages already exist -> exists-gate skips each

    const chatMessagesCount = await db.select().from(schema.chatMessages);
    expect(chatMessagesCount.length).toBe(3); // m1, m3, m5 — still exactly one row each, no duplicates

    const alertsAfterSecondRun = await db.select().from(schema.alerts);
    expect(alertsAfterSecondRun.length).toBe(1); // NOT 2 — alert-once gating held

    // ════════════════════════════════════════════════════════════════════
    // Behaviour 6 (unknown-email branch) — chat-B's user is unseen: creates
    // a users row keyed on the claude.ai user id AND an admin_users sentinel
    // row with password_hash '__otel_pending__'.
    // ════════════════════════════════════════════════════════════════════
    const chatB = {
      id: 'chat-b', name: null, created_at: new Date(NOW * 1000).toISOString(),
      updated_at: new Date(NOW * 1000).toISOString(), deleted_at: null,
      model: 'claude-haiku-4-5', project_id: null, organization_uuid: null,
      user: { id: 'claude-user-new-1', email_address: 'newuser@test.local' },
    };

    const result3 = await syncChat(db, 'test-key', chatB, minOccurredAtS);
    expect(result3.prompts).toBe(1);
    expect(result3.connectors).toBe(0); // no tool_use blocks in this fixture

    const newUserRows = await db.select().from(schema.users).where(eq(schema.users.id, 'claude-user-new-1'));
    expect(newUserRows.length).toBe(1);
    expect(newUserRows[0].email).toBe('newuser@test.local');

    const newAdminRows = await db.select().from(schema.adminUsers).where(eq(schema.adminUsers.id, 'claude-user-new-1'));
    expect(newAdminRows.length).toBe(1);
    expect(newAdminRows[0].password_hash).toBe('__otel_pending__');
    expect(newAdminRows[0].role).toBe('pulse');
    expect(newAdminRows[0].linked_cowork_user_id).toBe('claude-user-new-1');

    // Direct resolveUserByEmail exercise: calling it again with the now-known
    // 'newuser@test.local' email reuses the SAME id rather than creating a
    // second users/admin_users row.
    const reresolved = await resolveUserByEmail(db, 'NewUser@Test.Local', 'some-other-fallback-id', NOW);
    expect(reresolved).toBe('claude-user-new-1');
    const adminRowsAfterReresolve = await db.select().from(schema.adminUsers).where(eq(schema.adminUsers.id, 'claude-user-new-1'));
    expect(adminRowsAfterReresolve.length).toBe(1); // still exactly one — no duplicate sentinel row

    // ════════════════════════════════════════════════════════════════════
    // chat-C fixture: connector invocations from tool_use blocks.
    // One assistant message carries four tool_use blocks:
    //   1. integration_name='linear' -> named connector, gets a library entry.
    //   2. mcp_server_url only (no integration_name) -> mcp_server derived
    //      from the URL host, gets a library entry.
    //   3. bare tool_use (neither field) -> built-in tool, skipped entirely
    //      (no invocation row at all).
    //   4. integration_name='workspace' (system name) -> invocation row IS
    //      written, but NO library entry (system names excluded).
    //   5./6. integration_name='File Creation' / 'Dynamic Widget' -> Claude.ai
    //      built-in tool families (observed in the first real tenant
    //      sync) -> skipped entirely, no invocation row, no library
    //      entry. Case-insensitive.
    // Each qualifying block's `input` carries a sentinel string that must
    // never be read/persisted (block.input is never touched by the design).
    // ════════════════════════════════════════════════════════════════════
    const chatC = {
      id: 'chat-c', name: null, created_at: new Date(NOW * 1000).toISOString(),
      updated_at: new Date(NOW * 1000).toISOString(), deleted_at: null,
      model: 'claude-sonnet-5', project_id: null, organization_uuid: null,
      user: { id: 'claude-user-connectors-1', email_address: 'connectors@test.local' },
    };
    const cM1CreatedAt = new Date((NOW - 40) * 1000).toISOString();
    const SENTINEL = 'SENTINEL_INPUT_VALUE_SHOULD_NEVER_PERSIST';

    global.fetch = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes('/compliance/apps/chats/chat-c/messages')) {
        return jsonResponse({
          chat_messages: [
            {
              id: 'c-m1', role: 'assistant', created_at: cM1CreatedAt,
              content: [
                { type: 'text', text: 'Working on it.' },
                { type: 'tool_use', name: 'create_issue', integration_name: 'linear', input: { secret: SENTINEL } },
                { type: 'tool_use', name: 'fetch_data', mcp_server_url: 'https://mcp.example.com/foo/bar', input: { secret: SENTINEL } },
                { type: 'tool_use', name: 'bash', input: { command: 'ls', secret: SENTINEL } },
                { type: 'tool_use', name: 'list_files', integration_name: 'workspace', input: { secret: SENTINEL } },
                { type: 'tool_use', name: 'create_file', integration_name: 'File Creation', input: { secret: SENTINEL } },
                { type: 'tool_use', name: 'ask_user_input_v0', integration_name: 'dynamic widget', input: { secret: SENTINEL } },
                { type: 'tool_use', name: 'web_fetch', integration_name: 'Web Fetch', input: { secret: SENTINEL } },
                { type: 'tool_use', name: 'tool_search', integration_name: 'Tool Search', input: { secret: SENTINEL } },
                // A real connector whose name also contains a space — must still be captured.
                { type: 'tool_use', name: 'search_files', integration_name: 'Google Drive', input: { secret: SENTINEL } },
              ],
            },
          ],
          has_more: false, first_id: 'c-m1', last_id: 'c-m1',
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as unknown as typeof fetch;

    const resultC1 = await syncChat(db, 'test-key', chatC, minOccurredAtS);
    expect(resultC1.connectors).toBe(4); // linear, mcp.example.com host, workspace, Google Drive — bare 'bash' + 4 built-in families skipped

    const invocationsChatC = await db.select().from(schema.coworkMcpInvocations)
      .where(eq(schema.coworkMcpInvocations.session_id, 'chat-c'));
    expect(invocationsChatC.length).toBe(4);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(invocationsChatC.find((r: any) => r.mcp_server === 'Google Drive')?.mcp_tool).toBe('search_files');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(invocationsChatC.find((r: any) => r.mcp_tool === 'web_fetch')).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(invocationsChatC.find((r: any) => r.mcp_tool === 'tool_search')).toBeUndefined();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const linearInvocation = invocationsChatC.find((r: any) => r.mcp_server === 'linear');
    expect(linearInvocation).toBeTruthy();
    expect(linearInvocation.mcp_tool).toBe('create_issue');
    expect(linearInvocation.surface).toBe('chat');
    expect(linearInvocation.source).toBe('compliance');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const urlHostInvocation = invocationsChatC.find((r: any) => r.mcp_server === 'mcp.example.com');
    expect(urlHostInvocation).toBeTruthy();
    expect(urlHostInvocation.mcp_tool).toBe('fetch_data');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const workspaceInvocation = invocationsChatC.find((r: any) => r.mcp_server === 'workspace');
    expect(workspaceInvocation).toBeTruthy(); // invocation row allowed for system names
    expect(workspaceInvocation.mcp_tool).toBe('list_files');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bareInvocation = invocationsChatC.find((r: any) => r.mcp_tool === 'bash');
    expect(bareInvocation).toBeUndefined(); // built-in tool, no connector signal — skipped

    // Claude.ai built-in tool families carry an integration_name but are NOT
    // connectors — no invocation row, and (asserted below) no library entry.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(invocationsChatC.find((r: any) => r.mcp_tool === 'create_file')).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(invocationsChatC.find((r: any) => r.mcp_tool === 'ask_user_input_v0')).toBeUndefined();

    // block.input is never read/persisted — the sentinel must appear nowhere
    // in the invocation rows (structural proof we never reference block.input).
    expect(JSON.stringify(invocationsChatC)).not.toContain(SENTINEL);

    const libraryEntries = await db.select().from(schema.skillLibraryEntries);
    // Built-in tool families never reach the S&C Board.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(libraryEntries.find((e: any) => /file creation|dynamic widget|web fetch|tool search/i.test(e.name))).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const linearEntry = libraryEntries.find((e: any) => e.name === 'linear');
    expect(linearEntry).toBeTruthy();
    expect(linearEntry.type).toBe('connector');
    expect(linearEntry.surface).toBe('chat');
    expect(linearEntry.source).toBe('org');
    expect(linearEntry.is_published).toBe(0);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const urlHostEntry = libraryEntries.find((e: any) => e.name === 'mcp.example.com');
    expect(urlHostEntry).toBeTruthy();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const workspaceEntry = libraryEntries.find((e: any) => e.name === 'workspace');
    expect(workspaceEntry).toBeUndefined(); // system name excluded from library registration

    // Idempotency — re-syncing the same chat must not create duplicate
    // invocation rows (the (session_id, mcp_server, mcp_tool, occurred_at)
    // unique index dedups); the returned connectors count reflects blocks
    // processed again this run, independent of the dedup outcome.
    const resultC2 = await syncChat(db, 'test-key', chatC, minOccurredAtS);
    expect(resultC2.connectors).toBe(4);
    const invocationsChatCAfterResync = await db.select().from(schema.coworkMcpInvocations)
      .where(eq(schema.coworkMcpInvocations.session_id, 'chat-c'));
    expect(invocationsChatCAfterResync.length).toBe(4); // still exactly 4 — no duplicates

    const libraryEntriesAfterResync = await db.select().from(schema.skillLibraryEntries);
    expect(libraryEntriesAfterResync.length).toBe(libraryEntries.length); // no duplicate library rows either
  } finally {
    global.fetch = originalFetch;
    await cleanup();
  }
}

describe('compliance chat-sync (postgres)', () => {
  it(
    'resolveUserByEmail + syncChat: prompts/assistant-meta insert, PII flag + alert-once, retention floor, case-insensitive user resolution, pagination',
    async () => {
      await runSpec();
    },
    180_000,
  );
});

// ══════════════════════════════════════════════════════════════════════════
// runChatSync run loop.
// ══════════════════════════════════════════════════════════════════════════

function chatFixture(id: string, userId: string, email: string, nowS: number) {
  return {
    id, name: null, created_at: new Date(nowS * 1000).toISOString(),
    updated_at: new Date(nowS * 1000).toISOString(), deleted_at: null,
    model: 'claude-sonnet-5', project_id: null, organization_uuid: null,
    user: { id: userId, email_address: email },
  };
}

function emptyMessagesPage() {
  return jsonResponse({ chat_messages: [], has_more: false, first_id: null, last_id: null });
}

function errorResponse(status: number) {
  return { ok: false, status, json: async () => ({}), text: async () => `status ${status}` };
}

async function runRunChatSyncSpec(): Promise<void> {
  const { createTestDbClient } = await import('./helpers/db');
  const { client, cleanup } = await createTestDbClient('postgres');
  const originalFetch = global.fetch;
  const originalEnvKey = process.env.COMPLIANCE_ACCESS_KEY;
  delete process.env.COMPLIANCE_ACCESS_KEY; // keep Behaviour 1 independent of the host env

  try {
    // Dynamic imports AFTER the DATABASE_URL env + module reset (harness rule).
    const { getConfigValue, setConfigValue } = await import('@/lib/config');
    const { runChatSync } = await import('@/lib/compliance/chat-sync');

    const now = Math.floor(Date.now() / 1000);

    // ════════════════════════════════════════════════════════════════════
    // Behaviour 1 — no key configured: zeros, no fetch calls.
    // ════════════════════════════════════════════════════════════════════
    let fetchCallCount = 0;
    global.fetch = vi.fn(async () => {
      fetchCallCount++;
      throw new Error('fetch must not be called when no compliance access key is configured');
    }) as unknown as typeof fetch;

    const resultNoKey = await runChatSync();
    expect(resultNoKey).toEqual({ chatsProcessed: 0, prompts: 0, assistantMeta: 0, connectors: 0, errors: [] });
    expect(fetchCallCount).toBe(0);

    await setConfigValue('complianceAccessKey', 'test-compliance-key');
    await setConfigValue('complianceBackfillDays', '30');

    // ════════════════════════════════════════════════════════════════════
    // Behaviour 2 — first run (no saved cursor yet): listChats is called
    // with updated_at.gte (no after_id); a successful page advances the
    // saved cursor to that page's last_id.
    // ════════════════════════════════════════════════════════════════════
    const chatRun1 = chatFixture('chat-run-1', 'run-user-1', 'runuser1@test.local', now);
    let seenListUrl = '';
    global.fetch = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes('/compliance/apps/chats?')) {
        seenListUrl = u;
        return jsonResponse({ data: [chatRun1], has_more: false, first_id: 'chat-run-1', last_id: 'chat-run-1' });
      }
      if (u.includes('/compliance/apps/chats/chat-run-1/messages')) {
        return jsonResponse({
          chat_messages: [
            { id: 'run1-m1', role: 'user', created_at: new Date(now * 1000).toISOString(), content: [{ type: 'text', text: 'hello world' }], files: [] },
            {
              id: 'run1-m2', role: 'assistant', created_at: new Date(now * 1000).toISOString(),
              content: [{ type: 'tool_use', name: 'create_issue', integration_name: 'linear' }],
            },
          ],
          has_more: false, first_id: 'run1-m1', last_id: 'run1-m2',
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as unknown as typeof fetch;

    const resultFirstRun = await runChatSync();
    expect(resultFirstRun.chatsProcessed).toBe(1);
    expect(resultFirstRun.prompts).toBe(1);
    // connectors threaded through runChatSync the same way prompts is summed.
    expect(resultFirstRun.connectors).toBe(1);
    expect(resultFirstRun.errors).toEqual([]);
    expect(seenListUrl).toContain('updated_at.gte=');
    expect(seenListUrl).not.toContain('after_id=');
    expect(await getConfigValue('complianceChatCursor')).toBe('chat-run-1');

    // ════════════════════════════════════════════════════════════════════
    // Behaviour 3 — subsequent run: listChats is called with after_id =
    // the saved cursor, no updated_at.gte.
    // ════════════════════════════════════════════════════════════════════
    const chatRun2 = chatFixture('chat-run-2', 'run-user-2', 'runuser2@test.local', now);
    global.fetch = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes('/compliance/apps/chats?')) {
        seenListUrl = u;
        return jsonResponse({ data: [chatRun2], has_more: false, first_id: 'chat-run-2', last_id: 'chat-run-2' });
      }
      if (u.includes('/compliance/apps/chats/chat-run-2/messages')) {
        return jsonResponse({
          chat_messages: [
            { id: 'run2-m1', role: 'user', created_at: new Date(now * 1000).toISOString(), content: [{ type: 'text', text: 'second run prompt' }], files: [] },
          ],
          has_more: false, first_id: 'run2-m1', last_id: 'run2-m1',
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as unknown as typeof fetch;

    const resultSecondRun = await runChatSync();
    expect(resultSecondRun.chatsProcessed).toBe(1);
    expect(seenListUrl).toContain('after_id=chat-run-1');
    expect(seenListUrl).not.toContain('updated_at.gte');
    expect(await getConfigValue('complianceChatCursor')).toBe('chat-run-2');

    // ════════════════════════════════════════════════════════════════════
    // Behaviour 4 — batch cap: complianceChatsPerRun='1' against a 2-chat
    // page. chatsProcessed(0) + page.length(2) > cap(1), so the cap check
    // breaks BEFORE the per-chat loop runs at all: zero chats synced, no
    // /messages fetch for either chat, and the cursor stays at chat-run-2
    // (the capped page is never partially consumed). Raising the cap and
    // re-running re-lists the SAME page (cursor untouched -> same after_id)
    // and this time processes both chats in full.
    // ════════════════════════════════════════════════════════════════════
    await setConfigValue('complianceChatsPerRun', '1');
    const chatCapA = chatFixture('chat-cap-a', 'cap-user-a', 'capa@test.local', now);
    const chatCapB = chatFixture('chat-cap-b', 'cap-user-b', 'capb@test.local', now);
    let messagesFetchedDuringCappedRun = false;
    global.fetch = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes('/compliance/apps/chats?')) {
        seenListUrl = u;
        return jsonResponse({ data: [chatCapA, chatCapB], has_more: false, first_id: 'chat-cap-a', last_id: 'chat-cap-b' });
      }
      if (u.includes('/messages')) {
        messagesFetchedDuringCappedRun = true;
        return emptyMessagesPage();
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as unknown as typeof fetch;

    const resultCapped = await runChatSync();
    expect(resultCapped.chatsProcessed).toBe(0);
    expect(resultCapped.errors).toEqual([]);
    expect(messagesFetchedDuringCappedRun).toBe(false);
    expect(seenListUrl).toContain('after_id=chat-run-2'); // still listing from the same saved cursor
    expect(await getConfigValue('complianceChatCursor')).toBe('chat-run-2'); // unchanged — capped page not consumed

    await setConfigValue('complianceChatsPerRun', '10');
    const resultCapRetry = await runChatSync();
    expect(resultCapRetry.chatsProcessed).toBe(2);
    expect(resultCapRetry.errors).toEqual([]);
    expect(await getConfigValue('complianceChatCursor')).toBe('chat-cap-b');

    // ════════════════════════════════════════════════════════════════════
    // Behaviour 4.5 — multi-page within one run: first listChats page has
    // has_more=true + last_id='page1-cursor' with 1 chat. Second page
    // (after_id=page1-cursor) has has_more=false + last_id='page2-cursor'
    // with 1 more chat. Both chats' messages are fetched in the same
    // runChatSync() call, chatsProcessed=2, and the final cursor is
    // 'page2-cursor'.
    // ════════════════════════════════════════════════════════════════════
    const chatMultiPageA = chatFixture('chat-multi-a', 'multi-user-a', 'multia@test.local', now);
    const chatMultiPageB = chatFixture('chat-multi-b', 'multi-user-b', 'multib@test.local', now);
    let listCallCount = 0;
    global.fetch = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes('/compliance/apps/chats?')) {
        listCallCount++;
        if (listCallCount === 1) {
          // First page: has_more=true, one chat
          return jsonResponse({ data: [chatMultiPageA], has_more: true, first_id: 'chat-multi-a', last_id: 'page1-cursor' });
        }
        if (listCallCount === 2 && u.includes('after_id=page1-cursor')) {
          // Second page: has_more=false, one more chat
          return jsonResponse({ data: [chatMultiPageB], has_more: false, first_id: 'chat-multi-b', last_id: 'page2-cursor' });
        }
        throw new Error(`unexpected listChats call: ${u}`);
      }
      if (u.includes('/compliance/apps/chats/chat-multi-a/messages')) {
        return jsonResponse({
          chat_messages: [
            { id: 'multi-a-m1', role: 'user', created_at: new Date(now * 1000).toISOString(), content: [{ type: 'text', text: 'first page chat' }], files: [] },
          ],
          has_more: false, first_id: 'multi-a-m1', last_id: 'multi-a-m1',
        });
      }
      if (u.includes('/compliance/apps/chats/chat-multi-b/messages')) {
        return jsonResponse({
          chat_messages: [
            { id: 'multi-b-m1', role: 'user', created_at: new Date(now * 1000).toISOString(), content: [{ type: 'text', text: 'second page chat' }], files: [] },
          ],
          has_more: false, first_id: 'multi-b-m1', last_id: 'multi-b-m1',
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as unknown as typeof fetch;

    const resultMultiPage = await runChatSync();
    expect(resultMultiPage.chatsProcessed).toBe(2);
    expect(resultMultiPage.prompts).toBe(2);
    expect(resultMultiPage.errors).toEqual([]);
    expect(listCallCount).toBe(2); // listChats called twice within the same run
    expect(await getConfigValue('complianceChatCursor')).toBe('page2-cursor');

    // ════════════════════════════════════════════════════════════════════
    // Behaviour 5 — abort-on-failure: syncChat's message fetch returns a
    // non-retryable error (501) for a chat. The run must record the error
    // and leave the cursor exactly where it was before this run.
    // ════════════════════════════════════════════════════════════════════
    const cursorBeforeFailure = await getConfigValue('complianceChatCursor');
    const chatFail = chatFixture('chat-fail', 'fail-user', 'failuser@test.local', now);
    global.fetch = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes('/compliance/apps/chats?')) {
        return jsonResponse({ data: [chatFail], has_more: false, first_id: 'chat-fail', last_id: 'chat-fail' });
      }
      if (u.includes('/compliance/apps/chats/chat-fail/messages')) {
        return errorResponse(501);
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as unknown as typeof fetch;

    const resultFailed = await runChatSync();
    expect(resultFailed.chatsProcessed).toBe(0);
    expect(resultFailed.errors.length).toBe(1);
    expect(resultFailed.errors[0]).toContain('Compliance API error 501');
    expect(await getConfigValue('complianceChatCursor')).toBe(cursorBeforeFailure);

    // ════════════════════════════════════════════════════════════════════
    // Behaviour 6 — 404 on a chat's messages (hard-deleted between list
    // and fetch): that chat is a legitimate skip (counted, no error), the
    // run continues to the next chat in the page, and the cursor advances
    // past the whole page once it's fully processed.
    // ════════════════════════════════════════════════════════════════════
    const chatDeleted = chatFixture('chat-404', '404-user', 'user404@test.local', now);
    const chatOk = chatFixture('chat-ok', 'ok-user', 'okuser@test.local', now);
    global.fetch = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes('/compliance/apps/chats?')) {
        return jsonResponse({ data: [chatDeleted, chatOk], has_more: false, first_id: 'chat-404', last_id: 'chat-ok' });
      }
      if (u.includes('/compliance/apps/chats/chat-404/messages')) {
        return errorResponse(404);
      }
      if (u.includes('/compliance/apps/chats/chat-ok/messages')) {
        return jsonResponse({
          chat_messages: [
            { id: 'ok-m1', role: 'user', created_at: new Date(now * 1000).toISOString(), content: [{ type: 'text', text: 'still here' }], files: [] },
          ],
          has_more: false, first_id: 'ok-m1', last_id: 'ok-m1',
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as unknown as typeof fetch;

    const resultSkip404 = await runChatSync();
    expect(resultSkip404.chatsProcessed).toBe(2); // the 404'd chat counts as a legitimate skip
    expect(resultSkip404.prompts).toBe(1); // only chat-ok actually produced a message row
    expect(resultSkip404.errors).toEqual([]);
    expect(await getConfigValue('complianceChatCursor')).toBe('chat-ok');

    // ════════════════════════════════════════════════════════════════════
    // Behaviour 7 (regression) — a chat's messages span 2
    // pages; page 1 contains a PII-flagged message and its withTx commits;
    // page 2's fetch then 501s (non-retryable, same status class as
    // Behaviour 5). Pre-fix, pendingPiiAlerts/pendingIntentAlerts were only
    // flushed AFTER the whole while-loop, so page 1's alert was discarded
    // when page 2 threw — and the alert-once exists-gate means it could
    // NEVER fire on a later retry (the row is already there). Post-fix,
    // alerts are flushed per-page immediately after that page's own withTx
    // commits, so the page-1 alert must survive even though the run as a
    // whole records an error and the cursor stays unadvanced.
    // ════════════════════════════════════════════════════════════════════
    const { schema } = await import('@/lib/db/schema');
    const { eq } = await import('drizzle-orm');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = client as any;

    const cursorBeforeI1 = await getConfigValue('complianceChatCursor');
    const chatI1 = chatFixture('chat-i1', 'i1-user', 'i1user@test.local', now);
    global.fetch = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes('/compliance/apps/chats?')) {
        return jsonResponse({ data: [chatI1], has_more: false, first_id: 'chat-i1', last_id: 'chat-i1' });
      }
      if (u.includes('/compliance/apps/chats/chat-i1/messages')) {
        if (u.includes('after_id=i1-m1')) {
          return errorResponse(501); // page 2: non-retryable, aborts syncChat mid-run
        }
        return jsonResponse({
          chat_messages: [
            { id: 'i1-m1', role: 'user', created_at: new Date(now * 1000).toISOString(), content: [{ type: 'text', text: 'my card 4111 1111 1111 1111' }], files: [] },
          ],
          has_more: true, first_id: 'i1-m1', last_id: 'i1-m1', // has_more -> syncChat will fetch page 2 next
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as unknown as typeof fetch;

    const resultI1 = await runChatSync();
    expect(resultI1.errors.length).toBe(1);
    expect(resultI1.errors[0]).toContain('Compliance API error 501');
    expect(await getConfigValue('complianceChatCursor')).toBe(cursorBeforeI1); // chat-i1 never finished -> cursor unadvanced

    const alertsAfterI1 = await db.select().from(schema.alerts);
    expect(alertsAfterI1.length).toBe(1); // page-1's PII alert survived page 2's failure
    expect(alertsAfterI1[0].alert_type).toBe('policy');

    // ════════════════════════════════════════════════════════════════════
    // Behaviour 8 (regression) — complianceChatsPerRun set
    // BELOW the API's default page size (100) must not stall the sync.
    // runChatSync now requests pages with limit = min(100, cap), so cap=2
    // requests 2-chat pages instead of the pre-fix always-100. A mock that
    // HONOURS the limit param (unlike the earlier cap tests, which never
    // checked it) proves real forward progress across runs: chats are
    // processed and the cursor keeps advancing rather than permanently
    // breaking-before-processing on an oversized page.
    // ════════════════════════════════════════════════════════════════════
    await setConfigValue('complianceChatsPerRun', '2');
    await setConfigValue('complianceChatCursor', '');

    const capFixA = chatFixture('cap-fix-a', 'cap-fix-user-a', 'capfixa@test.local', now);
    const capFixB = chatFixture('cap-fix-b', 'cap-fix-user-b', 'capfixb@test.local', now);
    const capFixC = chatFixture('cap-fix-c', 'cap-fix-user-c', 'capfixc@test.local', now);
    const capFixPool = [capFixA, capFixB, capFixC]; // 3 available across calls

    let lastCapFixListUrl = '';
    global.fetch = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes('/compliance/apps/chats?')) {
        lastCapFixListUrl = u;
        const parsed = new URL(u);
        const limit = Number.parseInt(parsed.searchParams.get('limit') || '100', 10);
        const afterId = parsed.searchParams.get('after_id');
        const startIdx = afterId ? capFixPool.findIndex(c => c.id === afterId) + 1 : 0;
        const slice = capFixPool.slice(startIdx, startIdx + limit);
        return jsonResponse({
          data: slice,
          has_more: startIdx + slice.length < capFixPool.length,
          first_id: slice[0]?.id ?? null,
          last_id: slice.length ? slice[slice.length - 1].id : null,
        });
      }
      if (u.includes('/messages')) {
        return emptyMessagesPage();
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as unknown as typeof fetch;

    const resultCapFixRun1 = await runChatSync();
    expect(resultCapFixRun1.errors).toEqual([]);
    expect(resultCapFixRun1.chatsProcessed).toBe(2); // cap-fix-a + cap-fix-b, this run
    expect(lastCapFixListUrl).toContain('limit=2'); // the fix: page size follows the cap, not a hardcoded 100
    expect(await getConfigValue('complianceChatCursor')).toBe('cap-fix-b');

    const resultCapFixRun2 = await runChatSync();
    expect(resultCapFixRun2.errors).toEqual([]);
    expect(resultCapFixRun2.chatsProcessed).toBe(1); // remaining cap-fix-c
    expect(await getConfigValue('complianceChatCursor')).toBe('cap-fix-c'); // cursor kept advancing -> no stall

    // ════════════════════════════════════════════════════════════════════
    // Behaviour 9 (resurrection guard) — retentionChatDays (5) set SMALLER
    // than complianceBackfillDays (30, set at the top of this spec) narrows
    // the insertion floor to min(backfillDays, retentionChatDays) = 5 days.
    // A message 10 days old is within the 30-day backfill window but past
    // the 5-day retention window: it must be SKIPPED at insert (never
    // written to chat_messages at all), because inserting it would just be
    // immediately eligible for retention pruning — i.e. a purge-then-resync
    // cycle can never resurrect content retention already deleted. A
    // message 1 day old (within both windows) is inserted normally.
    // ════════════════════════════════════════════════════════════════════
    await setConfigValue('retentionChatDays', '5');
    await setConfigValue('complianceChatCursor', '');
    const chatRetentionGuard = chatFixture('chat-retention-guard', 'retention-user', 'retentionuser@test.local', now);
    const oldMsgAt = new Date((now - 10 * 86400) * 1000).toISOString(); // 10d old: within 30d backfill, past 5d retention
    const newMsgAt = new Date((now - 1 * 86400) * 1000).toISOString(); // 1d old: within both windows
    global.fetch = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes('/compliance/apps/chats?')) {
        return jsonResponse({ data: [chatRetentionGuard], has_more: false, first_id: 'chat-retention-guard', last_id: 'chat-retention-guard' });
      }
      if (u.includes('/compliance/apps/chats/chat-retention-guard/messages')) {
        return jsonResponse({
          chat_messages: [
            { id: 'retention-old-msg', role: 'user', created_at: oldMsgAt, content: [{ type: 'text', text: 'too old for retention' }], files: [] },
            { id: 'retention-new-msg', role: 'user', created_at: newMsgAt, content: [{ type: 'text', text: 'within retention window' }], files: [] },
          ],
          has_more: false, first_id: 'retention-old-msg', last_id: 'retention-new-msg',
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as unknown as typeof fetch;

    const resultRetentionGuard = await runChatSync();
    expect(resultRetentionGuard.errors).toEqual([]);
    expect(resultRetentionGuard.chatsProcessed).toBe(1);
    expect(resultRetentionGuard.prompts).toBe(1); // only the newer message inserted

    const oldMsgRows = await db.select().from(schema.chatMessages).where(eq(schema.chatMessages.id, 'retention-old-msg'));
    expect(oldMsgRows.length).toBe(0); // skipped by the narrowed floor — never resurrected

    const newMsgRows = await db.select().from(schema.chatMessages).where(eq(schema.chatMessages.id, 'retention-new-msg'));
    expect(newMsgRows.length).toBe(1);
  } finally {
    global.fetch = originalFetch;
    if (originalEnvKey === undefined) delete process.env.COMPLIANCE_ACCESS_KEY;
    else process.env.COMPLIANCE_ACCESS_KEY = originalEnvKey;
    await cleanup();
  }
}

describe('compliance chat-sync runChatSync (postgres)', () => {
  it(
    'cursor discipline (updated_at.gte first run / after_id thereafter), multi-page within one run, per-run cap breaks before over-committing a page, abort-on-failure leaves the cursor unadvanced, 404 is a legitimate skip',
    async () => {
      await runRunChatSyncSpec();
    },
    180_000,
  );
});
