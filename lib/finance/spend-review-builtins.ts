// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Claude's own connectors and skills, never offered as a Spend Review "better
// route": they ship with Claude, so "colleagues use it and you don't" is not
// advice anyone can act on. Observed in telemetry
// (the Cowork and Claude Code desktop apps' internal MCP servers, and Claude
// Code's bundled skills). Real connectors (Google Drive, Slack, Gmail,
// Salesforce, Chrome, Playwright...) and org or plugin skills stay eligible.
// Extend when a new built-in shows up as a route.

const BUILT_IN_CONNECTORS = [
  'workspace', 'cowork', 'remote-devices', 'dynamic', 'memory', 'session_info',
  'widgets', 'scheduled-tasks', 'claude-code-remote', 'ccd_session', 'ccd_session_mgmt',
  'ccd_view', 'ccd_directory', 'ccd_connectors', 'ccd_sidebar', 'ccd_window', 'ccd_pr', 'ccd_host',
  'mcp-registry', 'visualize', 'terminal', 'claude browser', 'claude_browser',
];

const BUILT_IN_SKILLS = [
  'run', 'init', 'update-config', 'keybindings-help', 'simplify', 'code-review',
  'security-review', 'fewer-permission-prompts', 'loop', 'schedule', 'claude-api',
  'artifact-design', 'artifact-capabilities', 'artifact-diagramming', 'dataviz',
  'workflow-authoring', 'custom_skill',
];

/** Case, spaces and underscores ignored: telemetry spells the same server several ways. */
function norm(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

const CONNECTORS = new Set(BUILT_IN_CONNECTORS.map(norm));
const SKILLS = new Set(BUILT_IN_SKILLS.map(norm));

export function isBuiltInTool(type: 'skill' | 'connector', name: string): boolean {
  return (type === 'skill' ? SKILLS : CONNECTORS).has(norm(name));
}
