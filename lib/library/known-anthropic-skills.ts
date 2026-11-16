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

/**
 * A short description for each Anthropic skill above that Anthropic publishes, so the S&C Board
 * shows what it does as soon as it first appears. Written from each skill's own description in
 * Anthropic's public skills repository (github.com/anthropics/skills, read 2026-11-14). A skill
 * with no published source (consolidate-memory, humanize, meeting-notes, senior-pitch-writing,
 * setup-cowork) has none, rather than a guess. Filled only where an entry has no description,
 * so an admin's own wording always wins.
 */
const ANTHROPIC_SKILL_DESCRIPTIONS: Record<string, string> = {
  docx: 'Creates, reads and edits Word documents and templates, including their formatting.',
  xlsx: 'Reads, edits, creates and converts spreadsheets, such as Excel and CSV files.',
  pptx: 'Creates, reads and edits PowerPoint decks and templates, including speaker notes.',
  pdf: 'Works with PDFs: extracts text, merges or splits files, fills forms, adds watermarks and reads scanned pages.',
  'brand-guidelines': "Applies Anthropic's brand colours and typography to documents and pages.",
  'doc-coauthoring': 'A step-by-step way to co-write documents such as proposals, specs and decision papers, refining the draft so others can follow it.',
  'internal-comms': "Writes internal communications in your company's usual formats: status reports, leadership updates, newsletters, FAQs and incident reports.",
  'skill-creator': 'Builds new skills, improves existing ones and tests them so they trigger reliably.',
  'slack-gif-creator': 'Makes animated GIFs that work well in Slack.',
  'theme-factory': 'Applies a colour and font theme to slides, documents, reports and web pages, from a preset or a new custom theme.',
};

/** The built-in description for an Anthropic skill, bare or 'anthropic-skills:' named; null when there is none. */
export function anthropicSkillDescription(skillName: string): string | null {
  const bare = skillName.startsWith('anthropic-skills:') ? skillName.slice('anthropic-skills:'.length) : skillName;
  return ANTHROPIC_SKILL_DESCRIPTIONS[bare] ?? null;
}

/** Every name, bare and 'anthropic-skills:', that has a built-in description, with it. */
export function anthropicSkillDescriptionEntries(): Array<[string, string]> {
  return Object.entries(ANTHROPIC_SKILL_DESCRIPTIONS)
    .flatMap(([name, d]): Array<[string, string]> => [[name, d], [`anthropic-skills:${name}`, d]]);
}
