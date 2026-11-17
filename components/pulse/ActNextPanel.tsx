// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// What to act on next on the Work Pulse overview: coaching and model review items, and the
// department process boxes, as the overview's data returns them.

export type ActNextType = 'coaching' | 'model_review';
export interface ActNextItem { type: ActNextType; title: string; detail: string; reach: number; href: string }
export interface DeptProcessBoxItem {
  department: string;
  key?: string;
  label?: string;
  count: number;
  suggestions: { id: string; title: string }[];
  /** Cowork and Claude Code lists, each ranked by people then sessions. */
  groups?: { surface: string; label: string; suggestions: { id: string; title: string }[] }[];
}
