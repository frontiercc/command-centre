// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { fenceUntrusted } from '@/lib/anthropic/untrusted';

export interface ClassifierEvent {
  id: string;
  user_id: string;
  session_id: string | null;
  content: string;
  tool_name: string | null;
  occurred_at: number;
  /** MCP servers used in the same session, e.g. ['github', 'linear'] */
  mcp_servers?: string[];
  /** Skills the user explicitly invoked via slash command in the same session */
  user_typed_skills?: string[];
  /** Skills Claude autonomously chained via the Skill tool in the same session */
  agent_chained_skills?: string[];
  /** OTel: total tool calls made in the session (direct depth signal) */
  otel_tool_call_count?: number | null;
  /** OTel: distinct tool names used in the session, e.g. ['bash', 'read_file', 'web_search'] */
  otel_unique_tools?: string[];
  /** OTel: number of files uploaded in the session */
  otel_upload_count?: number | null;
}

export interface UserHistory {
  user_id: string;
  prior_tiers_observed: number[];
  prior_task_types_observed: string[];
  prior_capability_creation_events: number;
}

export { buildClassifierSystemMessage, getTierConfig } from '@/lib/pulse/tier-config';

/**
 * Build the user message for a classifier batch.
 * @param events   — batch of cowork_messages rows to classify (up to 50)
 * @param history  — map of user_id → UserHistory, covering all users in the batch
 */
export function buildClassifierUserMessage(
  events: ClassifierEvent[],
  history: Map<string, UserHistory>
): string {
  const lines: string[] = [];

  lines.push('Classify the following events. For each user, the relevant history is');
  lines.push('attached so frontier_push_candidate can be set correctly.');
  lines.push('');

  // USER HISTORY block
  lines.push('USER HISTORY');
  lines.push('============');

  // Collect unique user IDs from this batch
  const userIds = [...new Set(events.map(e => e.user_id))];
  for (const userId of userIds) {
    const h = history.get(userId) ?? {
      user_id: userId,
      prior_tiers_observed: [],
      prior_task_types_observed: [],
      prior_capability_creation_events: 0,
    };
    lines.push(`user_id: ${h.user_id}`);
    lines.push(`prior_tiers_observed: [${h.prior_tiers_observed.join(', ')}]`);
    lines.push(`prior_task_types_observed: [${h.prior_task_types_observed.join(', ')}]`);
    lines.push(`prior_capability_creation_events: ${h.prior_capability_creation_events}`);
    lines.push('');
  }

  // EVENTS block
  lines.push('EVENTS');
  lines.push('======');
  lines.push('');

  for (const event of events) {
    lines.push(`event_id: ${event.id}`);
    lines.push(`user_id: ${event.user_id}`);
    if (event.session_id) {
      lines.push(`session_id: ${event.session_id}`);
    }
    lines.push('content:');
    lines.push(fenceUntrusted(event.content));
    if (event.tool_name) {
      lines.push(`tool_name: ${event.tool_name}`);
    }
    if (event.mcp_servers && event.mcp_servers.length > 0) {
      lines.push(`mcp_connectors_used: ${event.mcp_servers.join(', ')}`);
    }
    if (event.user_typed_skills && event.user_typed_skills.length > 0) {
      lines.push(`user_typed_skills_invoked: ${event.user_typed_skills.join(', ')}`);
    }
    if (event.agent_chained_skills && event.agent_chained_skills.length > 0) {
      lines.push(`agent_chained_skills_invoked: ${event.agent_chained_skills.join(', ')}`);
    }
    if (event.otel_tool_call_count != null) {
      lines.push(`session_tool_calls: ${event.otel_tool_call_count}`);
    }
    if (event.otel_unique_tools && event.otel_unique_tools.length > 0) {
      lines.push(`session_unique_tools: ${event.otel_unique_tools.join(', ')}`);
    }
    if (event.otel_upload_count != null && event.otel_upload_count > 0) {
      lines.push(`session_uploads: ${event.otel_upload_count}`);
    }
    lines.push(`occurred_at: ${event.occurred_at}`);
    lines.push('');
  }

  return lines.join('\n');
}
