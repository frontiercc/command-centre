// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Display labels for the Code classifier's kinds of work (client-safe). The stored
// `work_type` names never change, so history and the rubric keep working; only what
// people read changes. Each label restates the rubric's own definition, which is shown
// beside it, to be accurate. A kind an admin adds in the rubric, or a
// default whose definition an admin has rewritten, shows its own name instead, since a
// fixed label could no longer be trusted to match what the classifier was told.
import { DEFAULT_CODE_CLASSIFIER_CONFIG } from '@/lib/pulse/code/classifier-prompt';

const LABELS: Record<string, string> = {
  feature: 'New functionality',
  bugfix: 'Fixing defects',
  refactor: 'Restructuring code',
  testing: 'Writing or fixing tests',
  documentation: 'Docs and comments',
  infrastructure: 'Build, deploy and tooling',
  exploration: 'Understanding and reviewing code',
  other: 'Non-coding tasks (documents, research, admin)',
};

/** Kinds of work set by a rule rather than the classifier, so no rubric can rewrite them. */
const RULE_LABELS: Record<string, { label: string; definition: string }> = {
  automated: {
    label: 'Automated runs',
    definition: 'sessions started by a script or test harness: one prompt each, ten or more from the same person within an hour',
  },
};

const DEFAULT_DEFINITIONS = new Map(DEFAULT_CODE_CLASSIFIER_CONFIG.workTypes.map(w => [w.name, w.description]));
/** Earlier default wordings: a rubric saved unchanged before a default was reworded keeps its label. */
const EARLIER_DEFAULTS: Record<string, string[]> = {
  other: ['anything that does not fit the above'],
};
const isDefault = (name: string, definition: string) =>
  definition === DEFAULT_DEFINITIONS.get(name) || (EARLIER_DEFAULTS[name] ?? []).includes(definition);

function titleCase(name: string): string {
  return name.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/** The label for a Code kind of work. Pass the rubric's configured definition when it is to hand. */
/** A definition as shown to people: dashes become commas. The stored text is left as it is
 *  because codeWorkTypeLabel compares it with the default to spot an admin's rewrite. */
export function displayDefinition(definition: string): string {
  return definition.replace(/\s*[—–]\s*/g, ', ');
}

export function codeWorkTypeLabel(name: string, configuredDefinition?: string | null): string {
  if (RULE_LABELS[name]) return RULE_LABELS[name].label;
  const label = LABELS[name];
  if (!label) return titleCase(name);
  if (configuredDefinition != null && !isDefault(name, configuredDefinition)) return titleCase(name);
  return label;
}

/** What the classifier was told the kind covers: the configured definition, else the default one. */
export function codeWorkTypeDefinition(name: string, configuredDefinition?: string | null): string | null {
  if (RULE_LABELS[name]) return RULE_LABELS[name].definition;
  return configuredDefinition ?? DEFAULT_DEFINITIONS.get(name) ?? null;
}
