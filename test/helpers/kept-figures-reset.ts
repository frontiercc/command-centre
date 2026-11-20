// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Every test starts with no kept page figures (lib/kept-figures.ts), so a page's figures are always
// built from the test's own data, never served from an earlier test's.
import { beforeEach } from 'vitest';
import { clearKeptFigures } from '@/lib/kept-figures';

beforeEach(() => {
  clearKeptFigures();
});
