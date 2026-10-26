// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// An S&C Board entry's "source" link must be an ordinary web address. Any
// signed-in user can set it when claiming an entry, and it is rendered as a
// link on the Board, so only http and https are accepted when saving and
// only those are rendered as links (security re-review).
// Client-safe: imported by the Board pages too.
export function isWebUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    const u = new URL(value.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** A saved source_url: null when blank, the trimmed URL when it is a web address, undefined when it is not (refuse). */
export function normaliseSourceUrl(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  return isWebUrl(value) ? (value as string).trim() : undefined;
}

export const SOURCE_URL_ERROR = 'The source link must be a web address starting with http:// or https://';
