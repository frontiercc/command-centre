// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

// createTestDatabase resets the module cache, so we must dynamic-import the receiver
// inside each test (or use a module-level variable set in beforeAll).
let sql: TestSql;
let cleanup: () => Promise<void>;
let processCodeOtlpLogs: (payload: unknown) => Promise<{
  processed: number;
  skipped: number;
  errors: string[];
}>;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;

  // Dynamic import AFTER createTestDatabase resets the module cache so all transitive
  // imports (lib/db, lib/pii, lib/intent, lib/alerts) see the fresh test DB.
  const mod = await import('@/lib/otel/code-receiver');
  processCodeOtlpLogs = mod.processCodeOtlpLogs;
});

afterAll(async () => cleanup());

const TEST_EMAIL = 'coder@example.com';
const TEST_USER_ID = 'usr_coder01';
const TEST_SESSION_ID = 'code_sess_001';
const TEST_PROMPT_ID = 'prompt_code_001';

beforeEach(async () => {
  // A record re-sent with an identical payload is now skipped as already
  // processed (lib/otel/event-key.ts); tests reuse payloads, so clear it first.
  await sql.exec('DELETE FROM otel_ingested_events');
  // Clean in FK-safe order: leaf tables first, then users.
  // Use a subquery so we can delete by email rather than hard-coded id.
  const emailClause = `IN (SELECT id FROM users WHERE email = '${TEST_EMAIL}')`;
  await sql.exec(`DELETE FROM code_assistant_meta WHERE session_id = '${TEST_SESSION_ID}'`);
  await sql.exec(`DELETE FROM cowork_skill_invocations WHERE session_id = '${TEST_SESSION_ID}'`);
  await sql.exec(`DELETE FROM cowork_mcp_invocations WHERE session_id = '${TEST_SESSION_ID}'`);
  await sql.exec(`DELETE FROM skill_library_entries WHERE name IN ('github', 'Gmail', 'writing-plans', 'docx')`);
  await sql.exec(`DELETE FROM cowork_messages WHERE session_id = '${TEST_SESSION_ID}'`);
  // compliance_events and otel_events also reference users(id) without cascade
  await sql.exec(`DELETE FROM compliance_events WHERE user_id ${emailClause}`);
  await sql.exec(`DELETE FROM otel_events WHERE user_id ${emailClause}`);
  // Alerts are created by PII detection — delete before users row. PII tests
  // wait for their background alert write (awaitPiiAlert), so none is still in
  // flight when this runs.
  await sql.exec(`DELETE FROM alerts WHERE user_id ${emailClause}`);
  // admin_users.linked_cowork_user_id has ON DELETE SET NULL, so this is safe
  // but we still remove the admin row so it's recreated fresh each test
  await sql.run("DELETE FROM admin_users WHERE email = ?", [TEST_EMAIL]);
  await sql.run("DELETE FROM users WHERE email = ?", [TEST_EMAIL]);
});

/**
 * The PII alert is written in the background (fire-and-forget).
 * Wait for it, so a PII test proves the alert was raised and leaves nothing in
 * flight to land during the next test's cleanup.
 */
async function awaitPiiAlert(): Promise<void> {
  await vi.waitFor(async () => {
    const alert = await sql.get(
      'SELECT id FROM alerts WHERE user_id IN (SELECT id FROM users WHERE email = ?)',
      [TEST_EMAIL],
    );
    expect(alert).toBeDefined();
  });
}

/**
 * Build a minimal OTLP resourceLogs payload for claude-code events.
 * Numeric attrs use doubleValue; string attrs use stringValue.
 */
function makePayload(eventName: string, attrs: Record<string, string | number> = {}) {
  return {
    resourceLogs: [{
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: 'claude-code' } },
          { key: 'user.email', value: { stringValue: TEST_EMAIL } },
          { key: 'user.id', value: { stringValue: TEST_USER_ID } },
          { key: 'organization.id', value: { stringValue: 'org_test' } },
        ]
      },
      scopeLogs: [{
        logRecords: [{
          attributes: [
            { key: 'event.name', value: { stringValue: eventName } },
            { key: 'session.id', value: { stringValue: TEST_SESSION_ID } },
            { key: 'prompt.id', value: { stringValue: TEST_PROMPT_ID } },
            ...Object.entries(attrs).map(([key, value]) => ({
              key,
              value: typeof value === 'number'
                ? { doubleValue: value }
                : { stringValue: value as string },
            }))
          ],
          timeUnixNano: '1750000000000000000'
        }]
      }]
    }]
  };
}

