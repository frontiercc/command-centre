// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Developer Pulse — human-readable model labels.
 *
 * Provider-decorated model IDs (Bedrock CRIS/global routing, Vertex
 * @-versions) are technically correct but unreadable in the UI —
 * `us.anthropic.claude-opus-4-6-v1` means nothing to most readers. This
 * turns any shape Claude Code reports into a short label plus which
 * provider routed the call.
 *
 * `estimated` = true whenever provider decoration was detected and stripped
 * (provider !== 'anthropic') — it flags "this call was routed through a
 * third-party provider, read its cost with that in mind", independent of
 * whether an admin happens to have priced that exact decorated ID in
 * code_model_rates. This is a DIFFERENT (label-level) question from
 * rates.ts's isEstimatedPricing() (used by health.ts and the org-summary
 * spend badge), which asks "did THIS SPEND NUMBER come from the
 * normalised-key pricing fallback". A Bedrock model with an admin-supplied
 * exact rate is priced exactly (isEstimatedPricing = false) but is still
 * provider-routed, so its label still carries estimated = true here.
 */
import { normalizeModelId } from '@/lib/pulse/code/model-id';

export interface ModelLabel {
  label: string;
  provider: 'anthropic' | 'bedrock' | 'vertex';
  estimated: boolean;
}

/** Capitalise a family token, e.g. "opus" -> "Opus", "fable" -> "Fable". */
function capitalise(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/**
 * Detect which provider decorated the raw model string. Checked against the
 * ORIGINAL (undecorated) string, before normalizeModelId strips the markers.
 */
function detectProvider(model: string): 'anthropic' | 'bedrock' | 'vertex' {
  if (/@[^/]+$/.test(model)) return 'vertex';
  if (/^(global|us|eu|jp|apac|us-gov)\.anthropic\./.test(model) || /^anthropic\./.test(model) || /-v\d+(:\d+)?$/.test(model)) {
    return 'bedrock';
  }
  return 'anthropic';
}

/**
 * Humanise a canonical (already-normalised) model ID:
 *   claude-opus-4-6              -> Claude Opus 4.6
 *   claude-haiku-4-5-20251001    -> Claude Haiku 4.5   (date suffix dropped)
 * Returns null for shapes that don't match the expected claude-family-N-M pattern
 * — callers fall back to the raw string.
 */
function humaniseCanonical(canonical: string): string | null {
  // Minor version is one or two digits, so a date suffix (claude-sonnet-5-20260101) is never read as one.
  const match = canonical.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i);
  if (!match) return null;
  const [, family, major, minor] = match;
  const version = minor !== undefined ? `${major}.${minor}` : major;
  return `Claude ${capitalise(family)} ${version}`;
}

/**
 * Format any Claude Code model ID shape into a pretty label, which provider
 * routed it, and whether that routing means the label/spend should be read
 * as an estimate.
 *
 * Unknown shapes (no recognisable claude-family-version pattern once
 * decoration is stripped) fall back to the raw string, provider 'anthropic',
 * estimated false — never guess a label that might be wrong.
 */
export function formatModelLabel(model: string): ModelLabel {
  if (!model) {
    return { label: model, provider: 'anthropic', estimated: false };
  }

  const canonical = normalizeModelId(model);
  const humanised = humaniseCanonical(canonical);

  if (humanised === null) {
    return { label: model, provider: 'anthropic', estimated: false };
  }

  const provider = detectProvider(model);
  return {
    label: humanised,
    provider,
    estimated: provider !== 'anthropic',
  };
}
