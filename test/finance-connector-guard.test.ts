// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression-lock test: connector guard — no chargeback/per-user cost leak.
 *
 * This test is an invariant assertion that chargeback and per-user cost data
 * can NEVER leak through the org-only Metrics Connector endpoints
 * (/api/export, /api/mcp). These routes are token-gated and visible to BI
 * systems; they must carry ONLY org-level aggregates, never per-department
 * or per-user cost breakdowns.
 *
 * Passes on first run (invariant already holds); if a change violates the
 * guard, this test fails and highlights the breach.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CONNECTOR_METRIC_ALLOWLIST, getConnectorSummary, getConnectorHealth } from '@/lib/connector/data';
import { createTestDatabase } from './helpers/db';

let cleanup: () => Promise<void>;

beforeAll(async () => {
  const t = await createTestDatabase();
  cleanup = t.cleanup;
});

afterAll(async () => cleanup());

describe('connector guard — no chargeback leak', () => {
  /**
   * Assert 1: CONNECTOR_METRIC_ALLOWLIST has no chargeback metric.
   *
   * The allowlist is the entry point for allowed connector trend metrics.
   * If any entry matches the chargeback pattern, the route will surface it.
   */
  it('connector metric allowlist exposes no chargeback/cost-centre metric', () => {
    const chargebackPattern = /charge|cost.?centre|per.?user/i;
    for (const m of CONNECTOR_METRIC_ALLOWLIST) {
      expect(m).not.toMatch(chargebackPattern);
    }
  });

  /**
   * Assert 2: getConnectorSummary() payload carries no chargeback keys.
   *
   * Walk ALL nested keys of the returned object (org-level digest snapshot)
   * and assert none match the chargeback pattern. This catches any leakage
   * even if it's nested deeply.
   */
  it('getConnectorSummary() payload carries no chargeback/per-user-cost keys', async () => {
    const chargebackPattern = /charge|cost.?centre|per.?user|dept.*cost|user.*cost/i;
    const summary = await getConnectorSummary();

    // Walk all nested keys, collecting them in a flat array for testing.
    function allKeys(o: unknown, acc: string[] = []): string[] {
      if (o && typeof o === 'object') {
        for (const [k, v] of Object.entries(o)) {
          acc.push(k);
          allKeys(v, acc);
        }
      }
      return acc;
    }

    const keys = allKeys(summary);
    for (const k of keys) {
      expect(k).not.toMatch(chargebackPattern);
    }
  });

  /**
   * Assert 3: getConnectorHealth() payload carries no chargeback keys.
   *
   * The health endpoint returns code_pulse data-health snapshot.
   * Walk its nested keys and assert none match the chargeback pattern.
   */
  it('getConnectorHealth() payload carries no chargeback/per-user-cost keys', async () => {
    const chargebackPattern = /charge|cost.?centre|per.?user|dept.*cost|user.*cost/i;
    const health = await getConnectorHealth();

    // Walk all nested keys, collecting them in a flat array for testing.
    function allKeys(o: unknown, acc: string[] = []): string[] {
      if (o && typeof o === 'object') {
        for (const [k, v] of Object.entries(o)) {
          acc.push(k);
          allKeys(v, acc);
        }
      }
      return acc;
    }

    const keys = allKeys(health);
    for (const k of keys) {
      expect(k).not.toMatch(chargebackPattern);
    }
  });

  /**
   * Assert 4: Finance routes are NOT connector-passthrough prefixes.
   *
   * The middleware.ts SELF_AUTH_API_PREFIXES list defines which routes bypass
   * session auth and use token auth instead (OTel ingest, connector export,
   * etc.). Finance routes (/api/finance) must NEVER be in this list — they
   * must stay session-gated, never accessible via connector tokens.
   *
   * Read the middleware source as text and assert it does not include
   * /api/finance in the passthrough prefix list.
   */
  it('middleware does not treat /api/finance as a token-auth/connector passthrough prefix', () => {
    const middlewarePath = join(process.cwd(), 'middleware.ts');
    const src = readFileSync(middlewarePath, 'utf-8');

    // SELF_AUTH_API_PREFIXES is the token-auth passthrough list.
    // /api/finance must not appear in it (including as part of a larger string).
    expect(src).not.toMatch(/['"]\/api\/finance/);

    // Extra sanity check: confirm /api/export and /api/mcp ARE in the list
    // (connector routes are intentionally token-gated there).
    expect(src).toMatch(/['"]\/api\/export\//);
    expect(src).toMatch(/['"]\/api\/mcp/);
  });
});
