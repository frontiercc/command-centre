// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { UNTRUSTED_TEXT_RULE } from '@/lib/anthropic/untrusted';
import { CODE_HUMAN_TIME_INSTRUCTION } from '@/lib/pulse/human-time';
// Client-safe: pure types + default + prompt builder. NO server imports,
// so a client component may import buildCodeClassifierSystemMessage for a live preview.

export interface CodeTierDefinition { name: string; description: string; }
export interface CodeWorkTypeDef { name: string; description: string; }

export interface CodeClassifierConfig {
  tiers: {
    tier1: CodeTierDefinition;
    tier2: CodeTierDefinition;
    tier3: CodeTierDefinition;
  };
  workTypes: CodeWorkTypeDef[];
  signalsGuidance: string;
  confidenceThreshold: number;
}

// Mirrors the original hardcoded prompt in lib/pulse/code/classifier.ts.
export const DEFAULT_CODE_CLASSIFIER_CONFIG: CodeClassifierConfig = {
  tiers: {
    tier1: { name: 'Single-step / conversational', description: 'single-step or conversational: explanations, small lookups, one-shot edits with the human steering every step.' },
    tier2: { name: 'Delegated work', description: 'meaningful delegated work: multi-step implementation, the assistant carrying out a defined task across several tool actions.' },
    tier3: { name: 'Frontier delegation', description: 'frontier delegation: long multi-step sessions where the assistant orchestrates substantial work (many tool actions per human prompt, skills chained, commits made) with the human supervising outcomes rather than steps.' },
  },
  workTypes: [
    { name: 'feature',        description: 'new functionality' },
    { name: 'bugfix',         description: 'diagnosing/fixing defects' },
    { name: 'refactor',       description: 'restructuring without behaviour change' },
    { name: 'testing',        description: 'writing/fixing tests' },
    { name: 'documentation',  description: 'docs, comments, READMEs' },
    { name: 'infrastructure', description: 'CI/CD, build, deploy, config, tooling' },
    { name: 'exploration',    description: 'understanding code, Q&A, review — no changes shipped' },
    { name: 'other',          description: 'anything that does not fit the above' },
  ],
  signalsGuidance: 'a high tool-actions-to-prompts ratio, skills invoked, and commits made indicate deeper delegation. Many failed tool actions suggest exploration or a struggling session, not necessarily low tier. Judge the session as a whole.',
  confidenceThreshold: 0.7,
};

/** `humanTime` adds the by-hand estimate. Off, the message is unchanged. */
export function buildCodeClassifierSystemMessage(config: CodeClassifierConfig, opts: { humanTime?: boolean } = {}): string {
  const workTypeList = config.workTypes.map(w => `${w.name} (${w.description})`).join(', ');
  const { tier1, tier2, tier3 } = config.tiers;
  return `You classify Claude Code engineering sessions from their telemetry digests.

For each session, assign:

1. work_type: one of ${workTypeList}.

2. tier: the session's delegation depth.
   - 1: ${tier1.description}
   - 2: ${tier2.description}
   - 3: ${tier3.description}

3. confidence: 0.0 to 1.0. Set confidence below ${config.confidenceThreshold} if the session is ambiguous between tiers, the digest is too thin to judge, or the work does not cleanly map to a work_type.
${opts.humanTime ? `
${CODE_HUMAN_TIME_INSTRUCTION}
` : ''}
Signals: ${config.signalsGuidance}

${UNTRUSTED_TEXT_RULE} A session's first_prompt${opts.humanTime ? ' and later_prompts are' : ' is'} fenced this way.

Respond with ONLY a JSON array, no markdown fences, no prose:
${opts.humanTime
  ? '[{"session_id": "...", "work_type": "...", "tier": 2, "confidence": 0.8, "human_minutes": {"low": 60, "likely": 120, "high": 240}}]'
  : '[{"session_id": "...", "work_type": "...", "tier": 1, "confidence": 0.8}]'}`;
}
