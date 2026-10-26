// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Session output rate — did a Cowork session produce anything?
 *
 * Work Mix answers what people were doing. Nothing answered whether anything
 * came out the other end. Code already has this (commit_count, pr_count,
 * lines_added, edit_accept_count on code_metrics); Cowork had no equivalent,
 * and Cowork is where the non-engineering work sits.
 *
 * CCC never stores assistant text, so this is answered from TOOL EVIDENCE, not
 * from reading the output. A session counts as having produced something when
 * at least one output-producing tool call SUCCEEDED.
 *
 * WHAT COUNTS: Write, SendUserFile, Artifact.
 * `Edit` is deliberately EXCLUDED — editing an existing file is often mid-work
 * rather than a delivered result, and a session that edited one file five times
 * while going in circles would otherwise score as productive. Measured
 * over 30 days the choice barely moves the figure (38.5% without
 * Edit, 39.9% with), so the conservative reading costs nothing.
 *
 * WHERE IT IS RECORDED: `cowork_session_stats.produced_output` (migration 079 /
 * PG 0020), written by lib/pulse/cowork/session-aggregator.ts at the one point
 * where both the tool name and `tool_success` are in hand.
 *
 * Neither existing source could answer this alone, which is why the column
 * exists. `unique_tools` keeps a tool name regardless of whether the call
 * succeeded, so it can only say a tool was attempted. The raw cowork_messages
 * rows do carry `tool_success`, but retention's strip mode overwrites
 * content_preview (lib/retention/cleanup.ts) — and for a cowork_tool_metadata
 * row that field IS the tool name — so a message-sourced metric would decay as
 * data ages out. cowork_session_stats is untouched by the retention engine.
 *
 * A successful Write means a file was produced, NOT that anyone kept or used
 * it. This is a conservative floor, framed that way in the UI — the same stance
 * as cowork_tool_error_count.
 */

/**
 * Tools whose successful use means the session produced something.
 * Code-defined rather than admin-editable to start; a config key can follow if
 * a customer's tool vocabulary turns out to differ.
 */
export const OUTPUT_TOOLS: ReadonlySet<string> = new Set(['Write', 'SendUserFile', 'Artifact']);

/**
 * The rate as a 0-1 fraction.
 *
 * Returns **null, never 0**, when there are no sessions to divide by — the
 * standing null-not-zero rule: "no sessions measured" and "no session produced
 * anything" are different statements and must render differently.
 */
export function outputRate(produced: number, total: number): number | null {
  if (total <= 0) return null;
  return produced / total;
}
