// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;
let tokens: typeof import('@/lib/connector/tokens');
let period: typeof import('@/lib/pulse/period');
let mcp: typeof import('@/lib/connector/mcp');
let mcpRoute: typeof import('../app/api/mcp/route');

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
  tokens = await import('@/lib/connector/tokens');
  period = await import('@/lib/pulse/period');
  mcp = await import('@/lib/connector/mcp');
  mcpRoute = await import('../app/api/mcp/route');

  await seedFixtures();
});

afterAll(async () => cleanup());

async function seedFixtures() {
  const now = Math.floor(Date.now() / 1000);
  const completedWeekStart = period.priorWeekStart(now);
  const priorCompletedWeekStart = completedWeekStart - 7 * 24 * 3600;

  const insertOrgCodeMetric = (params: unknown[]) => sql.run(
    `INSERT INTO code_metrics (
       scope_type, scope_id, period_start, period_end, granularity,
       spend_usd, commit_count, pr_count, session_count, active_time_user_s, computed_at
     ) VALUES ('organisation', 'org', ?, ?, 'week', ?, ?, ?, ?, ?, ?)`,
    params
  );
  await insertOrgCodeMetric([
    completedWeekStart, completedWeekStart + 7 * 24 * 3600,
    123.45, 10, 2, 5, 3600, now,
  ]);
  await insertOrgCodeMetric([
    priorCompletedWeekStart, priorCompletedWeekStart + 7 * 24 * 3600,
    100.0, 8, 1, 4, 3000, now,
  ]);

  await sql.run(
    `INSERT INTO pulse_metrics (
       scope_type, scope_id, period_start, period_end, granularity,
       event_count, tier_3_count, computed_at
     ) VALUES ('user', ?, ?, ?, 'week', ?, ?, ?)`,
    ['some-other-user', completedWeekStart, completedWeekStart + 7 * 24 * 3600, 42, 7, now]
  );
}

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

function rpc(method: string, params?: object, id: number | string | null = 1) {
  const body: Record<string, unknown> = { jsonrpc: '2.0', method };
  if (params !== undefined) body.params = params;
  if (id !== undefined) body.id = id;
  return body;
}

describe('handleMcpRequest — protocol handling (pure, direct)', () => {
  it('initialize returns protocol handshake', async () => {
    const res = await mcp.handleMcpRequest(rpc('initialize', { protocolVersion: '2025-06-18' }, 1));
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'command-centre-metrics', version: '1.0.0' },
      },
    });
  });

  it('notifications/initialized (no id) returns 202 with no body', async () => {
    const res = await mcp.handleMcpRequest({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res.status).toBe(202);
    expect(res.json).toBeUndefined();
  });

  it('tools/list returns exactly 3 tools, each with a type:"object" inputSchema', async () => {
    const res = await mcp.handleMcpRequest(rpc('tools/list', undefined, 2));
    expect(res.status).toBe(200);
    const json = res.json as { result: { tools: Array<{ name: string; description: string; inputSchema: { type: string } }> } };
    expect(json.result.tools).toHaveLength(3);
    const names = json.result.tools.map((t) => t.name).sort();
    expect(names).toEqual(['get_data_health', 'get_metric_trend', 'get_weekly_summary'].sort());
    for (const tool of json.result.tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  it('get_metric_trend tool schema exposes the connector metric allowlist as an enum', async () => {
    const data = await import('@/lib/connector/data');
    const res = await mcp.handleMcpRequest(rpc('tools/list', undefined, 2));
    const json = res.json as { result: { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> } };
    const trendTool = json.result.tools.find((t) => t.name === 'get_metric_trend')!;
    const metricProp = trendTool.inputSchema.properties.metric as { enum: string[] };
    expect(metricProp.enum).toEqual(Array.from(data.CONNECTOR_METRIC_ALLOWLIST));
  });

  it('tools/call get_weekly_summary happy path against seeded DB', async () => {
    const res = await mcp.handleMcpRequest(rpc('tools/call', { name: 'get_weekly_summary', arguments: {} }, 3));
    expect(res.status).toBe(200);
    const json = res.json as { result: { content: Array<{ type: string; text: string }> } };
    expect(json.result.content).toHaveLength(1);
    expect(json.result.content[0].type).toBe('text');
    const parsed = JSON.parse(json.result.content[0].text);
    expect(parsed).toHaveProperty('weekStart');
    expect(parsed).toHaveProperty('code');
    expect(parsed).toHaveProperty('cowork');
  });

  it('tools/call get_metric_trend happy path against seeded DB', async () => {
    const res = await mcp.handleMcpRequest(
      rpc('tools/call', { name: 'get_metric_trend', arguments: { metric: 'spend_usd', weeks: 4 } }, 4)
    );
    expect(res.status).toBe(200);
    const json = res.json as { result: { content: Array<{ type: string; text: string }> } };
    const parsed = JSON.parse(json.result.content[0].text);
    expect(parsed.metric).toBe('spend_usd');
    expect(parsed.weeks).toBe(4);
    expect(Array.isArray(parsed.series)).toBe(true);
  });

  it('tools/call get_metric_trend defaults weeks to 8 when omitted', async () => {
    const res = await mcp.handleMcpRequest(
      rpc('tools/call', { name: 'get_metric_trend', arguments: { metric: 'spend_usd' } }, 5)
    );
    const json = res.json as { result: { content: Array<{ type: string; text: string }> } };
    const parsed = JSON.parse(json.result.content[0].text);
    expect(parsed.weeks).toBe(8);
  });

  it('tools/call get_data_health happy path', async () => {
    const res = await mcp.handleMcpRequest(rpc('tools/call', { name: 'get_data_health', arguments: {} }, 6));
    expect(res.status).toBe(200);
    const json = res.json as { result: { content: Array<{ type: string; text: string }> } };
    const parsed = JSON.parse(json.result.content[0].text);
    expect(parsed).toHaveProperty('unpricedModels');
    expect(parsed).toHaveProperty('aggregatorLastRun');
  });

  it('tools/call get_metric_trend with a bad metric returns isError:true, NOT a protocol error', async () => {
    const res = await mcp.handleMcpRequest(
      rpc('tools/call', { name: 'get_metric_trend', arguments: { metric: 'not_a_real_metric' } }, 7)
    );
    expect(res.status).toBe(200);
    const json = res.json as { result: { content: Array<{ type: string; text: string }>; isError: boolean }; error?: unknown };
    expect(json.error).toBeUndefined();
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].type).toBe('text');
  });

  it('tools/call with an unknown tool name returns isError:true', async () => {
    const res = await mcp.handleMcpRequest(rpc('tools/call', { name: 'not_a_real_tool', arguments: {} }, 8));
    expect(res.status).toBe(200);
    const json = res.json as { result: { isError: boolean } };
    expect(json.result.isError).toBe(true);
  });

  it('tools/call with missing/invalid params returns -32602', async () => {
    const res = await mcp.handleMcpRequest({ jsonrpc: '2.0', method: 'tools/call', id: 9, params: { arguments: {} } });
    const json = res.json as { error: { code: number } };
    expect(json.error.code).toBe(-32602);
  });

  it('unknown method returns -32601', async () => {
    const res = await mcp.handleMcpRequest(rpc('not/a/real/method', undefined, 10));
    expect(res.status).toBe(200);
    const json = res.json as { jsonrpc: string; id: number; error: { code: number; message: string } };
    expect(json.jsonrpc).toBe('2.0');
    expect(json.id).toBe(10);
    expect(json.error.code).toBe(-32601);
  });

  it('batch array requests are rejected with -32600', async () => {
    const res = await mcp.handleMcpRequest([rpc('initialize', undefined, 1), rpc('tools/list', undefined, 2)]);
    expect(res.status).toBe(200);
    const json = res.json as { error: { code: number } };
    expect(json.error.code).toBe(-32600);
  });

  it('a request missing jsonrpc/method entirely is rejected with -32600', async () => {
    const res = await mcp.handleMcpRequest({ id: 1 });
    const json = res.json as { error: { code: number } };
    expect(json.error.code).toBe(-32600);
  });
});