// ─── Test 1 ───────────────────────────────────────────────────────────────────
it('user_prompt → cowork_messages with surface=code, source=otel, message_type=code_user_message', async () => {
  const result = await processCodeOtlpLogs(
    makePayload('claude_code.user_prompt', { prompt: 'How do I refactor this function?' }));
  expect(result.errors).toHaveLength(0);
  expect(result.processed).toBe(1);

  const row = (await sql.get(
    `SELECT * FROM cowork_messages WHERE prompt_id = '${TEST_PROMPT_ID}'`
  )) as any;
  expect(row).not.toBeNull();
  expect(row.surface).toBe('code');
  expect(row.source).toBe('otel');
  expect(row.message_type).toBe('code_user_message');
  expect(row.session_id).toBe(TEST_SESSION_ID);
});

// ─── Test 2 ───────────────────────────────────────────────────────────────────
it('auto-creates user in admin_users with role=pulse and password_hash=__otel_pending__', async () => {
  await processCodeOtlpLogs(
    makePayload('claude_code.user_prompt', { prompt: 'Hello' }));

  const adminUser = (await sql.get(
    `SELECT * FROM admin_users WHERE email = ?`,
    [TEST_EMAIL]
  )) as any;
  expect(adminUser).not.toBeNull();
  expect(adminUser.role).toBe('pulse');
  expect(adminUser.password_hash).toBe('__otel_pending__');

  const user = (await sql.get(
    `SELECT * FROM users WHERE email = ?`,
    [TEST_EMAIL]
  )) as any;
  expect(user).not.toBeNull();
  expect(user.source).toBe('otel');
});

// ─── Test 3 ───────────────────────────────────────────────────────────────────
it('api_request → code_assistant_meta with source=otel, correct token counts, tool_use_count=0, commit_count=0, prompt_id set', async () => {
  const result = await processCodeOtlpLogs(
    makePayload('claude_code.api_request', {
      model: 'claude-sonnet-4-6',
      input_tokens: 1500,
      output_tokens: 400,
      cache_creation_tokens: 200,
      cache_read_tokens: 50,
      stop_reason: 'end_turn',
    }));
  expect(result.errors).toHaveLength(0);
  expect(result.processed).toBe(1);

  const row = (await sql.get(
    `SELECT * FROM code_assistant_meta WHERE prompt_id = '${TEST_PROMPT_ID}'`
  )) as any;
  expect(row).not.toBeNull();
  expect(row.source).toBe('otel');
  expect(row.model).toBe('claude-sonnet-4-6');
  expect(row.input_tokens).toBe(1500);
  expect(row.output_tokens).toBe(400);
  expect(row.cache_creation_tokens).toBe(200);
  expect(row.cache_read_tokens).toBe(50);
  expect(row.tool_use_count).toBe(0);
  expect(row.commit_count).toBe(0);
  expect(row.prompt_id).toBe(TEST_PROMPT_ID);
});

// ─── Test 3b — Phase 2 enrichment ───────────────────────────────────────────────
it('api_request captures query_source / agent.name / skill.name / effort enrichment', async () => {
  const result = await processCodeOtlpLogs(
    makePayload('claude_code.api_request', {
      model: 'claude-sonnet-4-6',
      input_tokens: 100,
      output_tokens: 50,
      query_source: 'subagent',
      'agent.name': 'code-reviewer',
      'skill.name': 'deep-research',
      effort: 'high',
    }));
  expect(result.processed).toBe(1);
  const row = (await sql.get(
    `SELECT query_source, agent_name, skill_name, effort FROM code_assistant_meta WHERE prompt_id = '${TEST_PROMPT_ID}'`
  )) as any;
  expect(row.query_source).toBe('subagent');
  expect(row.agent_name).toBe('code-reviewer');
  expect(row.skill_name).toBe('deep-research');
  expect(row.effort).toBe('high');
});

