// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Claude through Amazon Bedrock (lib/bedrock/): Amazon's model names per
// region, the credential createAnthropicClient() receives, and that the client
// sends Amazon's name with the same bounded timeout as every other client.
import { describe, it, expect } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import { bedrockGeography, bedrockModelId, BEDROCK_CLAUDE_MODELS } from '@/lib/bedrock/models';
import { decodeBedrockCredential, encodeBedrockCredential, isBedrockProvider } from '@/lib/bedrock/settings';
import { createAnthropicClient, AI_CALL_TIMEOUT_MS, LONG_AI_CALL_TIMEOUT_MS } from '@/lib/anthropic/client';
import { MissingBedrockSettingsError } from '@/lib/bedrock/client';

describe('Amazon Bedrock service', () => {
  it('names each model the way Amazon serves it from the region', () => {
    expect(bedrockModelId('claude-haiku-5-5', 'eu-west-2')).toBe('eu.anthropic.claude-haiku-5-5');
    expect(bedrockModelId('claude-sonnet-5', 'us-east-1')).toBe('us.anthropic.claude-sonnet-5');
    expect(bedrockModelId('claude-haiku-4-5-20251001', 'eu-west-1')).toBe('eu.anthropic.claude-haiku-4-5-20251001-v1:0');
    expect(bedrockModelId('claude-opus-5', 'ap-southeast-2')).toBe('apac.anthropic.claude-opus-5');
    expect(bedrockModelId('claude-opus-5', 'sa-east-1')).toBe('global.anthropic.claude-opus-5');
    expect(bedrockModelId('global.anthropic.claude-sonnet-5', 'eu-west-2')).toBe('global.anthropic.claude-sonnet-5');
    expect(bedrockGeography(' EU-CENTRAL-1 ')).toBe('eu');
  });

  it('uses the name Amazon lists for each supported region (checked against Amazon, November 2026)', () => {
    const expected: Record<string, string> = {
      'us-east-1': 'us', 'us-east-2': 'us', 'us-west-2': 'us',
      'ca-central-1': 'global', 'sa-east-1': 'global',
      'eu-west-1': 'eu', 'eu-west-2': 'eu', 'eu-west-3': 'eu', 'eu-central-1': 'eu', 'eu-north-1': 'eu',
    };
    for (const [region, geo] of Object.entries(expected)) {
      for (const m of BEDROCK_CLAUDE_MODELS) expect(bedrockModelId(m.id, region).startsWith(`${geo}.anthropic.`)).toBe(true);
    }
  });

  it('offers models under Claude names', () => {
    for (const m of BEDROCK_CLAUDE_MODELS) expect(m.id.startsWith('claude-')).toBe(true);
  });

  it('carries the region and key in the credential, and nothing for an Anthropic key', () => {
    expect(decodeBedrockCredential(encodeBedrockCredential({ region: ' eu-west-2 ', apiKey: ' key ' }))).toEqual({ region: 'eu-west-2', apiKey: 'key' });
    expect(decodeBedrockCredential('sk-ant-api03-abc')).toBeNull();
    expect(isBedrockProvider('Bedrock')).toBe(true);
    expect(isBedrockProvider(undefined)).toBe(false);
  });

  it('builds a Bedrock client with the same bounded timeouts', () => {
    const c = createAnthropicClient(encodeBedrockCredential({ region: 'eu-west-2', apiKey: 'key' }));
    expect(c).toBeInstanceOf(AnthropicBedrock);
    expect(c.timeout).toBe(AI_CALL_TIMEOUT_MS);
    expect(createAnthropicClient(encodeBedrockCredential({ region: 'eu-west-2', apiKey: 'key' }), { timeoutMs: LONG_AI_CALL_TIMEOUT_MS }).timeout).toBe(LONG_AI_CALL_TIMEOUT_MS);
  });

  it('signs in only with the saved key: no key or no region builds nothing', () => {
    expect(() => createAnthropicClient(encodeBedrockCredential({ region: 'eu-west-2', apiKey: '' }))).toThrow(MissingBedrockSettingsError);
    expect(() => createAnthropicClient(encodeBedrockCredential({ region: '', apiKey: 'key' }))).toThrow(MissingBedrockSettingsError);
    expect(createAnthropicClient('sk-test')).toBeInstanceOf(Anthropic);
  });

  it("sends Amazon's model name for the region", async () => {
    const client = createAnthropicClient(encodeBedrockCredential({ region: 'eu-west-2', apiKey: 'key' }));
    let url = '';
    (client as unknown as { fetch: typeof fetch }).fetch = (async (u: unknown) => {
      url = String(u);
      return new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    await client.messages.create({ model: 'claude-haiku-5-5', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] });
    expect(decodeURIComponent(url)).toContain('/model/eu.anthropic.claude-haiku-5-5/invoke');
  });
});