describe('POST /api/mcp — route-level auth, parsing, dispatch', () => {
  it('returns 401 (plain JSON, not JSON-RPC) without a token', async () => {
    const req = new NextRequest('http://localhost/api/mcp', {
      method: 'POST',
      body: JSON.stringify(rpc('initialize', undefined, 1)),
    });
    const res = await mcpRoute.POST(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: 'Unauthorized' });
  });

  it('returns 401 with a bad/garbage token', async () => {
    const req = new NextRequest('http://localhost/api/mcp', {
      method: 'POST',
      headers: authHeader('garbage-not-a-real-token'),
      body: JSON.stringify(rpc('initialize', undefined, 1)),
    });
    const res = await mcpRoute.POST(req);
    expect(res.status).toBe(401);
  });

  it('malformed JSON body returns JSON-RPC -32700 parse error', async () => {
    const { token } = await tokens.mintConnectorToken('mcp-malformed-json');
    const req = new NextRequest('http://localhost/api/mcp', {
      method: 'POST',
      headers: authHeader(token),
      body: '{not valid json',
    });
    const res = await mcpRoute.POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error.code).toBe(-32700);
  });

  it('valid token + initialize returns the handshake result', async () => {
    const { token } = await tokens.mintConnectorToken('mcp-initialize');
    const req = new NextRequest('http://localhost/api/mcp', {
      method: 'POST',
      headers: authHeader(token),
      body: JSON.stringify(rpc('initialize', { protocolVersion: '2025-06-18' }, 1)),
    });
    const res = await mcpRoute.POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.serverInfo.name).toBe('command-centre-metrics');
  });

  it('valid token + tools/call get_weekly_summary end-to-end', async () => {
    const { token } = await tokens.mintConnectorToken('mcp-tools-call-e2e');
    const req = new NextRequest('http://localhost/api/mcp', {
      method: 'POST',
      headers: authHeader(token),
      body: JSON.stringify(rpc('tools/call', { name: 'get_weekly_summary', arguments: {} }, 1)),
    });
    const res = await mcpRoute.POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = JSON.parse(body.result.content[0].text);
    expect(parsed).toHaveProperty('code');
  });

  it('notification (no id) returns HTTP 202 with empty body', async () => {
    const { token } = await tokens.mintConnectorToken('mcp-notification');
    const req = new NextRequest('http://localhost/api/mcp', {
      method: 'POST',
      headers: authHeader(token),
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    const res = await mcpRoute.POST(req);
    expect(res.status).toBe(202);
    const text = await res.text();
    expect(text).toBe('');
  });

  it('GET returns 405 Method not allowed', async () => {
    const res = await mcpRoute.GET();
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body).toEqual({ error: 'Method not allowed' });
  });

  it('bumps last_used_at on the connector token after a real MCP call', async () => {
    const { token, record } = await tokens.mintConnectorToken('mcp-last-used-bump');
    expect(record.lastUsedAt).toBeNull();

    const req = new NextRequest('http://localhost/api/mcp', {
      method: 'POST',
      headers: authHeader(token),
      body: JSON.stringify(rpc('initialize', undefined, 1)),
    });
    const res = await mcpRoute.POST(req);
    expect(res.status).toBe(200);

    const list = await tokens.listConnectorTokens();
    const entry = list.find((r) => r.id === record.id);
    expect(entry?.lastUsedAt).not.toBeNull();
  });
});
