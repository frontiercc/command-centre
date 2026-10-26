// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Visual theme. The Precision design is the app's only look: every page is
 * built on it, so there is no switch back to the earlier design. Going back means deploying the
 * previous release. 'default' remains in the type only because older layout components still
 * accept it; nothing selects it.
 * Server-only: client components receive the value as a prop from the root layout.
 */
export type Theme = 'default' | 'precision';

export function getTheme(): Theme {
  return 'precision';
}

/** Sidebar / mobile header logo for a theme: the light theme needs the dark-blue wordmark. */
export function logoFor(theme: Theme): string {
  return theme === 'precision' ? '/frontier-logo-dark.svg' : '/frontier-logo.svg';
}
