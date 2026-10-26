// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Real lib/db/migrations-pg in a
// postgres:16 testcontainer.
//
//  - every record claims a stable key first, so a re-delivered batch is
//    skipped, never stored or counted twice;
//  - one Claude Code model-call row per request_id, not per prompt (spend was
//    read at ~a quarter of the true figure);
//  - friction rows have their own id (they collided with the model-call row);
//  - tool-use / commit counters land on exactly one row per prompt;
//  - the cost-spike alert stays quiet for 7 days after the cut-over;
//  - retention prunes the register after 7 days.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

type Rows = Array<Record<string, unknown>>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let cleanup: () => Promise<void>;
let sqlTag: typeof import('drizzle-orm').sql;
let cowork: typeof import('@/lib/otel/cowork-receiver');
let code: typeof import('@/lib/otel/code-receiver');
let eventKey: typeof import('@/lib/otel/event-key');
let withTx: typeof import('@/lib/db/with-tx').withTx;
let alerts: typeof import('@/lib/alerts/code-pulse-alerts');
let retention: typeof import('@/lib/retention/cleanup');

const EMAIL = 'keys@example.com';
const INSTALL = 'k'.repeat(64);
let t = 0;
const nano = () => `${1_790_000_000 + (++t)}000000000`;

const attr = (key: string, v: string) => ({ key, value: { stringValue: v } });
function rec(event: string, extra: Record<string, string>, session = 'sess-k', prompt = 'prompt-k') {
  return { timeUnixNano: nano(), attributes: [attr('event.name', event), attr('user.email', EMAIL), attr('user.id', INSTALL), attr('session.id', session), attr('prompt.id', prompt), ...Object.entries(extra).map(([k, v]) => attr(k, v))] };
}
const batch = (service: 'cowork' | 'claude-code', records: unknown[]) => ({
  resourceLogs: [{ resource: { attributes: [attr('service.name', service)] }, scopeLogs: [{ logRecords: records }] }],
});

async function q(text: string, ...params: unknown[]): Promise<Rows> {
  const parts = text.split(/\$\d+/);
  let stmt = sqlTag.raw(parts[0]);
  for (let i = 1; i < parts.length; i++) stmt = sqlTag`${stmt}${params[i - 1]}${sqlTag.raw(parts[i])}`;
  const r = await db.execute(stmt);
  return (r.rows ?? r) as Rows;
}
const one = async (text: string, ...params: unknown[]) => (await q(text, ...params))[0];

