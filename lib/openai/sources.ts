// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The `source` values the OpenAI sync stamps on the rows it writes, and how
// they read on screen. Client-safe: no server imports.
//
// ChatGPT Chat and Work prompts are stored beside Cowork prompts, Codex prompts
// beside Claude Code prompts; `source` is what tells them apart everywhere.

export const OPENAI_SOURCES = ['chatgpt_chat', 'chatgpt_work', 'codex'] as const;
export type OpenAiSource = (typeof OPENAI_SOURCES)[number];

export const OPENAI_SOURCE_LABELS: Record<OpenAiSource, string> = {
  chatgpt_chat: 'ChatGPT Chat',
  chatgpt_work: 'ChatGPT Work',
  codex: 'Codex',
};

/** `users.source` for a person first seen through the OpenAI sync. */
export const OPENAI_USER_SOURCE = 'openai';

export function isOpenAiSource(source: string | null | undefined): source is OpenAiSource {
  return !!source && (OPENAI_SOURCES as readonly string[]).includes(source);
}
