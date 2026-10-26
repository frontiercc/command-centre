// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { getConfigValue } from '@/lib/config';
import { codeWorkTypeLabel } from '@/lib/pulse/code/work-type-labels';
import {
  DEFAULT_CODE_CLASSIFIER_CONFIG,
  type CodeClassifierConfig,
  type CodeTierDefinition,
} from '@/lib/pulse/code/classifier-prompt';

// Re-export the client-safe surface so existing import paths keep working.
export { DEFAULT_CODE_CLASSIFIER_CONFIG, buildCodeClassifierSystemMessage } from '@/lib/pulse/code/classifier-prompt';
export type { CodeClassifierConfig, CodeTierDefinition, CodeWorkTypeDef } from '@/lib/pulse/code/classifier-prompt';

function isValidTierDef(v: unknown): v is CodeTierDefinition {
  return !!v && typeof v === 'object' && typeof (v as { name?: unknown }).name === 'string';
}

/** Shape-guard for a parsed config blob — never trust JSON from the DB even though it round-trips through the admin route's own validation, since `code_classifier_config` is a generic `allowedKeys` entry writable via `POST /api/config`. */
function isValidCodeClassifierConfig(v: unknown): v is CodeClassifierConfig {
  if (!v || typeof v !== 'object') return false;
  const c = v as Partial<CodeClassifierConfig>;
  if (!c.tiers || typeof c.tiers !== 'object') return false;
  const { tier1, tier2, tier3 } = c.tiers as Partial<CodeClassifierConfig['tiers']>;
  if (!isValidTierDef(tier1) || !isValidTierDef(tier2) || !isValidTierDef(tier3)) return false;
  if (!Array.isArray(c.workTypes) || c.workTypes.length === 0) return false;
  return true;
}

export async function getCodeClassifierConfig(): Promise<CodeClassifierConfig> {
  try {
    const raw = await getConfigValue('codeClassifierConfig');
    if (!raw) return { ...DEFAULT_CODE_CLASSIFIER_CONFIG };
    const parsed = JSON.parse(raw) as unknown;
    if (!isValidCodeClassifierConfig(parsed)) return { ...DEFAULT_CODE_CLASSIFIER_CONFIG };
    return parsed;
  } catch {
    return { ...DEFAULT_CODE_CLASSIFIER_CONFIG };
  }
}

/** The configured definition of each Code kind of work, keyed by its stored name. Never throws. */
export async function getCodeWorkTypeDefinitions(): Promise<Map<string, string>> {
  try {
    return new Map((await getCodeClassifierConfig()).workTypes.map(w => [w.name, w.description]));
  } catch {
    return new Map();
  }
}

/** A labeller for Code kinds of work that honours the rubric as configured now (see `work-type-labels.ts`). */
export async function getCodeWorkTypeLabeller(): Promise<(name: string) => string> {
  const defs = await getCodeWorkTypeDefinitions();
  return (name: string) => codeWorkTypeLabel(name, defs.get(name));
}