// ─── Test 4 ───────────────────────────────────────────────────────────────────
it('api_request deduplicates on prompt.id — INSERT OR IGNORE, second call is a no-op', async () => {
  const payload = makePayload('claude_code.api_request', {
    model: 'claude-sonnet-4-6',
    input_tokens: 1000,
    output_tokens: 200,
  });
  await processCodeOtlpLogs(payload);
  await processCodeOtlpLogs(payload);

  const count = (await sql.get(
    `SELECT COUNT(*) as c FROM code_assistant_meta WHERE prompt_id = '${TEST_PROMPT_ID}'`
  )) as any;
  expect(count.c).toBe(1);
});

// ─── Test 5 ───────────────────────────────────────────────────────────────────
it('tool_result success=false → friction row in code_assistant_meta (model="", error_count=1, source=otel)', async () => {
  const result = await processCodeOtlpLogs(
    makePayload('claude_code.tool_result', {
      tool_name: 'Bash',
      success: 'false',
    }));
  expect(result.errors).toHaveLength(0);
  expect(result.processed).toBe(1);

  // Friction rows have their own id (err:…) and carry prompt_id — keyed on
  // prompt_id they collided with the prompt's model-call row and were dropped.
  const row = (await sql.get(
    `SELECT * FROM code_assistant_meta WHERE model = '' AND prompt_id = '${TEST_PROMPT_ID}'`
  )) as any;
  expect(String(row.id)).toMatch(/^err:/);
  expect(row).not.toBeNull();
  expect(row.model).toBe('');
  expect(row.error_count).toBe(1);
  expect(row.source).toBe('otel');
  expect(row.session_id).toBe(TEST_SESSION_ID);
});

// ─── Test 6 ───────────────────────────────────────────────────────────────────
it('tool_result success=true (non-Bash tool) → skipped, no row inserted', async () => {
  const result = await processCodeOtlpLogs(
    makePayload('claude_code.tool_result', {
      tool_name: 'Read',
      success: 'true',
    }));
  expect(result.errors).toHaveLength(0);
  expect(result.skipped).toBeGreaterThanOrEqual(1);

  const count = (await sql.get(
    `SELECT COUNT(*) as c FROM code_assistant_meta WHERE session_id = '${TEST_SESSION_ID}'`
  )) as any;
  expect(count.c).toBe(0);
});

// ─── Test 7 ───────────────────────────────────────────────────────────────────
it('tool_result success=true, Bash, with git_commit_id in tool_parameters → commit_count incremented on api_request row', async () => {
  // First insert the api_request row that we will increment
  await processCodeOtlpLogs(
    makePayload('claude_code.api_request', {
      model: 'claude-sonnet-4-6',
      input_tokens: 800,
      output_tokens: 150,
    }));

  // Confirm initial commit_count is 0
  const before = (await sql.get(
    `SELECT commit_count FROM code_assistant_meta WHERE prompt_id = '${TEST_PROMPT_ID}'`
  )) as any;
  expect(before.commit_count).toBe(0);

  // Now send tool_result with git_commit_id to trigger increment
  const result = await processCodeOtlpLogs(
    makePayload('claude_code.tool_result', {
      tool_name: 'Bash',
      success: 'true',
      tool_parameters: JSON.stringify({ git_commit_id: 'abc123def456' }),
    }));
  expect(result.errors).toHaveLength(0);

  const after = (await sql.get(
    `SELECT commit_count FROM code_assistant_meta WHERE prompt_id = '${TEST_PROMPT_ID}'`
  )) as any;
  expect(after.commit_count).toBe(1);
});

// ─── Test 8 ───────────────────────────────────────────────────────────────────
it('skill_activated → row in cowork_skill_invocations with source=otel', async () => {
  const result = await processCodeOtlpLogs(
    makePayload('claude_code.skill_activated', {
      'skill.name': 'writing-plans',
      invocation_type: 'user_typed',
    }));
  expect(result.errors).toHaveLength(0);
  expect(result.processed).toBe(1);

  const row = (await sql.get(
    `SELECT * FROM cowork_skill_invocations WHERE session_id = '${TEST_SESSION_ID}'`
  )) as any;
  expect(row).not.toBeNull();
  expect(row.skill_name).toBe('writing-plans');
  expect(row.source).toBe('otel');
  expect(row.invocation_type).toBe('user_typed');
  expect(row.surface).toBe('code');
  expect(row.prompt_id).toBe(TEST_PROMPT_ID);

  // skill_activated must NOT also create a cowork_messages row
  const msgCount = (await sql.get(
    `SELECT COUNT(*) as c FROM cowork_messages WHERE session_id = '${TEST_SESSION_ID}'`
  )) as any;
  expect(msgCount.c).toBe(0);
});

