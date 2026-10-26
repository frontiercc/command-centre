// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Claude subagent attribution kept at ingest (migration 0036).
 *
 * A subagent shows up two ways in Claude's OTel events:
 *  - every model call it makes carries `agent.name` (and a `query_source`);
 *  - its launch is a tool call to `Agent` (formerly `Task`) whose
 *    `tool_parameters` include `subagent_type` when clients send tool details.
 * Only these short labels are kept. The launch's `tool_input` holds the prompt
 * handed to the subagent and is never read for this.
 */

/** Tool names that launch a subagent. */
export const SUBAGENT_LAUNCH_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task']);

/** Longest label kept; real names are a few dozen characters. */
export const SUBAGENT_LABEL_MAX = 200;

/** A usable label from an OTel value: a non-empty string, trimmed, capped. */
export function subagentLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v) return null;
  return v.slice(0, SUBAGENT_LABEL_MAX);
}