describe('OTel event keys and safe retries (postgres)', () => {
  beforeAll(async () => {
    const { createTestDbClient } = await import('./helpers/db');
    const c = await createTestDbClient('postgres');
    db = c.client; cleanup = c.cleanup;
    sqlTag = (await import('drizzle-orm')).sql;
    cowork = await import('@/lib/otel/cowork-receiver');
    code = await import('@/lib/otel/code-receiver');
    eventKey = await import('@/lib/otel/event-key');
    withTx = (await import('@/lib/db/with-tx')).withTx;
    alerts = await import('@/lib/alerts/code-pulse-alerts');
    retention = await import('@/lib/retention/cleanup');
  }, 180_000);
  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(async () => {
    for (const tbl of ['pulse_classifications', 'pulse_events', 'pulse_skill_runs', 'cowork_messages', 'cowork_mcp_invocations',
      'cowork_skill_invocations', 'code_assistant_meta', 'cowork_session_stats', 'cowork_sessions', 'alerts', 'otel_ingested_events']) {
      await q(`DELETE FROM ${tbl}`);
    }
    await q(`DELETE FROM admin_users WHERE email LIKE '%@example.com'`);
    await q(`DELETE FROM users WHERE email LIKE '%@example.com'`);
  });

  describe('a re-delivered batch is stored once', () => {
    it('Cowork: prompt, tool result and model call sent twice → one set of rows', async () => {
      const b = batch('cowork', [
        rec('user_prompt', { prompt: 'hello', prompt_length: '5' }),
        rec('tool_result', { tool_name: 'Read', success: 'true' }),
        rec('api_request', { model: 'claude-sonnet-4-6', input_tokens: '100', output_tokens: '10', cost_usd: '0.01' }),
      ]);
      const first = await cowork.processOtlpLogs(b);
      const second = await cowork.processOtlpLogs(b);
      expect(first.errors).toEqual([]);
      expect(second.errors).toEqual([]);
      expect(second.skipped).toBe(3);
      expect(Number((await one(`SELECT COUNT(*) AS n FROM cowork_messages`)).n)).toBe(3);
    });

    it('Code: four model calls for one prompt → four rows, tokens counted once each, resend changes nothing', async () => {
      const b = batch('claude-code', [1, 2, 3, 4].map(i =>
        rec('api_request', { model: 'claude-sonnet-4-6', input_tokens: '1000', output_tokens: '100', request_id: `req_${i}` })));
      await code.processCodeOtlpLogs(b);
      await code.processCodeOtlpLogs(b);
      const r = await one(`SELECT COUNT(*) AS n, SUM(input_tokens) AS inp FROM code_assistant_meta WHERE model != ''`);
      expect(Number(r.n)).toBe(4);
      expect(Number(r.inp)).toBe(4000);
      expect((await q(`SELECT id FROM code_assistant_meta ORDER BY id`)).map(x => x.id)).toEqual(['req_1', 'req_2', 'req_3', 'req_4']);
    });
  });

  describe('counters and friction', () => {
    it('tool uses and a commit on a four-call prompt are counted once each, even when re-sent', async () => {
      await code.processCodeOtlpLogs(batch('claude-code', [1, 2, 3, 4].map(i =>
        rec('api_request', { model: 'claude-sonnet-4-6', input_tokens: '10', output_tokens: '1', request_id: `req_${i}` }))));
      const tools = batch('claude-code', [
        rec('tool_decision', { tool_name: 'Bash', decision: 'accept', tool_use_id: 'tu_1' }),
        rec('tool_decision', { tool_name: 'Read', decision: 'accept', tool_use_id: 'tu_2' }),
        rec('tool_result', { tool_name: 'Bash', success: 'true', tool_use_id: 'tu_1', tool_parameters: JSON.stringify({ git_commit_id: 'abc' }) }),
      ]);
      await code.processCodeOtlpLogs(tools);
      await code.processCodeOtlpLogs(tools);
      const r = await one(`SELECT SUM(tool_use_count) AS tools, SUM(commit_count) AS commits, COUNT(*) FILTER (WHERE tool_use_count > 0) AS carriers FROM code_assistant_meta WHERE model != ''`);
      expect(Number(r.tools)).toBe(2);
      expect(Number(r.commits)).toBe(1);
      expect(Number(r.carriers)).toBe(1);
    });

    it('a failed tool after its model call is stored as its own friction row, with its prompt', async () => {
      await code.processCodeOtlpLogs(batch('claude-code', [
        rec('api_request', { model: 'claude-sonnet-4-6', input_tokens: '10', output_tokens: '1', request_id: 'req_f' }),
        rec('tool_result', { tool_name: 'Bash', success: 'false', tool_use_id: 'tu_f' }),
      ]));
      const f = await one(`SELECT id, prompt_id, error_count FROM code_assistant_meta WHERE model = ''`);
      expect(f).toMatchObject({ id: 'err:tu_f', prompt_id: 'prompt-k' });
      expect(Number(f.error_count)).toBe(1);
      expect(Number((await one(`SELECT COUNT(*) AS n FROM code_assistant_meta WHERE model != ''`)).n)).toBe(1);
    });
  });

  it('a claim inside a transaction that fails is rolled back, so the record can be re-sent', async () => {
    const { getTypedClient } = await import('@/lib/db/client');
    const client = await getTypedClient();
    await expect(withTx(client, async (tx) => {
      expect(await eventKey.claimOtelEvent(tx, 'test:rollback', 1)).toBe(true);
      throw new Error('record failed');
    })).rejects.toThrow('record failed');
    expect(Number((await one(`SELECT COUNT(*) AS n FROM otel_ingested_events WHERE event_key = 'test:rollback'`)).n)).toBe(0);
  });

  it('keys: request_id and tool_use_id when present, otherwise a hash that changes when any attribute does', () => {
    const k = (event: string, attrs: Array<{ key: string; value: { stringValue: string } }>) =>
      eventKey.otelEventKey({ service: 'claude-code', eventName: event, sessionId: 's', attrs, timeUnixNano: '1' });
    expect(k('claude_code.api_request', [attr('request_id', 'req_x')])).toBe('api_request:req_x');
    expect(k('claude_code.tool_result', [attr('tool_use_id', 'tu_x')])).toBe('tool_result:tu_x');
    const a = k('claude_code.user_prompt', [attr('prompt', 'one')]);
    expect(a).toMatch(/^h:[0-9a-f]{64}$/);
    expect(k('claude_code.user_prompt', [attr('prompt', 'one')])).toBe(a);
    expect(k('claude_code.user_prompt', [attr('prompt', 'two')])).not.toBe(a);
  });

  // The 7-day quiet period after the per-call cut-over protected a baseline
  // built from older rows. The alert is now a fixed daily limit
  // with no baseline, so the cut-over no longer silences it.
  it('cost-spike alert: the per-call cut-over no longer silences the daily limit', async () => {
    await q(`INSERT INTO users (id, email, source) VALUES ($1, $2, 'otel')`, INSTALL, EMAIL);
    // claude-sonnet-4-6 at $3 per million input tokens: 40M = $120, over the $100 default.
    await q(`INSERT INTO code_assistant_meta (id, user_id, session_id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, tool_use_count, error_count, source, occurred_at)
             VALUES ('spike', $1, 's', 'claude-sonnet-4-6', 40000000, 0, 0, 0, 0, 0, 'otel', $2)`, INSTALL, Math.floor(Date.now() / 1000) - 3600);
    await q(`UPDATE config SET value = $1 WHERE key = 'code_meta_per_call_since'`, String(Math.floor(Date.now() / 1000) - 86400));
    await alerts.runCodePulseAlerts();
    expect(Number((await one(`SELECT COUNT(*) AS n FROM alerts WHERE alert_type = 'code_cost_spike'`)).n)).toBe(1);
  });

  it('retention prunes register keys older than 7 days, keeps recent ones', async () => {
    const now = Math.floor(Date.now() / 1000);
    await q(`INSERT INTO otel_ingested_events (event_key, received_at) VALUES ('old', $1), ('new', $2)`, now - 8 * 86400, now - 3600);
    await q(`DELETE FROM config WHERE key = 'archive_enabled'`);
    await retention.runRetentionCleanup();
    expect((await q(`SELECT event_key FROM otel_ingested_events ORDER BY event_key`)).map(x => x.event_key)).toEqual(['new']);
  });

  it('the migration stamped the cut-over time', async () => {
    const r = await one(`SELECT value FROM config WHERE key = 'code_meta_per_call_since'`);
    expect(Number(r.value)).toBeGreaterThan(1_700_000_000);
  });
});