it('skill_activated for a genuine org-built skill auto-registers as unclaimed (source=org, is_published=0)', async () => {
  await processCodeOtlpLogs(
    makePayload('claude_code.skill_activated', { 'skill.name': 'writing-plans' }));

  const entry = (await sql.get(
    `SELECT source, is_published FROM skill_library_entries WHERE name = 'writing-plans'`
  )) as any;
  expect(entry).not.toBeNull();
  expect(entry.source).toBe('org');
  expect(entry.is_published).toBe(0);
});

it('skill_activated for a known Anthropic-bundled skill auto-registers as published (source=anthropic, is_published=1)', async () => {
  await processCodeOtlpLogs(
    makePayload('claude_code.skill_activated', { 'skill.name': 'docx' }));

  const entry = (await sql.get(
    `SELECT source, is_published FROM skill_library_entries WHERE name = 'docx'`
  )) as any;
  expect(entry).not.toBeNull();
  expect(entry.source).toBe('anthropic');
  expect(entry.is_published).toBe(1);
});

// ─── Test 9 ───────────────────────────────────────────────────────────────────
it('tool_decision increments tool_use_count on existing api_request row', async () => {
  // First insert the api_request row
  await processCodeOtlpLogs(
    makePayload('claude_code.api_request', {
      model: 'claude-sonnet-4-6',
      input_tokens: '500',
      output_tokens: '100',
    }));
  const before = (await sql.get(
    `SELECT tool_use_count FROM code_assistant_meta WHERE prompt_id = '${TEST_PROMPT_ID}'`
  )) as any;
  expect(before.tool_use_count).toBe(0);

  // Two tool_decision events for the same prompt
  await processCodeOtlpLogs(
    makePayload('claude_code.tool_decision', { tool_name: 'Bash', decision: 'accept' }));
  await processCodeOtlpLogs(
    makePayload('claude_code.tool_decision', { tool_name: 'Read', decision: 'accept' }));

  const after = (await sql.get(
    `SELECT tool_use_count FROM code_assistant_meta WHERE prompt_id = '${TEST_PROMPT_ID}'`
  )) as any;
  expect(after.tool_use_count).toBe(2);
});

// ─── Test 10 ──────────────────────────────────────────────────────────────────
it('PII in user_prompt content → flagged=1 on the resulting cowork_messages row', async () => {
  // Use a clearly PII-triggering prompt: an email address which matches the email detector
  const result = await processCodeOtlpLogs(
    makePayload('claude_code.user_prompt', {
      prompt: 'Send results to alice.smith@example.com please',
    }));
  expect(result.errors).toHaveLength(0);
  expect(result.processed).toBe(1);

  const row = (await sql.get(
    `SELECT * FROM cowork_messages WHERE prompt_id = '${TEST_PROMPT_ID}'`
  )) as any;
  expect(row).not.toBeNull();
  expect(row.flagged).toBe(1);
  expect(row.flag_reason).toContain('PII');
  await awaitPiiAlert();
});

// ─── Test 11 ──────────────────────────────────────────────────────────────────
it('tool_result with mcp_server_scope (org custom connector) → row in cowork_mcp_invocations + skill_library_entries', async () => {
  const result = await processCodeOtlpLogs(
    makePayload('claude_code.tool_result', {
      tool_name: 'github__search_repositories',
      success: 'true',
      mcp_server_scope: 'github',
      tool_parameters: JSON.stringify({ mcp_server_name: 'github', mcp_tool_name: 'search_repositories' }),
    }));
  expect(result.errors).toHaveLength(0);
  expect(result.processed).toBe(1);

  const inv = (await sql.get(
    `SELECT * FROM cowork_mcp_invocations WHERE session_id = '${TEST_SESSION_ID}' AND mcp_server = 'github'`
  )) as any;
  expect(inv).not.toBeNull();
  expect(inv.mcp_tool).toBe('search_repositories');
  expect(inv.success).toBe(1);
  expect(inv.source).toBe('otel');
  expect(inv.surface).toBe('code');

  const entry = (await sql.get(
    `SELECT * FROM skill_library_entries WHERE name = 'github'`
  )) as any;
  expect(entry).not.toBeNull();
  expect(entry.type).toBe('connector');
  expect(entry.surface).toBe('code');
  expect(entry.source).toBe('org');
});

