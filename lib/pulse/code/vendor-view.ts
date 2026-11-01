// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Developer Pulse's All / Claude / Codex switch, server side. Codex is the
// only OpenAI product in Developer Pulse, so its pages name it.
//
// Once Codex data exists, Developer Pulse reads code_metrics_vendor ('all',
// 'claude' or 'openai' rows, migration 0042); before then, and for any reader
// outside Developer Pulse, code_metrics is read as it always was. Until the
// hourly aggregator first fills a view's per-product rows, the All and Claude
// views read code_metrics, so the page never empties in between (before Codex
// arrived, code_metrics was Claude Code alone). Once a view's rows exist they
// are always read: a person or department with no row there has no activity
// in that view, never a figure borrowed from another product.
import { eq, sql, type SQL } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import type { Vendor } from '@/lib/dashboard/vendor';

interface RawFacade {
  execute: (q: unknown) => Promise<{ rows: unknown[] }>;
}

/** True once any Codex prompt has arrived. */
export async function hasCodexData(): Promise<boolean> {
  const client = (await getTypedClient()) as unknown as RawFacade;
  const res = await client.execute(sql`SELECT 1 AS x FROM cowork_messages WHERE source = 'codex' LIMIT 1`);
  return res.rows.length > 0;
}

/** Whether to read code_metrics_vendor for the view (else code_metrics). */
async function readsVendorRows(vendor: Vendor, codexPresent: boolean): Promise<boolean> {
  if (!codexPresent) return false;
  if (vendor === 'openai') return true;
  const client = (await getTypedClient()) as unknown as RawFacade;
  const res = await client.execute(sql`SELECT 1 AS x FROM code_metrics_vendor WHERE vendor = ${vendor} LIMIT 1`);
  return res.rows.length > 0;
}

type CodeMetricsTable = typeof schema.codeMetrics;

/**
 * Runs a code_metrics query against the right rows for the view: `q` gets the
 * table to read and an extra condition to AND in (undefined on code_metrics).
 */
export async function readCodeMetrics<R>(
  vendor: Vendor,
  codexPresent: boolean,
  q: (t: CodeMetricsTable, only: SQL | undefined) => Promise<R[]>,
): Promise<R[]> {
  if (!(await readsVendorRows(vendor, codexPresent))) return q(schema.codeMetrics, undefined);
  const cmv = schema.codeMetricsVendor;
  return q(cmv as unknown as CodeMetricsTable, eq(cmv.vendor, vendor));
}

/** For raw-SQL readers: the code_metrics table to read and the extra condition for the view. */
export async function pickCodeMetricsSource(vendor: Vendor, codexPresent: boolean): Promise<{ table: SQL; only: SQL }> {
  return (await readsVendorRows(vendor, codexPresent))
    ? { table: sql.raw('code_metrics_vendor'), only: sql`AND vendor = ${vendor}` }
    : { table: sql.raw('code_metrics'), only: sql`` };
}

/** The trend readers' vendor argument for the view: none until Codex data exists. */
export function trendVendor(vendor: Vendor, codexPresent: boolean): Vendor | undefined {
  return codexPresent ? vendor : undefined;
}

/** SQL condition on a code session id column for the view (Codex sessions are 'codex:' ids). */
export function codeSessionVendor(column: unknown, vendor: Vendor): SQL {
  if (vendor === 'openai') return sql`${column} LIKE 'codex:%'`;
  if (vendor === 'claude') return sql`${column} NOT LIKE 'codex:%'`;
  return sql`TRUE`;
}
