// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic read/write classification of MCP tool names, for the Library's
 * connector "{reads} reads · {writes} writes" stat line. No LLM involved — a
 * fixed prefix list on the lowercased tool name, after stripping a leading
 * server prefix (e.g. `mcp__gmail__create_draft` -> `create_draft`) up to the
 * LAST `__` if present.
 *
 * Anything not matching either list is `unknown` and excluded from both
 * counters — better to under-report than to mis-classify.
 *
 * Async Drizzle on Postgres. classifyMcpTool is pure;
 * getConnectorReadWriteCounts runs a GROUP BY read.
 */
import { sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';

export type McpToolKind = 'read' | 'write' | 'unknown';

const WRITE_PREFIXES = [
  'create_', 'update_', 'delete_', 'send_', 'add_', 'set_', 'apply_', 'upload_',
  'write_', 'post_', 'remove_', 'insert_', 'move_', 'archive_', 'label_',
  'unlabel_', 'schedule_', 'execute_', 'fill_', 'click_',
];

const READ_PREFIXES = [
  'get_', 'list_', 'search_', 'read_', 'find_', 'fetch_', 'download_', 'query_',
  'describe_', 'soql', 'suggest_', 'check_',
];

function matchesPrefix(name: string, prefixes: string[]): boolean {
  return prefixes.some(p => name.startsWith(p));
}

export function classifyMcpTool(tool: string): McpToolKind {
  const lower = tool.toLowerCase();
  const lastDoubleUnderscore = lower.lastIndexOf('__');
  const stripped = lastDoubleUnderscore >= 0 ? lower.slice(lastDoubleUnderscore + 2) : lower;

  if (matchesPrefix(stripped, WRITE_PREFIXES)) return 'write';
  if (matchesPrefix(stripped, READ_PREFIXES)) return 'read';
  return 'unknown';
}

export async function getConnectorReadWriteCounts(): Promise<Map<string, { reads: number; writes: number }>> {
  const client = await getTypedClient();
  const t = schema.coworkMcpInvocations;

  const rows = await client
    .select({
      mcp_server: t.mcp_server,
      mcp_tool: t.mcp_tool,
      n: sql<number | string>`count(*)`,
    })
    .from(t)
    .groupBy(t.mcp_server, t.mcp_tool);

  const counts = new Map<string, { reads: number; writes: number }>();
  for (const row of rows) {
    const entry = counts.get(row.mcp_server) ?? { reads: 0, writes: 0 };
    counts.set(row.mcp_server, entry);

    const kind = classifyMcpTool(row.mcp_tool);
    if (kind === 'unknown') continue;
    // Policy B: count(*) comes back as a string on pg.
    const n = Number(row.n);
    if (kind === 'read') entry.reads += n;
    else entry.writes += n;
  }
  return counts;
}
