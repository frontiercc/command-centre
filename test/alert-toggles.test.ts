// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// finance_reconciliation_drift and use_case_at_risk fired with no
// admin control. The generators now check their riskAlert*Enabled toggle.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';

describe('alert toggles', () => {
  let cleanup: () => Promise<void>;
  beforeAll(async () => { const t = await createTestDatabase(); cleanup = t.cleanup; });
  afterAll(async () => cleanup());

  // Runs before the suppression test below (which flips the toggle to
  // 'false' for the remainder of the suite's shared DB) so it observes the
  // real unset-key default rather than a value written by a prior test.
  it('defaults keep both alert types enabled', async () => {
    const cfg = await import('@/lib/config');
    expect((await cfg.getAllConfig()).riskAlertUseCaseEnabled).toBe('true');
    expect((await cfg.getAllConfig()).riskAlertFinanceDriftEnabled).toBe('true');
  });

  it('use_case_at_risk alert is suppressed when riskAlertUseCaseEnabled=false', async () => {
    const cfg = await import('@/lib/config');
    await cfg.setConfigValue('riskAlertUseCaseEnabled', 'false');

    const { runUseCaseAtRiskAlerts } = await import('@/lib/alerts/use-case-alerts');
    // Minimal UseCase shape — read lib/usecases/queries.ts UseCase type and
    // supply required fields; ownerUserId null is valid (alerts.user_id nullable).
    await runUseCaseAtRiskAlerts({ id: 'uc1', title: 'T', ownerUserId: null } as never, 'piloting');

    const { getTypedClient } = await import('@/lib/db/client');
    const { schema } = await import('@/lib/db/schema');
    const client = await getTypedClient();
    const rows = await client.select().from(schema.alerts);
    expect(rows.filter(r => r.alert_type === 'use_case_at_risk')).toHaveLength(0);
  });
});
