// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// SQL conditions for the dashboard's kinds of work and vendor switch
// (lib/dashboard/vendor.ts). Each takes an optional table alias prefix such as
// 'cm.'. The strings hold only fixed source and surface names, never input.
import { OPENAI_SOURCES } from '@/lib/openai/sources';
import type { Vendor, WorkKind } from './vendor';

const OPENAI_LIST = OPENAI_SOURCES.map((s) => `'${s}'`).join(', ');

/** Rows from the given vendor, read from `source` (cowork_messages and the invocation tables). */
export function vendorClause(vendor: Vendor, p = ''): string {
  if (vendor === 'openai') return `${p}source IN (${OPENAI_LIST})`;
  if (vendor === 'claude') return `(${p}source IS NULL OR ${p}source NOT IN (${OPENAI_LIST}))`;
  return 'TRUE';
}

/** cowork_messages rows of one kind of work. */
export function kindClause(kind: WorkKind, p = ''): string {
  if (kind === 'chat') return `(${p}surface = 'chat' OR ${p}source = 'chatgpt_chat')`;
  if (kind === 'work') return `((${p}surface = 'cowork' OR ${p}surface IS NULL) AND ${p}source IS DISTINCT FROM 'chatgpt_chat')`;
  return `${p}surface = 'code'`;
}

/** SQL expression naming a cowork_messages row's kind of work ('chat', 'work' or 'code'). */
export function kindExpr(p = ''): string {
  return `CASE WHEN ${kindClause('chat', p)} THEN 'chat' WHEN ${p}surface = 'code' THEN 'code' ELSE 'work' END`;
}

/** SQL expression naming a row's vendor ('claude' or 'openai'). */
export function vendorExpr(p = ''): string {
  return `CASE WHEN ${vendorClause('openai', p)} THEN 'openai' ELSE 'claude' END`;
}

/**
 * code_session_stats rows from the given vendor. That table has no source
 * column; Codex sessions are stored under 'codex:' ids (lib/openai/sync.ts).
 */
export function codeSessionVendorClause(vendor: Vendor, p = ''): string {
  if (vendor === 'openai') return `${p}session_id LIKE 'codex:%'`;
  if (vendor === 'claude') return `${p}session_id NOT LIKE 'codex:%'`;
  return 'TRUE';
}

/**
 * SQL expression naming the product a skill or connector row came from, as
 * its tag reads: 'Claude', 'ChatGPT' or 'Codex' (the invocation tables).
 */
export function toolTagExpr(p = ''): string {
  return `CASE WHEN ${p}source = 'codex' THEN 'Codex'`
    + ` WHEN ${vendorClause('openai', p)} THEN 'ChatGPT'`
    + ` ELSE 'Claude' END`;
}

/** SQL expression naming a cowork_messages row's product (lib/dashboard/vendor.ts PRODUCTS). */
export function productExpr(p = ''): string {
  return `CASE WHEN ${p}source = 'chatgpt_chat' THEN 'chatgpt_chat'`
    + ` WHEN ${p}source = 'chatgpt_work' THEN 'chatgpt_work'`
    + ` WHEN ${p}source = 'codex' THEN 'codex'`
    + ` WHEN ${p}surface = 'chat' THEN 'claude_chat'`
    + ` WHEN ${p}surface = 'code' THEN 'claude_code'`
    + ` ELSE 'claude_cowork' END`;
}
