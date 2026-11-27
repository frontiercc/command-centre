// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The connection test behind the Test button: one short call with a model,
// reporting in plain words what failed. Used by app/api/config/test.
import Anthropic from '@anthropic-ai/sdk';
import { createBedrockClient } from '@/lib/bedrock/client';
import { bedrockModelId } from '@/lib/bedrock/models';
import type { BedrockSettings } from '@/lib/bedrock/settings';
import { logError } from '@/lib/api/errors';

export async function testBedrockConnection(settings: BedrockSettings, model: string): Promise<{ ok: boolean; message: string }> {
  const region = settings.region.trim();
  if (!region) return { ok: false, message: 'Enter the AWS region.' };
  if (!settings.apiKey.trim()) return { ok: false, message: 'Enter a Bedrock API key.' };
  const amazonName = bedrockModelId(model, region);
  try {
    await createBedrockClient(settings, 30_000).messages.create({
      model, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with OK.' }],
    });
    return { ok: true, message: `Connected. Claude answered in ${region} (${amazonName}).` };
  } catch (err) {
    logError('bedrock/test', err);
    if (err instanceof Anthropic.APIError && err.status) {
      if (err.status === 401 || err.status === 403) {
        return { ok: false, message: 'Amazon refused the key. It may be wrong, expired or for another region.' };
      }
      if (err.status === 400 || err.status === 404) {
        return { ok: false, message: `Amazon has no ${amazonName} for this account in ${region}. Check Claude is switched on in the Bedrock console.` };
      }
      return { ok: false, message: `Amazon did not accept the request (status ${err.status}).` };
    }
    return { ok: false, message: `Could not reach Amazon Bedrock in ${region}.` };
  }
}
