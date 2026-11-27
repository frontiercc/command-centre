// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// What every Claude caller reads and passes to createAnthropicClient(): the
// Anthropic API key or, when an admin chooses Amazon Bedrock, the Bedrock
// settings (lib/bedrock/settings.ts). Empty when Claude is not set up, and
// callers skip their work as they always have. Kept apart from
// lib/anthropic/client.ts so a test that stands in for the client still reads
// the real setting.
import { getConfigValue } from '@/lib/config';
import { encodeBedrockCredential, isBedrockProvider } from '@/lib/bedrock/settings';

export async function getClaudeCredential(): Promise<string> {
  if (isBedrockProvider(await getConfigValue('aiProvider'))) {
    const region = String((await getConfigValue('bedrockRegion')) ?? '').trim();
    const apiKey = String((await getConfigValue('bedrockApiKey')) ?? '').trim();
    // Bedrock is set up only with both saved; otherwise Claude is not set up
    // and nothing calls Amazon.
    return region && apiKey ? encodeBedrockCredential({ region, apiKey }) : '';
  }
  return getConfigValue('anthropicAiApiKey');
}
