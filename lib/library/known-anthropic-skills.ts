// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Skill activations auto-register in skill_library_entries so the S&C Board
// shows real usage counts (lib/otel/{code,cowork}-receiver.ts). Every one
// lands as source='org', is_published=0 ("unclaimed") regardless of who
// actually built it — correct for genuine org-authored skills, but wrong for
// Anthropic's own bundled skills (docx, xlsx, ...), which have no real org
// owner to claim them and just sit unclaimed forever.
//
// This list is deliberately CONSERVATIVE: it only includes names distinctive
// enough that an org building its own custom skill would be very unlikely to
// reuse them. Generic names (start, run, review, init, implement,
// artifact-design, ...) are intentionally EXCLUDED even though several are
// also Anthropic-authored — auto-claiming those risks silently masking a
// genuine org-built skill that happens to share the name, which defeats the
// board's purpose of surfacing org tooling and its owners. Those stay
// manually claimable.
// Bare names — how a built-in Skill tool invocation usually self-identifies.
const BARE_NAMES = [
  // Office document generation/editing family
  'docx',
  'xlsx',
  'pptx',
  'pdf',
  // Other distinctly-named bundled Anthropic skills
  'brand-guidelines',
  'consolidate-memory',
  'doc-coauthoring',
  'humanize',
  'internal-comms',
  'meeting-notes',
  'senior-pitch-writing',
  'setup-cowork',
  'skill-creator',
  'slack-gif-creator',
  'theme-factory',
];

// The SAME skills can also self-identify with the 'anthropic-skills:' catalog
// namespace prefix (the convention migration 033 already established for the
// MCP-installable catalog) depending on invocation context — confirmed
// when 'xlsx' and 'anthropic-skills:xlsx' turned out to be two
// distinct rows for the one real skill. Cover both forms.
export const KNOWN_ANTHROPIC_SKILLS = new Set([
  ...BARE_NAMES,
  ...BARE_NAMES.map((name) => `anthropic-skills:${name}`),
]);

export function isKnownAnthropicSkill(skillName: string): boolean {
  return KNOWN_ANTHROPIC_SKILLS.has(skillName);
}
