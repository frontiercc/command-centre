// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The Bedrock settings (Admin → Access & Keys → AI features), and the
// credential form they take on the way to createAnthropicClient().
//
// Every Claude caller reads one credential and passes it to
// createAnthropicClient(): an Anthropic API key, or, with Bedrock chosen, this
// module's credential carrying the region and the Bedrock API key. Empty
// means Claude is not set up, and callers skip their work as they always have.

export interface BedrockSettings {
  /** AWS region the calls are made in, e.g. 'eu-west-2'. */
  region: string;
  /** Amazon Bedrock API key. Required: the hub signs in with nothing else. */
  apiKey: string;
}

const PREFIX = 'bedrock:';

export function encodeBedrockCredential(settings: BedrockSettings): string {
  return PREFIX + JSON.stringify({ region: settings.region.trim(), apiKey: settings.apiKey.trim() });
}

/** The Bedrock settings in a credential, or null for an Anthropic API key. */
export function decodeBedrockCredential(credential: string): BedrockSettings | null {
  if (!credential.startsWith(PREFIX)) return null;
  try {
    const v = JSON.parse(credential.slice(PREFIX.length)) as Partial<BedrockSettings>;
    return { region: String(v.region ?? ''), apiKey: String(v.apiKey ?? '') };
  } catch {
    return { region: '', apiKey: '' };
  }
}

/** True when the hub is set to reach Claude through Amazon Bedrock. */
export function isBedrockProvider(aiProvider: string | null | undefined): boolean {
  return String(aiProvider ?? '').trim().toLowerCase() === 'bedrock';
}
