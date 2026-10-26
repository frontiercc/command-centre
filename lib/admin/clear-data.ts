// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * DESTRUCTIVE: wipe the Audit Log view and the Alert view.
 *
 * Clears exactly the tables those two views read from — nothing else. In
 * particular it does NOT touch the security/compliance audit trail
 * (`compliance_events`, `auth_events`), accounts, config, or anything else.
 *
 * Note: the audit-event tables (`cowork_messages`, `code_assistant_meta`, the
 * skill/MCP invocation tables) are also the SOURCE that Code/Work Pulse
 * aggregate from, so those dashboards will recompute to empty on the next
 * aggregation cycle. We do not clear the derived Pulse snapshot tables directly.
 *
 * Guarded at the API layer (admin-only + typed confirmation) — see
 * app/api/admin/clear-data/route.ts.
 *
 * The whole clear runs inside one `withTx` (all-or-nothing — this is the
 * admin "Clear Audit Log & Alerts" Danger Zone, it must stay atomic), deleting
 * in the child-first FK order of CLEARED_TABLES. It resolves getTypedClient()
 * itself; the one caller (app/api/admin/clear-data/route.ts) passes no args.
 */
import { getTypedClient } from '@/lib/db/client';
import { withTx } from '@/lib/db/with-tx';
import { schema } from '@/lib/db/schema';

/**
 * Tables cleared by "Clear Audit Log & Alerts", in FK-safe delete order.
 *
 * `cowork_messages` is FK-referenced (NO ACTION / restrict) by per-message Pulse
 * child records — `pulse_classifications`, `pulse_events`, `pulse_skill_runs`
 * (each is the classification/event/skill-run OF a specific audit message). With
 * `foreign_keys = ON`, those children MUST be deleted before the parent, or the
 * DELETE throws "FOREIGN KEY constraint failed". They're per-message records, not
 * Pulse aggregates — the aggregate tables (pulse_metrics, code_metrics, …) are
 * deliberately left alone and recompute to empty.
 */
export const CLEARED_TABLES = [
  // FK-children of cowork_messages — must go first
  'pulse_classifications',
  'pulse_events',
  'pulse_skill_runs',
  // Audit Log view event feed
  'cowork_skill_invocations',
  'cowork_mcp_invocations',
  'code_assistant_meta',
  'cowork_messages',
  'chat_messages',
  // Alert view
  'alerts',
] as const;

/**
 * Drizzle table object per cleared table name, keyed identically to
 * CLEARED_TABLES so `tx.delete(TABLE_SCHEMA_MAP[table])` type-checks against
 * each table's own specific column shape — no `as any` needed.
 */
const TABLE_SCHEMA_MAP = {
  pulse_classifications: schema.pulseClassifications,
  pulse_events: schema.pulseEvents,
  pulse_skill_runs: schema.pulseSkillRuns,
  cowork_skill_invocations: schema.coworkSkillInvocations,
  cowork_mcp_invocations: schema.coworkMcpInvocations,
  code_assistant_meta: schema.codeAssistantMeta,
  cowork_messages: schema.coworkMessages,
  chat_messages: schema.chatMessages,
  alerts: schema.alerts,
} as const;

function rowsAffected(result: unknown): number {
  return Number((result as { rowCount?: number | null }).rowCount ?? 0);
}

/** Wipe the audit-log + alert view data in a single transaction. Returns per-table delete counts. */
export async function clearAuditAndAlerts(): Promise<Record<string, number>> {
  const client = await getTypedClient();
  const counts: Record<string, number> = {};
  await withTx(client, async (tx) => {
    for (const table of CLEARED_TABLES) {
      const result = await tx.delete(TABLE_SCHEMA_MAP[table]);
      counts[table] = rowsAffected(result);
    }
  });
  return counts;
}
