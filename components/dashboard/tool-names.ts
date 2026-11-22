// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Skill and connector names as a reader sees them. Client-safe, no imports.
 *  - custom_skill (Claude Code's name for a person's own skill when tool details are off)
 *    reads "own skill (name not sent)".
 *  - A namespaced skill, "anthropic-skills:docx", reads "anthropic-skills · docx".
 *  - A connector loses its mcp__ and claude_ai_ prefixes and its underscores:
 *    "claude_ai_Google_Slides" reads "Google Slides", "Claude_Docs" reads "Claude Docs".
 */
export function skillLabel(name: string): string {
  if (name === 'custom_skill') return 'own skill (name not sent)';
  return name.replace(':', ' · ');
}

export function connectorLabel(name: string): string {
  const plain = name.replace(/^mcp__/, '').replace(/^claude_ai_/i, '').replace(/_/g, ' ').trim();
  return plain || name;
}
