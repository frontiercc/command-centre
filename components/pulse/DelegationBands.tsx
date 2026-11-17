// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Delegation over time: each week's tier shares, split where the rubric changed, and each
// person's or department's then-against-now, as the CIO overview and department page receive them.

interface BandWeek { weekStart: number; t1Share: number | null; t2Share: number | null; t3Share: number | null }
export interface BandSegment { weeks: BandWeek[]; startsAtRubricBreak: boolean }
export interface PersonDelegation {
  userId: string;
  displayName: string;
  sparkline: Array<number | null>;
  thenVsNow: { then: number; now: number; deltaPp: number; arrow: 'up' | 'flat' | 'down'; dataWeeks: number } | null;
  dataWeeks: number;
}
