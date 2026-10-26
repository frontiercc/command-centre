// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The ONLY place the app constructs an Anthropic client. The SDK's default
// request timeout is 10 minutes, and the scheduler runs its jobs one after
// another, so a single hung call would stall every job behind it. Every client
// therefore gets a bounded timeout. The SDK retries a timed-out request (twice
// by default), so the worst case is roughly three times the limit.
// test/anthropic-client-timeout.test.ts fails on any `new Anthropic(` elsewhere.
import Anthropic from '@anthropic-ai/sdk';

/** Default per-request limit: generous for every short call the app makes. */
export const AI_CALL_TIMEOUT_MS = 180_000;
/** For the few calls that ask for very long output (governance report, skill draft). */
export const LONG_AI_CALL_TIMEOUT_MS = 300_000;

export function createAnthropicClient(apiKey: string, opts: { timeoutMs?: number } = {}): Anthropic {
  return new Anthropic({ apiKey, timeout: opts.timeoutMs ?? AI_CALL_TIMEOUT_MS });
}
