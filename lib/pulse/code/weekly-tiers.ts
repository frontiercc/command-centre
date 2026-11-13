// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Developer Pulse's judged layer by week: a year of completed weeks for the longer views, and six
 * weeks counting back from today for the delegation journey, so the week in progress is always
 * there. Sessions are placed by when the work happened, never by when the classifier ran.
 */
import { getCodeClassifierConfig } from '@/lib/pulse/code/tier-config';
import { DEFAULT_TIER_NAMES, type TierNames } from '@/lib/pulse/tier-names';

const WEEK = 7 * 86400;

export interface TierWeek { weekStart: number; t1: number; t2: number; t3: number }

function mondayOf(ts: number): number {
  const d = new Date(ts * 1000);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
  return midnight - ((d.getUTCDay() + 6) % 7) * 86400;
}

/** Weekly tier counts from classified sessions: completed weeks, and the six-week grid. */
export function weeklyTiers(
  rows: Array<{ tier: number; last_at: number }>,
  nowS: number,
): { weeks: TierWeek[]; grid: TierWeek[] } {
  const byWeek = new Map<number, TierWeek>();
  for (const r of rows) {
    const ws = mondayOf(r.last_at);
    const w = byWeek.get(ws) ?? { weekStart: ws, t1: 0, t2: 0, t3: 0 };
    if (r.tier === 1) w.t1++; else if (r.tier === 2) w.t2++; else if (r.tier >= 3) w.t3++;
    byWeek.set(ws, w);
  }
  const thisWeek = mondayOf(nowS);
  return {
    weeks: [...byWeek.values()].filter(w => w.weekStart < thisWeek).sort((a, b) => a.weekStart - b.weekStart),
    grid: Array.from({ length: 6 }, (_, i) => {
      const ws = thisWeek - (5 - i) * WEEK;
      return byWeek.get(ws) ?? { weekStart: ws, t1: 0, t2: 0, t3: 0 };
    }),
  };
}

/** What this customer calls each Code tier, from Admin → Developer Pulse → Tiers. */
export async function getCodeTierNames(): Promise<TierNames> {
  try {
    const c = await getCodeClassifierConfig();
    return {
      t1: c.tiers?.tier1?.name?.trim() || DEFAULT_TIER_NAMES.t1,
      t2: c.tiers?.tier2?.name?.trim() || DEFAULT_TIER_NAMES.t2,
      t3: c.tiers?.tier3?.name?.trim() || DEFAULT_TIER_NAMES.t3,
    };
  } catch {
    return DEFAULT_TIER_NAMES;
  }
}
