// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.test.ts'],
    // Postgres is the only database. Database tests get a per-file database
    // on the server named by CCC_TEST_PG_URL, or a testcontainer without it
    // (test/helpers/pg.ts).
    // Shared-server Postgres mode (item 18): a no-op unless CCC_TEST_PG_URL
    // is set, when it clears leftover ccc_t_* test databases and builds the
    // migrated template before any file starts. See test/helpers/pg.ts.
    globalSetup: ['test/helpers/pg-global-setup.ts'],
    // Each test starts with no kept page figures (lib/kept-figures.ts).
    setupFiles: ['test/helpers/kept-figures-reset.ts'],
    // Several suites re-import heavy module graphs (vi.resetModules + lib/anthropic)
    // or run real scrypt (N=32768) against a fresh database. Under parallel load
    // (Docker, CI) these legitimately exceed the 5s default and flake.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  // tsconfig keeps JSX as written for Next.js; tests compile it with React's
  // automatic runtime instead (vitest 4 follows tsconfig otherwise and cannot read it).
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
