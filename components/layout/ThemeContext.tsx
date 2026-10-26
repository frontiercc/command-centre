// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { createContext, useContext } from 'react';
import type { Theme } from '@/lib/theme';

/**
 * The instance's visual theme, decided on the server (lib/theme.ts) and handed
 * down from the root layout, so client components can switch markup without a flash.
 */
const ThemeContext = createContext<Theme>('default');

export function ThemeProvider({ theme, children }: { theme: Theme; children: React.ReactNode }) {
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function usePrecision(): boolean {
  return useContext(ThemeContext) === 'precision';
}
