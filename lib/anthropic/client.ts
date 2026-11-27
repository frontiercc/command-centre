// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The ONLY place the app constructs an Anthropic client. The SDK's default
// request timeout is 10 minutes, and the scheduler runs its jobs one after
// another, so a single hung call would stall every job behind it. Every client
// therefore gets a bounded timeout. The SDK retries a timed-out request (twice
// by default), so the worst case is roughly three times the limit.
// test/anthropic-client-timeout.test.ts fails on any `new Anthropic(` elsewhere.
//
// Claude is reached through the Anthropic API or, when an admin chooses it,
// Amazon Bedrock (lib/bedrock/). Callers read getClaudeCredential()
// (lib/anthropic/credential.ts) and pass it here; they never need to know
// which one is in use.
import Anthropic from '@anthropic-ai/sdk';
import { createBedrockClient } from '@/lib/bedrock/client';
import { decodeBedrockCredential } from '@/lib/bedrock/settings';

/** Default per-request limit: generous for every short call the app makes. */
export const AI_CALL_TIMEOUT_MS = 180_000;
/** For the few calls that ask for very long output (governance report, skill draft). */
export const LONG_AI_CALL_TIMEOUT_MS = 300_000;

export function createAnthropicClient(credential: string, opts: { timeoutMs?: number } = {}): Anthropic {
  const timeout = opts.timeoutMs ?? AI_CALL_TIMEOUT_MS;
  const bedrock = decodeBedrockCredential(credential);
  if (bedrock) return createBedrockClient(bedrock, timeout);
  return new Anthropic({ apiKey: credential, timeout });
}
