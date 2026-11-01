// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Which vendors' products this install has connected, and the one rule every
// page reads from it. Client-safe: no server imports (the server side is
// lib/sources/connected.ts).

export interface ConnectedProducts {
  /** Any Claude data, or a Claude key (Compliance, Admin or Analytics API). */
  claude: boolean;
  /** An OpenAI Admin API key, or any ChatGPT or Codex data. */
  openai: boolean;
}

/**
 * OpenAI is connected and Claude is not: pages show OpenAI's products only,
 * with no vendor switch, and hide what only Claude can ever fill. An install
 * with nothing connected yet reads as Claude, as it always has.
 */
export function isOpenAiOnly(c: ConnectedProducts | null | undefined): boolean {
  return !!c && c.openai && !c.claude;
}
