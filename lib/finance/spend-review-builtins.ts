// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Claude's own connectors and skills, never offered as a Spend Review "better
// route": they ship with Claude, so "colleagues use it and you don't" is not
// advice anyone can act on. Observed in telemetry
// (the Cowork and Claude Code desktop apps' internal MCP servers, and Claude
// Code's bundled skills). Real connectors (Google Drive, Slack, Gmail,
// Salesforce, Chrome, Playwright...) and org or plugin skills stay eligible.
// Extend when a new built-in shows up as a route.

/** Claude's own connectors (MCP servers), as telemetry names them. */
export const BUILT_IN_CONNECTOR_NAMES: readonly string[] = [
  'workspace', 'cowork', 'remote-devices', 'dynamic', 'memory', 'session_info',
  'widgets', 'scheduled-tasks', 'claude-code-remote', 'ccd_session', 'ccd_session_mgmt',
  'ccd_view', 'ccd_directory', 'ccd_connectors', 'ccd_sidebar', 'ccd_window', 'ccd_pr', 'ccd_host',
  'mcp-registry', 'visualize', 'terminal', 'claude browser', 'claude_browser',
];

/** Claude's own skills (Claude Code's bundled skills), as telemetry names them. Also hidden from the S&C Board. */
export const BUILT_IN_SKILL_NAMES: readonly string[] = [
  'run', 'init', 'update-config', 'keybindings-help', 'simplify', 'code-review',
  'security-review', 'fewer-permission-prompts', 'loop', 'schedule', 'claude-api',
  'artifact-design', 'artifact-capabilities', 'artifact-diagramming', 'dataviz',
  'workflow-authoring', 'custom_skill', 'verify',
];

/** Case, spaces and underscores ignored: telemetry spells the same server several ways. */
export function normToolName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

const CONNECTORS = new Set(BUILT_IN_CONNECTOR_NAMES.map(normToolName));
const SKILLS = new Set(BUILT_IN_SKILL_NAMES.map(normToolName));

export function isBuiltInTool(type: 'skill' | 'connector', name: string): boolean {
  const n = normToolName(name);
  // Every ccd_ server is the Claude desktop app's own (ccd_turn, ccd_session_mgmt and the rest).
  if (type === 'connector' && n.startsWith('ccd-')) return true;
  return (type === 'skill' ? SKILLS : CONNECTORS).has(n);
}
