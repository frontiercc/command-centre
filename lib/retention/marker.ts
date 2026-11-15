// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * What retention writes in place of removed prompt text. It is a stored value, compared in SQL
 * and written by migration 0041, so it never changes; pages show REMOVED_TEXT instead.
 * Client-safe, no imports.
 */
export const STRIPPED_MARKER = '[Content removed — retention policy]';

/** What a page shows where retention removed the text. */
export const REMOVED_TEXT = 'Content removed under the retention policy';

/** Prompt text as a page should show it: the removal marker becomes plain words. */
export function shownContent<T extends string | null | undefined>(text: T): T | string {
  return text === STRIPPED_MARKER ? REMOVED_TEXT : text;
}
