// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Ask the data: shrink a page route's JSON into what the model needs, without changing a figure.
 * - Text that could carry a person's prompt or an AI's words is dropped (any key that names
 *   content, and any long string), so a lookup never hands prompt text to the model.
 * - Unix timestamps become ISO dates, so the model can say when without converting.
 * - Long lists are cut to their first items, with a note of how many were left out.
 * - Numbers keep up to four decimal places, which never moves a figure a page shows.
 */

/** Keys whose values may hold prompt text, AI replies or free-text evidence: never passed on. */
const DROP_KEY = /(^|_)(content|prompt|prompts|text|excerpt|snippet|message|messages|body|evidence|explanation|narrative|description|definition|reason_text|raw|html|markdown|md)(_|$)/i;
/** Long strings are prose, not labels: dropped. */
const MAX_STRING = 160;

export interface CompactOptions {
  /** Most items kept from any list. */
  maxItems?: number;
  /** Deepest nesting kept. */
  maxDepth?: number;
}

function isTimestampKey(k: string): boolean {
  return /(_at|At|_start|_end|Start|End|^start$|^end$|^since$|^until$)$/.test(k);
}

function toDate(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function roundNumber(n: number): number {
  if (!Number.isFinite(n) || Number.isInteger(n)) return n;
  return Math.round(n * 10_000) / 10_000;
}

export function compact(value: unknown, opts: CompactOptions = {}, depth = 0, key = ''): unknown {
  const maxItems = opts.maxItems ?? 25;
  const maxDepth = opts.maxDepth ?? 6;
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    // Seconds since 1970 between 2001 and 2100, under a time-like key: a date.
    if (isTimestampKey(key) && Number.isInteger(value) && value > 1_000_000_000 && value < 4_102_444_800) return toDate(value);
    if (isTimestampKey(key) && Number.isInteger(value) && value > 1_000_000_000_000 && value < 4_102_444_800_000) return toDate(Math.floor(value / 1000));
    return roundNumber(value);
  }
  if (typeof value === 'string') return value.length > MAX_STRING ? undefined : value;
  if (typeof value === 'boolean') return value;
  if (depth >= maxDepth) return undefined;
  if (Array.isArray(value)) {
    const items = value.slice(0, maxItems).map(v => compact(v, opts, depth + 1, key)).filter(v => v !== undefined);
    if (value.length > maxItems) items.push(`(${value.length - maxItems} more not shown)`);
    return items;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // A count under such a key (messages_7d) is a figure, so only non-numbers are dropped.
      const snake = k.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
      if (DROP_KEY.test(snake) && typeof v !== 'number' && typeof v !== 'boolean') continue;
      const c = compact(v, opts, depth + 1, k);
      if (c !== undefined) out[k] = c;
    }
    return out;
  }
  return undefined;
}

/** Keep only `keys` of a JSON object (all of it when keys is empty), then compact it. */
export function pickCompact(value: unknown, keys: string[], opts: CompactOptions = {}): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || keys.length === 0) return compact(value, opts);
  const src = value as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const k of keys) if (k in src) picked[k] = src[k];
  return compact(picked, opts);
}
