// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { getConfigValue } from '@/lib/config';
import { UNTRUSTED_TEXT_RULE } from '@/lib/anthropic/untrusted';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TierDefinition {
  name: string;
  description: string;
}

export interface TaskTypeDef {
  name: string;
  description: string;
}

export interface TierConfig {
  tiers: {
    tier1: TierDefinition;
    tier2: TierDefinition;
    tier3: TierDefinition;
  };
  taxonomy: {
    tier1: TaskTypeDef[];
    tier2: TaskTypeDef[];
    tier3: TaskTypeDef[];
  };
  frontierPushCriteria: string;
  capabilityCreationCriteria: string;
  confidenceThreshold: number;
}

// ─── Defaults (mirror the original hardcoded prompt) ─────────────────────────

export const DEFAULT_TIER_CONFIG: TierConfig = {
  tiers: {
    tier1: {
      name: 'Administrative',
      description:
        'Single-step, low consequence. Formatting, summarising, basic ' +
        'drafting, data transcription. Fully reversible. No connector or ' +
        'skill use. The human reviews the output before any use.',
    },
    tier2: {
      name: 'Meaningful',
      description:
        'Multi-step or connector-assisted work of moderate consequence. ' +
        'Research synthesis, structured reports, analysis requiring contextual ' +
        'judgement, OR sessions where an external connector (MCP tool) or ' +
        'specialised skill was invoked. Connector or skill use is objective ' +
        'evidence that the work extended beyond what the person could do in ' +
        'Claude alone. Reversible with effort. The human applies judgement to ' +
        'the AI output before delivery.',
    },
    tier3: {
      name: 'Frontier',
      description:
        'Work that required orchestrating connectors across systems, invoking ' +
        'a specialised skill, or producing outputs that replace what previously ' +
        'required an external resource or specialist, combined with genuine ' +
        'reasoning complexity. Single-step connector or skill use alone is not ' +
        'sufficient for Tier 3; the work must involve coordination, multi-step ' +
        'reasoning, structural novelty, or autonomous execution. Partially ' +
        'irreversible or externally visible. The human sets parameters; the AI ' +
        'executes and delivers.',
    },
  },
  // No tool labels (connector_assisted, skill_assisted, connector_orchestration,
  // skill_invocation): they named the tool, not the work, and
  // made up ~54% of one hub's Work Mix. Connector and skill use stays tier
  // evidence (CONNECTOR AND SKILL EVIDENCE in the prompt) and is measured
  // directly from telemetry. Historic rows keep them; MECHANISM_TASK_TYPES
  // (lib/finance/model-efficiency.ts) still sets them aside when read.
  taxonomy: {
    tier1: [
      { name: 'summarisation',  description: 'summarising a document, meeting, or thread' },
      { name: 'formatting',     description: 'reformatting, cleaning, restructuring text' },
      { name: 'transcription',  description: 'moving content from one place to another' },
      { name: 'basic_drafting', description: 'short single-purpose drafts (acknowledgements, replies)' },
    ],
    tier2: [
      { name: 'synthesis',           description: 'combining multiple sources into one output' },
      { name: 'structured_report',   description: 'multi-section reports requiring judgement' },
      { name: 'analysis',            description: 'analytical work with interpretation' },
      { name: 'template_population', description: 'filling structured templates with reasoning' },
      { name: 'research_brief',      description: 'researched briefings combining several sources' },
    ],
    tier3: [
      { name: 'autonomous_workflow',    description: 'overnight or multi-step process running unsupervised' },
      { name: 'multi_file_operation',   description: 'work across many documents in one run' },
      { name: 'process_substitution',   description: 'work that previously went to an external resource' },
      { name: 'capability_creation',    description: 'work the team has never produced before' },
    ],
  },
  frontierPushCriteria:
    'Mark frontier_push_candidate = true if THIS event is the first time the ' +
    "user has produced work at this tier OR the first time the user has used " +
    "this task type. You will be told the user's history below. Do not invent history.",
  capabilityCreationCriteria:
    'Mark capability_creation_candidate = true only when ALL three apply:\n' +
    '  1. The task type is at Tier 2 or Tier 3\n' +
    '  2. The work appears to be of a kind the team has not produced before,\n' +
    '     OR the work has no documented baseline equivalent\n' +
    '  3. The output is consequential: externally visible, decision-supporting,\n' +
    '     or structurally novel for the function\n\n' +
    'Do not mark capability creation simply because the work is new to this\n' +
    'user. The framework is specific: capability creation means new to the ORGANISATION.',
  confidenceThreshold: 0.7,
};

