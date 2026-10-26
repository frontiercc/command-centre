// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic use-case lifecycle alerts. Fired by the tracker on a
 * transition TO at_risk. 7-day dedup per use case (a sticky at_risk state
 * must not re-alert on every tracker run).
 */
import { v4 as uuidv4 } from 'uuid';
import { and, eq, gte, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getConfigValue } from '@/lib/config';
import { insertAlert } from '@/lib/db/queries';
import type { UseCase, UseCaseLifecycle } from '@/lib/usecases/queries';
import { getLifecycleConfig } from '@/lib/usecases/lifecycle';
import { personLabel } from '@/lib/alerts/person-label';

const SEVEN_DAYS = 7 * 24 * 3600;

export async function runUseCaseAtRiskAlerts(uc: UseCase, from: UseCaseLifecycle): Promise<void> {
  if ((await getConfigValue('riskAlertUseCaseEnabled') || 'true') === 'false') return;

  const client = await getTypedClient();
  const a = schema.alerts;
  // Substring dedup — the use_case_id is embedded inside the raw_evidence JSON
  // (not a discrete filterable field), so this stays a LIKE match rather than
  // the exact ->> match used for pii_type/file_alert_label. jsonb has no LIKE
  // operator, so cast to text; ILIKE keeps the match case-insensitive.
  const pattern = `%${uc.id}%`;
  const likeExpr = sql`${a.raw_evidence}::text ILIKE ${pattern}`;
  const cutoff = Math.floor(Date.now() / 1000) - SEVEN_DAYS; // app clock

  const recentRows = await client
    .select({ one: sql<number>`1` })
    .from(a)
    .where(and(eq(a.alert_type, 'use_case_at_risk'), likeExpr, gte(a.generated_at, cutoff)))
    .limit(1);
  if (recentRows.length > 0) return;

  const { atRiskQuietWeeks } = await getLifecycleConfig();
  const weekWord = atRiskQuietWeeks === 1 ? 'week' : 'weeks';

  const ownerName = uc.ownerUserId ? await personLabel(uc.ownerUserId) : null;

  await insertAlert({
    id: uuidv4(),
    // alerts.user_id is a nullable FK to users(id) — unlike code-pulse-alerts'
    // subjects (always a real telemetry user_id), a use case's ownerUserId is
    // frequently unset, and a literal 'unknown' string would violate the FK
    // (only NULL is exempt from FK checks, not arbitrary non-null text).
    user_id: uc.ownerUserId,
    alert_type: 'use_case_at_risk',
    severity: 'medium',
    title: `Use case at risk: ${uc.title}`,
    explanation: `"${uc.title}" was ${from} but has had no matching activity for at least ${atRiskQuietWeeks} completed ${weekWord}.${ownerName ? ` Owner: ${ownerName}.` : ''} Worth a check-in with the team before the habit is lost.`,
    raw_evidence: JSON.stringify({ source: 'use_cases', use_case_id: uc.id, from, to: 'at_risk' }),
  });
}
