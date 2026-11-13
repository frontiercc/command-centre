// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The one phrase Work Pulse coaching uses for work above a quick question, so the page and the
// plan never word it two ways. Client-safe: the page imports it, and nothing here reaches the
// database. The tiers it stands for are named in the page's own footnote, from the rubric.
export const MEANINGFUL_WORK = 'meaningful work';

/** A kind of work as people read it: the stored name with its underscores taken out. */
export function kindLabel(taskType: string): string {
  return taskType.replace(/_/g, ' ');
}

/** The same, to start a sentence. */
export function kindLabelCapitalised(taskType: string): string {
  const s = kindLabel(taskType);
  return s.charAt(0).toUpperCase() + s.slice(1);
}
