// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Behavioural intent detection types.
 *
 * Intent detection is Layer 2 in the detection pipeline:
 * Layer 1 — PII regex (existing, lib/pii/detect.ts)
 * Layer 2 — Intent pattern matching (this module, deterministic, free)
 * Layer 3 — Haiku AI assessment (lib/intent/assess.ts, only for flagged messages)
 */

export interface IntentCategory {
  id: string;
  name: string;
  description: string;
  phrases: string[];
  /** Default severity hint passed to Haiku for context */
  defaultSeverity: 'low' | 'medium' | 'high' | 'critical';
  /** Whether this is a built-in category (cannot be deleted, only toggled) */
  builtIn: boolean;
  enabled: boolean;
}

export interface IntentMatch {
  categoryId: string;
  categoryName: string;
  matchedPhrases: string[];
  defaultSeverity: 'low' | 'medium' | 'high' | 'critical';
}

export interface IntentAssessment {
  severity: 'low' | 'medium' | 'high' | 'critical';
  reasoning: string;
  recommendedAction: string;
}

export interface IntentResult {
  matches: IntentMatch[];
  assessment?: IntentAssessment;
}
