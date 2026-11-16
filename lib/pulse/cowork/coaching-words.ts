// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The one phrase Work Pulse coaching uses for work above a quick question, so the page and the
// plan never word it two ways. Client-safe: the page imports it, and nothing here reaches the
// database. The tiers it stands for are named in the page's own footnote, from the rubric.
export const MEANINGFUL_WORK = 'meaningful work';

/** What a new way of working is, said the same way on every page that counts them. */
export const NEW_WAYS_OF_WORKING = 'Claude flags work that creates something reusable; the person confirms it, or an admin does.';

/** A kind of work as people read it: the stored name with its underscores taken out. */
export function kindLabel(taskType: string): string {
  return taskType.replace(/_/g, ' ');
}

/** The same, to start a sentence. */
export function kindLabelCapitalised(taskType: string): string {
  const s = kindLabel(taskType);
  return s.charAt(0).toUpperCase() + s.slice(1);
}
