// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The Claude client for Amazon Bedrock. Built only by createAnthropicClient()
// (lib/anthropic/client.ts), so every caller keeps one entry point.
//
// Signs in only with the Bedrock API key saved on Admin → Access & Keys. It
// never looks for any other AWS sign-in on the machine (roles, stored
// credentials, environment variables), so the key in the box is always the
// one in use. Callers pass Anthropic model ids; the client sends Amazon's name
// for the model in the configured region (lib/bedrock/models.ts).
import type Anthropic from '@anthropic-ai/sdk';
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import { bedrockModelId } from '@/lib/bedrock/models';
import type { BedrockSettings } from '@/lib/bedrock/settings';

export class MissingBedrockSettingsError extends Error {
  constructor() {
    super('The AWS region and Bedrock API key must both be saved.');
    this.name = 'MissingBedrockSettingsError';
  }
}

export function createBedrockClient(settings: BedrockSettings, timeoutMs: number): Anthropic {
  const apiKey = settings.apiKey.trim();
  const region = settings.region.trim();
  if (!apiKey || !region) throw new MissingBedrockSettingsError();
  const client = new AnthropicBedrock({ awsRegion: region, apiKey, timeout: timeoutMs });
  const create = client.messages.create.bind(client.messages);
  client.messages.create = ((body: Anthropic.MessageCreateParams, options?: Anthropic.RequestOptions) =>
    create({ ...body, model: bedrockModelId(body.model, region) } as Anthropic.MessageCreateParams, options)) as typeof client.messages.create;
  return client as unknown as Anthropic;
}