// ─── Test 12 ──────────────────────────────────────────────────────────────────
it('tool_result with mcp_server_scope as Anthropic marketplace UUID → resolved name, source=anthropic in skill_library_entries', async () => {
  // Gmail UUID from MARKETPLACE_UUID_NAMES
  const GMAIL_UUID = '2479fda4-bb8d-4c07-992a-d4b5ee716491';
  const result = await processCodeOtlpLogs(
    makePayload('claude_code.tool_result', {
      tool_name: 'gmail__send_email',
      success: 'true',
      mcp_server_scope: GMAIL_UUID,
      tool_parameters: JSON.stringify({ mcp_server_name: GMAIL_UUID, mcp_tool_name: 'send_email' }),
    }));
  expect(result.errors).toHaveLength(0);
  expect(result.processed).toBe(1);

  const inv = (await sql.get(
    `SELECT * FROM cowork_mcp_invocations WHERE session_id = '${TEST_SESSION_ID}' AND mcp_server = 'Gmail'`
  )) as any;
  expect(inv).not.toBeNull();
  expect(inv.mcp_tool).toBe('send_email');
  expect(inv.source).toBe('otel');

  const entry = (await sql.get(
    `SELECT * FROM skill_library_entries WHERE name = 'Gmail'`
  )) as any;
  expect(entry).not.toBeNull();
  expect(entry.source).toBe('anthropic');
  expect(entry.is_published).toBe(1);
  expect(entry.surface).toBe('code');
});

// ─── Real CLI payload shape ─────────────────────────────────────────────────────
// Reproduces how the Claude Code CLI actually emits OTel: per the official docs,
// the OTLP *resource* block carries ONLY service.name/version + os/host attributes.
// Identity (user.email, user.id, organization.id) and session.id are "standard
// attributes" attached to each LOG RECORD — NOT to the resource. The existing
// makePayload() helper above puts identity in the resource block, which is why the
// suite passes while real CLI sessions produce zero rows.
function makeRealCliPayload(eventName: string, attrs: Record<string, string | number> = {}) {
  return {
    resourceLogs: [{
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: 'claude-code' } },
          { key: 'service.version', value: { stringValue: '2.1.0' } },
          { key: 'os.type', value: { stringValue: 'windows' } },
          { key: 'host.arch', value: { stringValue: 'amd64' } },
        ]
      },
      scopeLogs: [{
        logRecords: [{
          attributes: [
            { key: 'event.name', value: { stringValue: eventName } },
            // Identity lives on the record, exactly as the real CLI sends it:
            { key: 'user.email', value: { stringValue: TEST_EMAIL } },
            { key: 'user.id', value: { stringValue: TEST_USER_ID } },
            { key: 'organization.id', value: { stringValue: 'org_test' } },
            { key: 'session.id', value: { stringValue: TEST_SESSION_ID } },
            { key: 'prompt.id', value: { stringValue: TEST_PROMPT_ID } },
            ...Object.entries(attrs).map(([key, value]) => ({
              key,
              value: typeof value === 'number'
                ? { doubleValue: value }
                : { stringValue: value as string },
            }))
          ],
          timeUnixNano: '1750000000000000000'
        }]
      }]
    }]
  };
}

it('REAL CLI shape (identity on log record, not resource) → user_prompt is processed, not dropped', async () => {
  const result = await processCodeOtlpLogs(
    makeRealCliPayload('claude_code.user_prompt', { prompt: 'How do I refactor this?' }));
  expect(result.errors).toHaveLength(0);
  expect(result.processed).toBe(1);

  const row = (await sql.get(
    `SELECT * FROM cowork_messages WHERE prompt_id = '${TEST_PROMPT_ID}'`
  )) as any;
  expect(row).not.toBeNull();
  expect(row.surface).toBe('code');
  expect(row.message_type).toBe('code_user_message');
});

