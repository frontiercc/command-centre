// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Thinking-off request fields for a configurable model.
 *
 * Some calls run with thinking off because thinking counts against max_tokens
 * and cut replies off (measured on Sonnet 5, see skill-draft.ts). The model is
 * picked by an admin from the live model list, and the way to turn thinking
 * off differs by model:
 * - Opus 5.5 and the Fable/Mythos line: thinking is always on and
 *   `{type: 'disabled'}` is a 400, so leave `thinking` out and run at low effort.
 * - Sonnet 5.5: `{type: 'disabled'}` is a 400; `{type: 'between_tools'}` is the
 *   thinking-off setting (no other thinking field, default effort).
 * - Every other model (Sonnet 5, Haiku 4.5 and 5.5, Opus 4.x and 5): `{type: 'disabled'}`.
 */
import type Anthropic from '@anthropic-ai/sdk';

export interface ThinkingOff {
  thinking?: Anthropic.ThinkingConfigParam;
  /** Merge into output_config when set. */
  effort?: 'low';
}

export function thinkingOff(model: string): ThinkingOff {
  const id = model.toLowerCase();
  if (/opus-5-5|fable-5|mythos-5/.test(id)) return { effort: 'low' };
  // The installed SDK types predate 'between_tools'.
  if (/sonnet-5-5/.test(id)) return { thinking: { type: 'between_tools' } as unknown as Anthropic.ThinkingConfigParam };
  return { thinking: { type: 'disabled' } };
}
