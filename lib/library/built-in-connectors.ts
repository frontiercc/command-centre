// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { sql, type SQL } from 'drizzle-orm';
import { BUILT_IN_CONNECTOR_NAMES, BUILT_IN_SKILL_NAMES, normToolName } from '@/lib/finance/spend-review-builtins';

/**
 * Connectors that are part of Claude itself, never shown on the S&C Board or counted in it:
 * Claude's internal servers (the Spend Review built-in list, e.g. ccd_session, visualize), plus
 * Claude in Chrome and Claude Preview, which the board has always left out. Nobody can claim
 * them, and listing them would inflate the board's counts. Their use is still recorded.
 * Names are compared as the built-in list compares them: case, spaces and underscores ignored.
 */
const HIDDEN = [...new Set([...BUILT_IN_CONNECTOR_NAMES, 'Claude_in_Chrome', 'Claude_Preview'].map(normToolName))];

export function isBoardHiddenConnector(name: string | null | undefined): boolean {
  return !!name && HIDDEN.includes(normToolName(name));
}

/** SQL: `column` (a connector name) is not one of Claude's own. */
export function notBoardHiddenConnector(column: SQL): SQL {
  return sql`lower(regexp_replace(trim(${column}), '[[:space:]_]+', '-', 'g')) NOT IN (${sql.join(HIDDEN.map(n => sql`${n}`), sql`, `)})`;
}

/**
 * Claude's own skills (Claude Code's bundled skills such as run, init, code-review and verify),
 * likewise never shown on the Board or counted in it: they ship with Claude, so nobody in the
 * organisation can claim them. From the same built-in list Spend Review uses.
 */
const HIDDEN_SKILLS = [...new Set(BUILT_IN_SKILL_NAMES.map(normToolName))];

export function isBoardHiddenSkill(name: string | null | undefined): boolean {
  return !!name && HIDDEN_SKILLS.includes(normToolName(name));
}

/** SQL: `column` (a skill name) is not one of Claude's own. */
export function notBoardHiddenSkill(column: SQL): SQL {
  return sql`lower(regexp_replace(trim(${column}), '[[:space:]_]+', '-', 'g')) NOT IN (${sql.join(HIDDEN_SKILLS.map(n => sql`${n}`), sql`, `)})`;
}

/** SQL: a skill_library_entries row is not one of Claude's own connectors or skills (its type and name columns). */
export function entryNotBoardHidden(type: SQL, name: SQL): SQL {
  return sql`(CASE WHEN ${type} = 'connector' THEN ${notBoardHiddenConnector(name)} ELSE ${notBoardHiddenSkill(name)} END)`;
}