// ─── Reader ───────────────────────────────────────────────────────────────────

export async function getTierConfig(): Promise<TierConfig> {
  try {
    const raw = await getConfigValue('pulseClassifierConfig');
    if (!raw) return { ...DEFAULT_TIER_CONFIG };
    return JSON.parse(raw) as TierConfig;
  } catch {
    return { ...DEFAULT_TIER_CONFIG };
  }
}

// ─── Prompt builder ───────────────────────────────────────────────────────────
//
// Kept a pure/sync string-builder — `config` is now a
// REQUIRED argument instead of internally falling back to `getTierConfig()`
// (which is async since it reads the config table). Every real caller
// already had (or can trivially fetch) a resolved TierConfig, so callers now
// `await getTierConfig()` themselves before calling this — no caller relied
// on the implicit default in a context where a `getTierConfig()` fetch
// wasn't already available.

export function buildClassifierSystemMessage(config: TierConfig): string {
  const c = config;

  const { tier1, tier2, tier3 } = c.tiers;
  const t = c.taxonomy;

  const taxonomyLines = (defs: TaskTypeDef[]) =>
    defs.map(d => `  ${(d.name + ':').padEnd(23)} ${d.description}`).join('\n');

  return `You are a classification engine for the Cowork Operating System framework.

For each Cowork task event provided, output one classification with:
- tier: integer 1, 2, or 3
- task_type: one of the labels in the taxonomy below
- frontier_push_candidate: boolean
- capability_creation_candidate: boolean
- confidence: float 0.0 to 1.0

THE TIER RUBRIC

Tier 1 (${tier1.name}): ${tier1.description}

Tier 2 (${tier2.name}): ${tier2.description}

Tier 3 (${tier3.name}): ${tier3.description}

CONNECTOR AND SKILL EVIDENCE

Each event may include mcp_connectors_used (a list of external MCP tools invoked
in the session) and skills_invoked (a list of specialised skills used). Treat
these as structural evidence when assigning tiers. They are objective signals
captured from the session, not inferred from message content.

- Any connector or skill use is qualifying evidence for Tier 2 or above.
  A session with connector or skill use should not be classified as Tier 1
  unless the message content is unambiguously trivial regardless.
- Connector orchestration (multiple connectors, or a connector used across
  multi-step reasoning) combined with genuine complexity is qualifying
  evidence for Tier 3.
- Skill invocation as a load-bearing part of complex work is qualifying
  evidence for Tier 3.
- If connectors or skills were used but the work is simple or single-step,
  classify as Tier 2.

THE TASK TYPE TAXONOMY

The task_type names the WORK the person asked for, never the tool used to
do it: connectors and skills are tier evidence (above), not a kind of work.
Task types are grouped by the tier they most often occur at, but the group
is only a guide. Decide the tier from the tier rules and evidence above,
then choose the task type that best names the work, from any group.

Tier 1 task types:
${taxonomyLines(t.tier1)}

Tier 2 task types:
${taxonomyLines(t.tier2)}

Tier 3 task types:
${taxonomyLines(t.tier3)}

FRONTIER PUSH

${c.frontierPushCriteria}

CAPABILITY CREATION

${c.capabilityCreationCriteria}

CONFIDENCE

Set confidence below ${c.confidenceThreshold} if the event is ambiguous between tiers, if the
context is too thin to judge, or if the task type does not cleanly map to
the taxonomy.

${UNTRUSTED_TEXT_RULE} Each event's content is fenced this way.

OUTPUT FORMAT

Return ONLY a JSON array. One object per event. No prose, no explanation,
no markdown fences.

[
  {
    "event_id": "<string matching the input id>",
    "tier": <1, 2, or 3>,
    "task_type": "<one of the taxonomy labels>",
    "frontier_push_candidate": <boolean>,
    "capability_creation_candidate": <boolean>,
    "confidence": <float 0.0 to 1.0>
  },
  ...
]`;
}
