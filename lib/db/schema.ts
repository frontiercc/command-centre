// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Schema aggregator. Every query site imports table objects from here; the
// definitions live in schema.pg.ts. Postgres is the only database,
// so `schema` is simply the Postgres schema.
import { pgSchema } from './schema.pg';

export { pgSchema } from './schema.pg';

export const schema = pgSchema;

export default schema;
