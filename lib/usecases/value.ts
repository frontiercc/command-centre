// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure value-estimate math for the Use Case Governance rollup (Phase 3).
 * MEASURED counts (sessions/users) come from the weekly rollup and are fact;
 * the hours/$ this module returns are ESTIMATES built on admin calibrations
 * and must always be labelled as such in the UI (violet, assumption inline).
 * No DB access, no config reads — caller passes the calibration.
 */
import type { WeekActivity } from '@/lib/usecases/weeks';

export interface BetCalibration {
  minutesPerSession: number;
  loadedCompAnnual: number;
}

export const WORKING_HOURS_PER_YEAR = 1800;

/** Sum of matched sessions over the measured weeks provided (absent weeks are simply not in the array). */
export function sumMeasuredSessions(weeks: WeekActivity[]): number {
  return weeks.reduce((acc, w) => acc + w.sessionCount, 0);
}

/** Estimated capacity recovered, in hours. sessions × minutes/session ÷ 60. */
export function computeHoursRecovered(sessions: number, cal: BetCalibration): number {
  if (sessions <= 0) return 0;
  return (sessions * cal.minutesPerSession) / 60;
}

/** Estimated $ value of recovered hours. hours × (annual loaded comp ÷ working hours/year). */
export function computeDollarsRecovered(hours: number, cal: BetCalibration): number {
  if (hours <= 0) return 0;
  return hours * (cal.loadedCompAnnual / WORKING_HOURS_PER_YEAR);
}