it('REAL CLI shape → api_request lands in code_assistant_meta', async () => {
  const result = await processCodeOtlpLogs(
    makeRealCliPayload('claude_code.api_request', {
      model: 'claude-sonnet-4-6',
      input_tokens: 1200,
      output_tokens: 300,
    }));
  expect(result.errors).toHaveLength(0);
  expect(result.processed).toBe(1);

  const row = (await sql.get(
    `SELECT * FROM code_assistant_meta WHERE prompt_id = '${TEST_PROMPT_ID}'`
  )) as any;
  expect(row).not.toBeNull();
  expect(row.model).toBe('claude-sonnet-4-6');
});

it('Desktop entrypoint: service.name=claude-code-desktop is treated as Code and processed', async () => {
  // The Claude Desktop app reports service.name='claude-code-desktop' (confirmed from
  // live OTel capture), not 'claude-code'. The receiver must accept the claude-code* family.
  const payload = makeRealCliPayload('claude_code.user_prompt', { prompt: 'desktop hello' });
  // Override the resource service.name to the Desktop value.
  const svc = payload.resourceLogs[0].resource.attributes.find(a => a.key === 'service.name');
  svc!.value.stringValue = 'claude-code-desktop';

  const result = await processCodeOtlpLogs(payload);
  expect(result.errors).toHaveLength(0);
  expect(result.processed).toBe(1);

  const row = (await sql.get(
    `SELECT * FROM cowork_messages WHERE prompt_id = '${TEST_PROMPT_ID}'`
  )) as any;
  expect(row).not.toBeNull();
  expect(row.surface).toBe('code');
  expect(row.message_type).toBe('code_user_message');
});

it('unrelated service.name (e.g. some-other-app) is skipped, not processed', async () => {
  const payload = makeRealCliPayload('claude_code.user_prompt', { prompt: 'nope' });
  const svc = payload.resourceLogs[0].resource.attributes.find(a => a.key === 'service.name');
  svc!.value.stringValue = 'some-other-app';

  const result = await processCodeOtlpLogs(payload);
  expect(result.processed).toBe(0);
  expect(result.skipped).toBeGreaterThanOrEqual(1);
});

// ─── Content limits (250/4000) ──────────────────────────────────────────────────
it('truncates stored content at 250/4000 but detects PII beyond the stored window', async () => {
  // 4,500 chars of padding, then a CPF — the match sits past the 4,000-char storage cap.
  // CPF literal must be a check-digit-valid one; copied verbatim from test/pii-detect.test.ts
  // rather than invented, since CPF validation is mod-11.
  const cpf = '111.444.777-35';
  const prompt = 'a'.repeat(4500) + ' my CPF is ' + cpf;
  const result = await processCodeOtlpLogs(
    makePayload('claude_code.user_prompt', { prompt }));
  expect(result.errors).toHaveLength(0);
  expect(result.processed).toBe(1);

  const row = (await sql.get(
    `SELECT content_preview, content_full, flagged, flag_reason FROM cowork_messages
     WHERE message_type='code_user_message' AND session_id='${TEST_SESSION_ID}'`
  )) as { content_preview: string; content_full: string; flagged: number; flag_reason: string };

  expect(row.content_preview.length).toBe(250);
  expect(row.content_full.length).toBe(4000);
  expect(row.content_full).not.toContain(cpf);        // truncated out of storage…
  expect(row.flagged).toBe(1);                        // …but detection saw the full prompt
  expect(row.flag_reason).toContain('cpf');
});

it('stores short prompts whole (no padding to the cap)', async () => {
  await processCodeOtlpLogs(
    makePayload('claude_code.user_prompt', { prompt: 'short prompt' }));
  const row = (await sql.get(
    `SELECT content_preview, content_full FROM cowork_messages
     WHERE message_type='code_user_message' AND session_id='${TEST_SESSION_ID}'`
  )) as { content_preview: string; content_full: string };
  expect(row.content_preview).toBe('short prompt');
  expect(row.content_full).toBe('short prompt');
});

// ─── Structural validation ─────────────────────────────────────────────────────
describe('payload validation', () => {
  it('returns error and zero processed when resourceLogs is missing', async () => {
    const result = await processCodeOtlpLogs({ resourceSpans: [] });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.processed).toBe(0);
  });
});
