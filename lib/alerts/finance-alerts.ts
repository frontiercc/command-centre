// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * FinOps v2 — reconciliation-drift alert. Deterministic: compares Command Centre's own
 * chargeback estimate against Anthropic's Enterprise Analytics cost report
 * for the current period and raises an alert when the drift exceeds an
 * admin-configurable threshold. No AI judgement involved.
 *
 * Dormant unless `chargebackEnabled` is on; silent (no key, no reconciliation
 * data available) whenever `buildReconciliation` can't compare — never
 * fabricates a drift figure.
 *
 * Dedupes against alerts of the same type + period fired in the last 7 days, so
 * an ongoing drift condition doesn't re-fire every scheduler cycle.
 */
import { v4 as uuidv4 } from 'uuid';
import { and, eq, gte, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getConfigValue, getAllConfig } from '@/lib/config';
import { insertAlert } from '@/lib/db/queries';
import { buildChargeback } from '@/lib/finance/chargeback';
import { getEnterpriseCost } from '@/lib/finance/enterprise-cost';
import { buildReconciliation } from '@/lib/finance/reconciliation';
import { currentPeriod } from '@/lib/finance/period';

const WEEK = 7 * 24 * 3600;
const ALERT_TYPE = 'finance_reconciliation_drift';

/** True if an alert of this type mentioning this subject fired in the last 7 days. */
async function recentlyAlerted(alertType: string, subject: string, nowS: number): Promise<boolean> {
  const client = await getTypedClient();
  const a = schema.alerts;
  // Substring dedup on the period embedded in raw_evidence — same ILIKE match
  // as use-case-alerts.ts (see that file's comment).
  const pattern = `%${subject}%`;
  const likeExpr = sql`${a.raw_evidence}::text ILIKE ${pattern}`;
  const cutoff = nowS - WEEK;
  const rows = await client
    .select({ one: sql<number>`1` })
    .from(a)
    .where(and(eq(a.alert_type, alertType), likeExpr, gte(a.generated_at, cutoff)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Compares Command Centre's chargeback estimate against Anthropic's reported spend for
 * the current period and raises a `finance_reconciliation_drift` alert when
 * the total delta exceeds the configured threshold.
 */
export async function runFinanceDriftAlert(nowS: number = Math.floor(Date.now() / 1000)): Promise<void> {
  try {
    if ((await getConfigValue('riskAlertFinanceDriftEnabled') || 'true') === 'false') return;
    if ((await getAllConfig()).chargebackEnabled !== true) return;

    const period = currentPeriod(nowS);
    const report = await buildChargeback(period, nowS);
    const { data } = await getEnterpriseCost(period);
    const recon = buildReconciliation(report.surfaces, data);

    if (!recon.available || recon.totalDeltaPct === null) return;

    const threshold = parseFloat(await getConfigValue('financeDriftAlertThresholdPct')) || 10;
    const totalDeltaPct = recon.totalDeltaPct;
    if (Math.abs(totalDeltaPct) < threshold) return;

    if (await recentlyAlerted(ALERT_TYPE, period, nowS)) return;

    await insertAlert({
      id: uuidv4(),
      user_id: null,
      alert_type: ALERT_TYPE,
      severity: Math.abs(totalDeltaPct) >= threshold * 2 ? 'high' : 'medium',
      title: `Command Centre vs Anthropic reconciliation drift ${totalDeltaPct.toFixed(1)}% for ${period}`,
      explanation: `Command Centre's estimated AI spend for ${period} differs from Anthropic's reported spend by ${totalDeltaPct.toFixed(1)}% (threshold ${threshold}%). Could indicate a pricing gap, an unpriced model, or a capture drift worth investigating.`,
      raw_evidence: JSON.stringify({ source: 'finops', period, totalDeltaPct, threshold }),
    });
  } catch (err) {
    console.error('[FinanceAlerts] reconciliation drift check failed:', err instanceof Error ? err.message : err);
  }
}
