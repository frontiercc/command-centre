// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Developer Pulse — pure model-ID string helpers.
 *
 * Deliberately has ZERO imports (no @/lib/config, no DB). rates.ts pulls in
 * getConfigValue and the DB layer for pricing, which is fine for server-only route
 * code but breaks client bundling the moment a 'use client' component
 * (e.g. ModelMixBar) needs just the ID-normalisation logic — webpack then
 * tries to bundle the DB driver/fs into the browser chunk and the Next.js
 * build fails ("Module not found: Can't resolve 'fs'"). Keeping this
 * string-only logic in its own leaf module lets client components (via
 * model-label.ts) depend on it without dragging in the DB layer.
 */

/**
 * Normalise a provider-decorated model ID to a canonical rate-table key.
 *
 * Claude Code routed through Amazon Bedrock (or Google Vertex) reports model
 * IDs carrying routing/provider decoration the rate table doesn't use, e.g.
 *   us.anthropic.claude-opus-4-6-v1            (Bedrock CRIS / regional)
 *   global.anthropic.claude-sonnet-4-6         (Bedrock global endpoint)
 *   anthropic.claude-haiku-4-5-20251001-v1:0   (Bedrock base + version suffix)
 *   claude-sonnet-4-5@20250929                 (Vertex @-version)
 * This strips the CRIS/global region prefix, the `anthropic.` provider prefix,
 * and the trailing `-v1`/`-v1:0`/`@…` version suffix so the result lines up
 * with DEFAULT_RATES keys (`claude-opus-4-6`, `claude-haiku-4-5-20251001`, …).
 * Returns the input unchanged when there is nothing to strip.
 *
 * IMPORTANT: this maps a Bedrock/Vertex model onto the Anthropic *list* rate —
 * an estimate. AWS Bedrock pricing differs from Anthropic API pricing, and
 * regional (CRIS) endpoints add a ~10% premium over global. Admins who need
 * exact provider cost add the full provider model ID to `code_model_rates`;
 * priceTokens() tries the exact key first, so that entry wins over this
 * normalisation. Surface Bedrock-derived spend as an estimate in the UI.
 */
export function normalizeModelId(model: string): string {
  return model
    .trim()
    .replace(/^(global|us|eu|jp|apac|us-gov)\./, '') // Bedrock CRIS / global routing prefix
    .replace(/^anthropic\./, '')                      // Bedrock provider prefix
    .replace(/-v\d+(:\d+)?$/, '')                      // Bedrock version suffix (-v1, -v1:0)
    .replace(/@.+$/, '');                              // Vertex @-version (e.g. @20250929)
}
