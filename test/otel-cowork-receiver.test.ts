// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { displayNameFromEmail } from '@/lib/otel/cowork-receiver';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

function makePayload(eventName: string, attrs: Record<string, string> = {}) {
  return {
    resourceLogs: [{
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: 'cowork' } },
          { key: 'user.email', value: { stringValue: 'test@example.com' } },
          { key: 'user.id', value: { stringValue: 'usr_test01' } },
          { key: 'user.account_uuid', value: { stringValue: 'uuid-0001' } },
          { key: 'organization.id', value: { stringValue: 'org_test' } },
          { key: 'department', value: { stringValue: 'Engineering' } },
        ]
      },
      scopeLogs: [{
        logRecords: [{
          attributes: [
            { key: 'event.name', value: { stringValue: eventName } },
            { key: 'session.id', value: { stringValue: 'sess_001' } },
            { key: 'prompt.id', value: { stringValue: 'prompt_001' } },
            ...Object.entries(attrs).map(([key, value]) => ({
              key, value: { stringValue: value }
            }))
          ],
          timeUnixNano: '1750000000000000000'
        }]
      }]
    }]
  };
}

describe('processOtlpLogs', () => {
  let sql: TestSql;
  let cleanup: () => Promise<void>;
  let processOtlpLogs: typeof import('@/lib/otel/cowork-receiver').processOtlpLogs;

  beforeAll(async () => {
    const t = await createTestDatabase();
    sql = t.sql;
    cleanup = t.cleanup;
    // Dynamic import AFTER createTestDatabase resets the module cache.
    ({ processOtlpLogs } = await import('@/lib/otel/cowork-receiver'));
  });
  afterAll(async () => cleanup());

  beforeEach(async () => {
    // A record re-sent with an identical payload is now skipped as already
    // processed (lib/otel/event-key.ts); tests reuse payloads, so clear it first.
    await sql.run('DELETE FROM otel_ingested_events');
    // Delete in dependency order to avoid FK constraint failures.
    // cowork_sessions has a FK on users; cowork_messages/mcp/skill have FK on users.
    // pulse_classifications/events/skill_runs FK-reference cowork_messages with
    // no cascade, so they go FIRST. (This file used to run against the default
    // ./data/ccc.db, where a classifier run over a leftover test message left a
    // child row that blocked the delete below and took every test with it.)
    const msgIds = "SELECT id FROM cowork_messages WHERE user_id IN (SELECT id FROM users WHERE email = 'test@example.com') OR session_id IN (SELECT id FROM cowork_sessions WHERE user_id IN (SELECT id FROM users WHERE email = 'test@example.com'))";
    for (const t of ['pulse_classifications', 'pulse_events', 'pulse_skill_runs']) {
      await sql.run(`DELETE FROM ${t} WHERE cowork_message_id IN (${msgIds})`);
    }
    await sql.run("DELETE FROM cowork_messages WHERE user_id IN (SELECT id FROM users WHERE email = 'test@example.com') OR session_id IN (SELECT id FROM cowork_sessions WHERE user_id IN (SELECT id FROM users WHERE email = 'test@example.com'))");
    await sql.run('DELETE FROM cowork_skill_invocations WHERE user_id IN (SELECT id FROM users WHERE email = \'test@example.com\')');
    await sql.run('DELETE FROM cowork_mcp_invocations WHERE user_id IN (SELECT id FROM users WHERE email = \'test@example.com\')');
    await sql.run('DELETE FROM otel_events WHERE user_id IN (SELECT id FROM users WHERE email = \'test@example.com\')');
    // cowork_session_stats FKs cowork_sessions with no cascade, so it has to go
    // first. (This file used to run against the DEFAULT ./data/ccc.db, where a
    // stats row left by an earlier aggregator run blocked the session delete
    // and failed every test in beforeEach.)
    await sql.run('DELETE FROM cowork_session_stats WHERE session_id IN (SELECT id FROM cowork_sessions WHERE user_id IN (SELECT id FROM users WHERE email = \'test@example.com\'))');
    await sql.run('DELETE FROM cowork_sessions WHERE user_id IN (SELECT id FROM users WHERE email = \'test@example.com\')');
    // Alerts are created by PII detection — delete before users row (FK, no
    // cascade). PII tests wait for their background alert write, so none is
    // still in flight when this runs.
    await sql.run("DELETE FROM alerts WHERE user_id IN (SELECT id FROM users WHERE email = 'test@example.com')");
    await sql.run("DELETE FROM users WHERE email = 'test@example.com'");
    await sql.run("DELETE FROM skill_library_entries WHERE name IN ('writing-plans', 'docx')");
  });

  it('routes user_prompt to cowork_messages with surface=cowork source=otel', async () => {
    const result = await processOtlpLogs(
      makePayload('claude_code.user_prompt', { prompt: 'Hello world' }));
    expect(result.logsInserted).toBe(1);
    const row = (await sql.get("SELECT * FROM cowork_messages WHERE prompt_id = 'prompt_001'")) as any;
    expect(row.surface).toBe('cowork');
    expect(row.source).toBe('otel');
    expect(row.message_type).toBe('cowork_user_message');
  });

  it('auto-creates user with displayNameFromEmail and department from OTEL_RESOURCE_ATTRIBUTES', async () => {
    await processOtlpLogs(makePayload('claude_code.user_prompt', { prompt: 'Hi' }));
    const user = (await sql.get("SELECT * FROM users WHERE email = 'test@example.com'")) as any;
    expect(user.source).toBe('otel');
    expect(user.display_name).toBe('Test');
    expect(user.department).toBe('Engineering');
    expect(user.account_uuid).toBe('uuid-0001');
  });

  it('skips PII detection when prompt is REDACTED but still inserts message', async () => {
    const result = await processOtlpLogs(
      makePayload('claude_code.user_prompt', { prompt: '<REDACTED>' }));
    expect(result.alertsFired).toBe(0);
    expect(result.logsInserted).toBe(1);
  });

  it('routes tool_result with mcp_server_scope to cowork_mcp_invocations', async () => {
    await processOtlpLogs(
      makePayload('claude_code.tool_result', {
        tool_name: 'search_repos',
        mcp_server_scope: 'github',
        success: 'true',
        duration_ms: '250'
      }));
    const mcp = (await sql.get("SELECT * FROM cowork_mcp_invocations WHERE session_id = 'sess_001'")) as any;
    expect(mcp.success).toBe(1);
    expect(mcp.source).toBe('otel');
    expect(mcp.mcp_server).toBe('github');
  });

  it('keeps only the file name of a successful Write, never its content (migration 0028)', async () => {
    await processOtlpLogs(
      makePayload('claude_code.tool_result', {
        tool_name: 'Write',
        success: 'true',
        tool_parameters: JSON.stringify({ file_path: '/sessions/x/outputs/Q3-variance.xlsx' }),
        tool_input: JSON.stringify({ file_path: '/sessions/x/outputs/Q3-variance.xlsx', content: 'CONFIDENTIAL BODY' }),
      }));
    const row = (await sql.get("SELECT content_preview, output_name FROM cowork_messages WHERE session_id = 'sess_001' AND message_type = 'cowork_tool_metadata'")) as any;
    expect(row.content_preview).toBe('Write');
    expect(row.output_name).toBe('Q3-variance.xlsx');
    const any = (await sql.get("SELECT COUNT(*) AS c FROM cowork_messages WHERE coalesce(content_full,'') LIKE '%CONFIDENTIAL%' OR coalesce(output_name,'') LIKE '%CONFIDENTIAL%'")) as any;
    expect(any.c).toBe(0);
  });

  it('routes skill_activated to cowork_skill_invocations only — no cowork_messages row', async () => {
    await processOtlpLogs(
      makePayload('claude_code.skill_activated', { 'skill.name': 'writing-plans' }));
    const skill = (await sql.get("SELECT * FROM cowork_skill_invocations WHERE session_id = 'sess_001'")) as any;
    expect(skill.skill_name).toBe('writing-plans');
    expect(skill.source).toBe('otel');
    const msg = (await sql.get("SELECT COUNT(*) as c FROM cowork_messages WHERE prompt_id = 'prompt_001'")) as any;
    expect(msg.c).toBe(0);
  });

  it('skill_activated for a genuine org-built skill auto-registers as unclaimed (source=org, is_published=0)', async () => {
    await processOtlpLogs(
      makePayload('claude_code.skill_activated', { 'skill.name': 'writing-plans' }));
    const entry = (await sql.get("SELECT source, is_published FROM skill_library_entries WHERE name = 'writing-plans'")) as any;
    expect(entry).not.toBeNull();
    expect(entry.source).toBe('org');
    expect(entry.is_published).toBe(0);
  });

  it('skill_activated for a known Anthropic-bundled skill auto-registers as published (source=anthropic, is_published=1)', async () => {
    await processOtlpLogs(
      makePayload('claude_code.skill_activated', { 'skill.name': 'docx' }));
    const entry = (await sql.get("SELECT source, is_published FROM skill_library_entries WHERE name = 'docx'")) as any;
    expect(entry).not.toBeNull();
    expect(entry.source).toBe('anthropic');
    expect(entry.is_published).toBe(1);
  });

  it('routes api_request with cost_usd and model', async () => {
    await processOtlpLogs(
      makePayload('claude_code.api_request', {
        model: 'claude-sonnet-4-6',
        cost_usd: '0.00245',
        input_tokens: '1200',
        output_tokens: '300'
      }));
    const row = (await sql.get("SELECT * FROM cowork_messages WHERE message_type = 'cowork_api_request'")) as any;
    expect(row.cost_usd).toBeCloseTo(0.00245);
    expect(row.source).toBe('otel');
  });

  it('routes tool_decision to otel_events only — no cowork_messages row', async () => {
    await processOtlpLogs(
      makePayload('claude_code.tool_decision', { tool_name: 'bash', decision: 'accept' }));
    const msg = (await sql.get("SELECT COUNT(*) as c FROM cowork_messages WHERE prompt_id = 'prompt_001'")) as any;
    expect(msg.c).toBe(0);
    const evt = (await sql.get("SELECT * FROM otel_events WHERE prompt_id = 'prompt_001'")) as any;
    expect(evt.event_type).toBe('tool_decision');
  });

  it('silently skips unknown claude_code.* events and increments skipped', async () => {
    const result = await processOtlpLogs(
      makePayload('claude_code.internal_error'));
    expect(result.skipped).toBe(1);
    expect(result.logsInserted).toBe(0);
  });

  it('does not duplicate user row when email already exists — never downgrades source', async () => {
    await sql.run("INSERT INTO users (id, email, source) VALUES ('existing_01', 'test@example.com', 'agent')");
    await processOtlpLogs(makePayload('claude_code.user_prompt', { prompt: 'Hi' }));
    const count = (await sql.get("SELECT COUNT(*) as c FROM users WHERE email = 'test@example.com'")) as any;
    expect(count.c).toBe(1);
    const user = (await sql.get("SELECT source FROM users WHERE email = 'test@example.com'")) as any;
    expect(user.source).toBe('agent');
  });

  it('returns error and zero inserts when resourceLogs missing', async () => {
    const result = await processOtlpLogs({ resourceSpans: [] });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.logsInserted).toBe(0);
  });

  it('truncates stored content at 250/4000 but detects PII beyond the stored window', async () => {
    // 4,500 chars of padding, then a CPF — the match sits past the 4,000-char storage cap.
    // CPF literal must be a check-digit-valid one; copy the exact valid CPF fixture used
    // in test/pii-detect.test.ts rather than inventing digits.
    const cpf = '111.444.777-35';
    const prompt = 'a'.repeat(4500) + ' my CPF is ' + cpf;
    await processOtlpLogs(makePayload('claude_code.user_prompt', { prompt }));

    const row = (await sql.get(
      `SELECT content_preview, content_full, flagged, flag_reason FROM cowork_messages
       WHERE message_type='cowork_user_message' AND session_id='sess_001'`
    )) as { content_preview: string; content_full: string; flagged: number; flag_reason: string };

    expect(row.content_preview.length).toBe(250);
    expect(row.content_full.length).toBe(4000);
    expect(row.content_full).not.toContain(cpf);        // truncated out of storage…
    expect(row.flagged).toBe(1);                        // …but detection saw the full prompt
    expect(row.flag_reason).toContain('cpf');
    // The PII alert is written in the background. Wait for it: this
    // proves the alert was raised, and leaves nothing in flight to land during
    // the next test's cleanup.
    await vi.waitFor(async () => {
      expect(await sql.get(
        "SELECT id FROM alerts WHERE user_id IN (SELECT id FROM users WHERE email = 'test@example.com')",
      )).toBeDefined();
    });
  });

  it('stores short prompts whole (no padding to the cap)', async () => {
    await processOtlpLogs(makePayload('claude_code.user_prompt', { prompt: 'short prompt' }));
    const row = (await sql.get(
      `SELECT content_preview, content_full FROM cowork_messages
       WHERE message_type='cowork_user_message' AND session_id='sess_001'`
    )) as { content_preview: string; content_full: string };
    expect(row.content_preview).toBe('short prompt');
    expect(row.content_full).toBe('short prompt');
  });
});

describe('displayNameFromEmail', () => {
  it('converts single-part local to capitalised word', () => {
    expect(displayNameFromEmail('test@example.com')).toBe('Test');
  });

  it('converts dot-separated local to two capitalised words', () => {
    expect(displayNameFromEmail('alice.johnson@example.com')).toBe('Alice Johnson');
  });

  it('converts a first.last email into a display name', () => {
    expect(displayNameFromEmail('sam.taylor@example.com')).toBe('Sam Taylor');
  });
});
