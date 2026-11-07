// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The S&C Board's skill and connector uses, with ChatGPT's and Codex's left out
// while "Show ChatGPT and Codex" is off (lib/sources/openai-visibility.ts), so
// the Board then counts, ranks and tags Claude's uses only.
import { sql, type SQL } from 'drizzle-orm';
import { OPENAI_SOURCES } from '@/lib/openai/sources';
import { openaiShown } from '@/lib/sources/openai-visibility';

const CLAUDE_ONLY = `(source IS NULL OR source NOT IN (${OPENAI_SOURCES.map(s => `'${s}'`).join(', ')}))`;

export interface BoardUses {
  /** False while ChatGPT and Codex are hidden. */
  shown: boolean;
  /** Use in place of `cowork_skill_invocations` in raw SQL: the table, or Claude's rows under the same name. */
  skills: SQL;
  /** Use in place of `cowork_mcp_invocations` in raw SQL. */
  connectors: SQL;
  /** A condition for a query-builder read of either table (undefined when shown). */
  claudeOnly: SQL | undefined;
}

export async function boardUses(): Promise<BoardUses> {
  const shown = await openaiShown();
  if (shown) {
    return { shown, skills: sql.raw('cowork_skill_invocations'), connectors: sql.raw('cowork_mcp_invocations'), claudeOnly: undefined };
  }
  return {
    shown,
    skills: sql.raw(`(SELECT * FROM cowork_skill_invocations WHERE ${CLAUDE_ONLY}) AS cowork_skill_invocations`),
    connectors: sql.raw(`(SELECT * FROM cowork_mcp_invocations WHERE ${CLAUDE_ONLY}) AS cowork_mcp_invocations`),
    claudeOnly: sql.raw(CLAUDE_ONLY),
  };
}

/**
 * Board entries to leave out while hidden: ones used, but only in ChatGPT or
 * Codex. An entry with no uses at all (an official skill, one added by hand)
 * stays. `e` is the skill_library_entries alias.
 */
export function hideOpenAiOnlyEntries(): SQL {
  return sql.raw(`NOT (
    (e.type = 'connector' AND EXISTS (SELECT 1 FROM cowork_mcp_invocations i WHERE i.mcp_server = e.name)
      AND NOT EXISTS (SELECT 1 FROM cowork_mcp_invocations i WHERE i.mcp_server = e.name AND ${CLAUDE_ONLY.replace(/source/g, 'i.source')}))
    OR (e.type <> 'connector' AND EXISTS (SELECT 1 FROM cowork_skill_invocations i WHERE i.skill_name = e.name)
      AND NOT EXISTS (SELECT 1 FROM cowork_skill_invocations i WHERE i.skill_name = e.name AND ${CLAUDE_ONLY.replace(/source/g, 'i.source')}))
  )`);
}
