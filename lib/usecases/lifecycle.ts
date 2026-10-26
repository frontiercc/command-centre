// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure lifecycle derivation for use cases. No DB access.
 * Rules evaluate over MEASURED completed weeks only (absent weeks were
 * "not measuring" — never counted as quiet). Current-week activity can
 * promote but never demote.
 */
import { getConfigValue } from '@/lib/config';
import type { UseCaseLifecycle } from '@/lib/usecases/queries';
import type { WeekActivity } from '@/lib/usecases/weeks';

export interface LifecycleConfig {
  adoptedMinWeeks: number;
  adoptedMinUsers: number;
  atRiskQuietWeeks: number;
  notSeenQuietWeeks: number;
}

type ThresholdKey =
  | 'useCasesAdoptedMinWeeks'
  | 'useCasesAdoptedMinUsers'
  | 'useCasesAtRiskQuietWeeks'
  | 'useCasesNotSeenQuietWeeks';

async function num(key: ThresholdKey, fallback: number): Promise<number> {
  const v = parseInt((await getConfigValue(key)) || '', 10);
  return isFinite(v) && v > 0 ? v : fallback;
}

export async function getLifecycleConfig(): Promise<LifecycleConfig> {
  return {
    adoptedMinWeeks: await num('useCasesAdoptedMinWeeks', 3),
    adoptedMinUsers: await num('useCasesAdoptedMinUsers', 2),
    atRiskQuietWeeks: await num('useCasesAtRiskQuietWeeks', 2),
    notSeenQuietWeeks: await num('useCasesNotSeenQuietWeeks', 6),
  };
}

const isActive = (w: WeekActivity): boolean => w.matchedMessages > 0 || w.sessionCount > 0;

export function deriveLifecycle(
  current: UseCaseLifecycle,
  completedWeeks: WeekActivity[], // ascending, measured only
  currentWeek: WeekActivity | null,
  windowDistinctUsers: number,    // exact union over the last 4 measured completed weeks
  cfg: LifecycleConfig,
): UseCaseLifecycle {
  const last4 = completedWeeks.slice(-4);
  const activeWeeks = last4.filter(isActive).length;
  const currentActive = currentWeek !== null && isActive(currentWeek);

  // 1. adopted — sustained breadth
  if (activeWeeks >= cfg.adoptedMinWeeks && windowDistinctUsers >= cfg.adoptedMinUsers) return 'adopted';

  // Quiet streak: consecutive measured completed weeks with no activity, newest first.
  let quiet = 0;
  for (let i = completedWeeks.length - 1; i >= 0; i--) {
    if (isActive(completedWeeks[i])) break;
    quiet++;
  }

  // 2./3. demotions — only from a previously-seen state, never while the current week has activity
  if (!currentActive && (current === 'adopted' || current === 'piloting' || current === 'at_risk')) {
    if (quiet >= cfg.notSeenQuietWeeks) return 'not_seen';
    if (quiet >= cfg.atRiskQuietWeeks) return 'at_risk';
  }

  // 4. piloting — recent activity, not (yet) meeting the adopted bar
  if (currentActive || completedWeeks.slice(-2).some(isActive)) return 'piloting';

  // No recent activity and no demotion applies: hold at_risk (sticky), else not_seen.
  return current === 'at_risk' ? 'at_risk' : 'not_seen';
}
