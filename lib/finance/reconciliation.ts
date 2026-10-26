// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-surface reconciliation — compares CCC's own estimate of AI spend
 * (`SurfaceSummary`, from `lib/finance/chargeback.ts`) against Anthropic's
 * own reported spend (`EnterpriseCost`, from `lib/finance/enterprise-cost.ts`)
 * for each of the three surfaces (chat/code/cowork), plus a total.
 *
 * PURE — no DB/IO. Every division is guarded: a zero or missing denominator
 * (or a missing side) yields `deltaPct: null`, never `NaN`/`Infinity`.
 */
import type { SurfaceSummary } from '@/lib/finance/chargeback';
import type { EnterpriseCost } from '@/lib/finance/enterprise-cost';

export interface SurfaceRecon {
  surface: 'chat' | 'code' | 'cowork';
  cccUsd: number | null;
  anthropicUsd: number | null;
  deltaPct: number | null;
}

export interface Reconciliation {
  available: boolean;
  perSurface: SurfaceRecon[];
  totalDeltaPct: number | null;
}

const SURFACES: Array<'chat' | 'code' | 'cowork'> = ['chat', 'code', 'cowork'];

/** (a-b)/b*100, guarded against null inputs and a zero/falsy denominator. */
function guardedDeltaPct(cccUsd: number | null, anthropicUsd: number | null): number | null {
  if (cccUsd === null || anthropicUsd === null || anthropicUsd === 0) return null;
  return ((cccUsd - anthropicUsd) / anthropicUsd) * 100;
}

export function buildReconciliation(surfaces: SurfaceSummary, enterprise: EnterpriseCost | null): Reconciliation {
  if (enterprise === null) {
    return { available: false, perSurface: [], totalDeltaPct: null };
  }

  const perSurface: SurfaceRecon[] = SURFACES.map((surface) => {
    const cccUsd = surfaces[surface].usd;
    const anthropicUsd = enterprise.bySurface[surface].usd;
    return { surface, cccUsd, anthropicUsd, deltaPct: guardedDeltaPct(cccUsd, anthropicUsd) };
  });

  const cccTotal = SURFACES.reduce((sum, surface) => sum + (surfaces[surface].usd ?? 0), 0);
  const anthropicTotal = SURFACES.reduce((sum, surface) => sum + enterprise.bySurface[surface].usd, 0);
  const totalDeltaPct = anthropicTotal === 0 ? null : ((cccTotal - anthropicTotal) / anthropicTotal) * 100;

  return { available: true, perSurface, totalDeltaPct };
}
