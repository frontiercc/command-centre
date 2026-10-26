// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Use case tracker: adoption stage and the measured-week marker for every live
 * use case. It no longer decides who is doing a use case: since the
 * change to use cases defined by the work that is the session judge
 * (lib/usecases/session-judge.ts), which writes the weekly matches this reads.
 * Before, the tracker matched every new telemetry row against each use case's
 * keywords, skills, connectors and task labels; tools said how people worked,
 * not what they worked on, so the counts overstated (66 sessions against 3 for
 * one production process).
 *
 * A measured row is written for the current week every run, including weeks
 * with no matches, so an absent week provably means "not measuring".
 */
import { getConfigValue, setConfigValue } from '@/lib/config';
import { weekStart } from '@/lib/pulse/period';
import { listUseCases, updateUseCase, type UseCase, type UseCaseLifecycle } from '@/lib/usecases/queries';
import { ensureWeekRow, getMeasuredCompletedWeeks, getCurrentWeek, getWindowDistinctUsers } from '@/lib/usecases/weeks';
import { deriveLifecycle, getLifecycleConfig } from '@/lib/usecases/lifecycle';
import { runUseCaseAtRiskAlerts } from '@/lib/alerts/use-case-alerts';

export { signalMatches } from '@/lib/usecases/signal-match';

async function applyLifecycle(uc: UseCase, nowS: number, onChange?: (uc: UseCase, from: UseCaseLifecycle, to: UseCaseLifecycle) => void): Promise<void> {
  const cfg = await getLifecycleConfig();
  const completed = await getMeasuredCompletedWeeks(uc.id, 8, nowS);
  const currentWeek = await getCurrentWeek(uc.id, nowS);
  const last4Starts = completed.slice(-4).map(w => w.weekStart);
  const windowUsers = await getWindowDistinctUsers(uc.id, last4Starts);
  const next = deriveLifecycle(uc.lifecycle, completed, currentWeek, windowUsers, cfg);
  if (next !== uc.lifecycle) {
    await updateUseCase(uc.id, { lifecycle: next, lifecycleChangedAt: nowS });
    onChange?.(uc, uc.lifecycle, next);
  }
}

/**
 * Called when a use case is created, confirmed, added from a suggestion or has
 * its description or clues edited: marks the week measured, refreshes its
 * stage, and asks the next scheduler cycle to run the session judge, which
 * judges the department's last 13 weeks against the changed set of use cases.
 */
export async function bootstrapUseCase(useCaseId: string, nowS: number = Math.floor(Date.now() / 1000)): Promise<void> {
  const uc = (await listUseCases()).find(u => u.id === useCaseId);
  if (!uc || uc.status === 'archived') return;
  await ensureWeekRow(useCaseId, weekStart(nowS));
  await applyLifecycle(uc, nowS);
  // Inlined rather than imported from session-judge, which imports the
  // scheduler (this module is imported by the scheduler too).
  await setConfigValue('useCaseJudgeLastRun', '');
}

export async function runUseCaseTracker(
  nowS: number = Math.floor(Date.now() / 1000),
  opts?: { onLifecycleChange?: (uc: UseCase, from: UseCaseLifecycle, to: UseCaseLifecycle) => void },
): Promise<{ processed: number }> {
  const live = (await listUseCases()).filter(u => u.status !== 'archived');
  const currentWk = weekStart(nowS);
  for (const uc of live) {
    try {
      await ensureWeekRow(uc.id, currentWk);
      await applyLifecycle(uc, nowS, opts?.onLifecycleChange);
    } catch (err) {
      console.error(`[UseCaseTracker] lifecycle failed for ${uc.id}:`, err instanceof Error ? err.message : err);
    }
  }
  return { processed: live.length };
}

/** Scheduler entry point — gate + cadence guard, mirrors the Pulse job pattern. */
export async function runUseCaseTrackerJob(): Promise<void> {
  if ((await getConfigValue('useCasesEnabled')) !== 'true') return;
  const intervalHoursRaw = parseInt((await getConfigValue('useCasesTrackerIntervalHours')) || '1', 10);
  const intervalHours = isFinite(intervalHoursRaw) && intervalHoursRaw >= 1 ? intervalHoursRaw : 1;
  const lastRun = await getConfigValue('useCasesTrackerLastRun');
  const cutoff = new Date(Date.now() - intervalHours * 3600 * 1000).toISOString();
  if (lastRun && lastRun >= cutoff) return;

  const result = await runUseCaseTracker(undefined, {
    // Fire-and-forget, as before: the callback is synchronous inside the
    // lifecycle chain, and an alert failure must not stop the run.
    onLifecycleChange: (uc, from, to) => {
      if (to === 'at_risk') {
        runUseCaseAtRiskAlerts(uc, from).catch((err) => {
          console.error(`[UseCaseTracker] at-risk alert failed for ${uc.id}:`, err instanceof Error ? err.message : err);
        });
      }
    },
  });
  console.log(`[UseCaseTracker] lifecycle refreshed for ${result.processed} use case(s)`);
  await setConfigValue('useCasesTrackerLastRun', new Date().toISOString());
}
