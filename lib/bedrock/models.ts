// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Claude models through Amazon Bedrock, and Amazon's name for each. Pure (no
// config or network), so the settings page can import the list.
//
// Model settings keep Anthropic's ids ('claude-haiku-5-5'). Amazon serves
// Claude through cross-region inference profiles named for the geography of
// the region the call is made in: 'eu.anthropic.claude-haiku-5-5' from an EU
// region, 'us.' from a US one, 'apac.' from Asia Pacific, 'global.' elsewhere.
// A few older models carry a version suffix in Amazon's catalogue.

/** The Claude models offered in the model pickers when the hub uses Bedrock. */
export const BEDROCK_CLAUDE_MODELS: { id: string; display_name: string }[] = [
  { id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5' },
  { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' },
  { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' },
  { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' },
  { id: 'claude-opus-5', display_name: 'Claude Opus 5' },
  { id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5' },
];

/** Amazon's catalogue name where it is not simply 'anthropic.' + the id. */
const CATALOGUE_NAMES: Record<string, string> = {
  'claude-haiku-4-5': 'anthropic.claude-haiku-4-5-20251001-v1:0',
  'claude-haiku-4-5-20251001': 'anthropic.claude-haiku-4-5-20251001-v1:0',
  'claude-sonnet-4-5': 'anthropic.claude-sonnet-4-5-20250929-v1:0',
  'claude-sonnet-4-5-20250929': 'anthropic.claude-sonnet-4-5-20250929-v1:0',
  'claude-opus-4-5': 'anthropic.claude-opus-4-5-20251101-v1:0',
  'claude-opus-4-5-20251101': 'anthropic.claude-opus-4-5-20251101-v1:0',
  'claude-opus-4-6': 'anthropic.claude-opus-4-6-v1',
};

/** The inference-profile geography for an AWS region. */
export function bedrockGeography(region: string): 'eu' | 'us' | 'apac' | 'global' {
  const r = region.trim().toLowerCase();
  if (r.startsWith('eu-')) return 'eu';
  if (r.startsWith('us-')) return 'us';
  if (r.startsWith('ap-')) return 'apac';
  return 'global';
}

/**
 * Amazon's name for a model called from a region: 'claude-haiku-5-5' from
 * eu-west-2 is 'eu.anthropic.claude-haiku-5-5'. A name that is already
 * Amazon's (it contains 'anthropic.') or an ARN is used as it is.
 */
export function bedrockModelId(model: string, region: string): string {
  const m = model.trim();
  if (m.includes('anthropic.') || m.startsWith('arn:')) return m;
  return `${bedrockGeography(region)}.${CATALOGUE_NAMES[m] ?? `anthropic.${m}`}`;
}
