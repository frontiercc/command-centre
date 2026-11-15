// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * The uses line on an "Explore from Anthropic" card: the entry's uses and the
 * people who used it, all time, the same counts the Board's other cards show
 * (invocation_count and user_count from /api/library). Measured, so a skill
 * nobody has used reads "Not used yet".
 */
export function anthropicUsesLine(e: { invocation_count: number; user_count: number }): string {
  if (!(e.invocation_count > 0)) return 'Not used yet';
  const uses = `${e.invocation_count} ${e.invocation_count === 1 ? 'use' : 'uses'}`;
  return `${uses} · ${e.user_count} ${e.user_count === 1 ? 'person' : 'people'}`;
}
