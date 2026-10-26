// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import type Anthropic from '@anthropic-ai/sdk';

/**
 * Shared Claude model identifier used across all API calls.
 */
export const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Default model for the briefings and grounded summaries people read and act
 * on (Cowork CIO/weekly/dept briefings, This Week in Code, the use-case impact
 * summary) when no pulse_briefing_model / code_briefing_model is saved. One
 * constant, read by the admin page's displayed default AND every job's
 * fallback, so the two can never disagree (Sonnet for prose
 * accuracy, in line with Highlights, ideation and process mining).
 */
export const BRIEFING_DEFAULT_MODEL = 'claude-sonnet-5';

/**
 * Replace em dashes and en dashes with neutral punctuation.
 * Done post-extraction because prompt instructions alone are unreliable.
 */
function stripDashes(text: string): string {
  return text
    .replace(/ — /g, ': ')
    .replace(/ – /g, ', ')
    .replace(/—/g, ': ')
    .replace(/–/g, '-');
}

/**
 * Extract text content from a Claude API message response.
 */
export function extractText(message: Anthropic.Message): string {
  const text = message.content
    .filter(block => block.type === 'text')
    .map(block => (block as { type: 'text'; text: string }).text)
    .join('');
  return stripDashes(text);
}

/**
 * Strip markdown code fences and parse JSON from a Claude response.
 */
export function stripCodeFences(text: string): string {
  return text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
}

/**
 * Parse JSON from a model response, tolerating the common failure where the
 * model emits a raw (unescaped) newline/CR/tab INSIDE a string literal — which
 * makes strict JSON.parse throw. Tries strict parse first; on failure, escapes
 * raw control chars that occur inside string literals and retries. Returns the
 * parsed value, or null if it still cannot parse.
 */
export function parseModelJson(text: string): unknown | null {
  try { return JSON.parse(text); } catch { /* try repair */ }
  let inString = false, escaped = false, out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { out += ch; escaped = false; continue; }
    if (ch === '\\') { out += ch; escaped = true; continue; }
    if (ch === '"') { inString = !inString; out += ch; continue; }
    if (inString && (ch === '\n' || ch === '\r' || ch === '\t')) {
      out += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : '\\t';
      continue;
    }
    out += ch;
  }
  try { return JSON.parse(out); } catch { return null; }
}
