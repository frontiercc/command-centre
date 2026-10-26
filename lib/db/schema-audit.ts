// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Schema for access_audit_log, the append-only audit table. It lives in the
// main Postgres database (lib/db/client.ts's getAuditClient() opens its own
// pool against it) and is created by applyAuditImmutabilityPg()
// (lib/db/audit-db.ts, migrations-pg-audit/) with its two immutability
// triggers — NOT by the numbered migrations. The CHECK constraints on
// action/outcome live in that DDL, not in these Drizzle column types.
import { pgTable, text, integer, bigint } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const accessAuditLogPg = pgTable('access_audit_log', {
  id: integer().generatedByDefaultAsIdentity().primaryKey(),
  actor_id: text().notNull(),
  actor_email: text().notNull(),
  actor_ip: text(),
  resource: text().notNull(),
  action: text().notNull(), // CHECK(action IN ('READ','WRITE','DELETE','EXPORT','SSO_LOGIN'))
  outcome: text().notNull(), // CHECK(outcome IN ('success','denied','error','failure'))
  detail: text(),
  occurred_at: bigint({ mode: 'number' }).notNull().default(sql`extract(epoch from now())`),
});

export const auditPgSchema = { accessAuditLog: accessAuditLogPg };

export const auditSchema = auditPgSchema;

export default auditSchema;
