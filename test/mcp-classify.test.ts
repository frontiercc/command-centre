// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import { seedUserSql } from './helpers/seed';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;

type McpToolKind = 'read' | 'write' | 'unknown';
let classifyMcpTool: (tool: string) => McpToolKind;
let getConnectorReadWriteCounts: () => Promise<Map<string, { reads: number; writes: number }>>;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;

  const mod = await import('@/lib/pulse/mcp-classify');
  classifyMcpTool = mod.classifyMcpTool;
  getConnectorReadWriteCounts = mod.getConnectorReadWriteCounts;

  await seedUserSql(sql, 'user-1');
  await seedUserSql(sql, 'user-2');
});

afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec('DELETE FROM cowork_mcp_invocations');
});

async function insertMcpInvocation(opts: {
  id: string; userId: string; server: string; tool: string; occurredAt?: number;
}) {
  const now = Math.floor(Date.now() / 1000);
  await sql.run(`
    INSERT INTO cowork_mcp_invocations (id, user_id, session_id, mcp_server, mcp_tool, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [opts.id, opts.userId, `session-${opts.id}`, opts.server, opts.tool, opts.occurredAt ?? now]);
}

describe('classifyMcpTool', () => {
  const cases: Array<[string, McpToolKind]> = [
    ['create_issue', 'write'],
    ['update_record', 'write'],
    ['delete_file', 'write'],
    ['send_message', 'write'],
    ['add_reaction', 'write'],
    ['set_config', 'write'],
    ['apply_label', 'write'],
    ['upload_file', 'write'],
    ['write_file', 'write'],
    ['post_comment', 'write'],
    ['remove_label', 'write'],
    ['insert_row', 'write'],
    ['move_file', 'write'],
    ['archive_thread', 'write'],
    ['label_message', 'write'],
    ['unlabel_message', 'write'],
    ['schedule_message', 'write'],
    ['execute_query', 'write'],
    ['fill_form', 'write'],
    ['click_element', 'write'],
    ['search_repos', 'read'],
    ['get_file', 'read'],
    ['list_drafts', 'read'],
    ['read_page', 'read'],
    ['find_element', 'read'],
    ['fetch_data', 'read'],
    ['download_file_content', 'read'],
    ['query_records', 'read'],
    ['describe_object', 'read'],
    ['soqlQuery', 'read'],
    ['suggest_connectors', 'read'],
    ['check_status', 'read'],
    ['visualize', 'unknown'],
    ['mcp__gmail__create_draft', 'write'],
    ['mcp__github__search_repos', 'read'],
    ['mcp__weird__unknown_op', 'unknown'],
  ];

  it.each(cases)('classifies %s as %s', (tool, expected) => {
    expect(classifyMcpTool(tool)).toBe(expected);
  });

  it('is case-insensitive', () => {
    expect(classifyMcpTool('CREATE_ISSUE')).toBe('write');
    expect(classifyMcpTool('Get_File')).toBe('read');
  });

  it('strips only up to the LAST double-underscore prefix', () => {
    expect(classifyMcpTool('mcp__gmail__labels__create_label')).toBe('write');
  });
});

describe('getConnectorReadWriteCounts', () => {
  it('returns exact per-server read/write counts, excluding unknown tools', async () => {
    await insertMcpInvocation({ id: 'm1', userId: 'user-1', server: 'github', tool: 'search_repos' });
    await insertMcpInvocation({ id: 'm2', userId: 'user-1', server: 'github', tool: 'search_repos' });
    await insertMcpInvocation({ id: 'm3', userId: 'user-1', server: 'github', tool: 'create_issue' });
    await insertMcpInvocation({ id: 'm4', userId: 'user-2', server: 'github', tool: 'visualize' });
    await insertMcpInvocation({ id: 'm5', userId: 'user-2', server: 'gmail', tool: 'mcp__gmail__create_draft' });
    await insertMcpInvocation({ id: 'm6', userId: 'user-2', server: 'gmail', tool: 'list_drafts' });

    const counts = await getConnectorReadWriteCounts();

    expect(counts.get('github')).toEqual({ reads: 2, writes: 1 });
    expect(counts.get('gmail')).toEqual({ reads: 1, writes: 1 });
  });

  it('excludes unknown tools from both counters', async () => {
    await insertMcpInvocation({ id: 'm1', userId: 'user-1', server: 'weird', tool: 'visualize' });

    const counts = await getConnectorReadWriteCounts();

    expect(counts.get('weird')).toEqual({ reads: 0, writes: 0 });
  });

  it('returns an empty map when there are no invocations', async () => {
    const counts = await getConnectorReadWriteCounts();
    expect(counts.size).toBe(0);
  });
});
