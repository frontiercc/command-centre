// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// drizzle-kit config for the Postgres migrations (lib/db/migrations-pg).
//
// Points at the schema definitions file (lib/db/schema.pg.ts) rather than the
// lib/db/schema.ts aggregator. Audit tables (lib/db/schema-audit.ts) are
// deliberately excluded — they have their own migration set with the
// immutability triggers (lib/db/migrations-pg-audit).
//
// Regenerate after any schema.pg.ts change with:
//   npx drizzle-kit generate --dialect postgresql --schema lib/db/schema.pg.ts --out lib/db/migrations-pg
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: 'lib/db/schema.pg.ts',
  out: 'lib/db/migrations-pg',
});
