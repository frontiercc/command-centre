// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Department benchmark. Pure/client-safe. Answers "is
// adoption even across the org, or lumpy?" as a spread around the median — NOT
// a league table. The support flag fires on an ABSOLUTE floor (a healthy org
// can reach zero flags), never on below-median position (which would condemn
// half the org every period, a Goodhart trap).

export interface DeptBenchmarkInput {
  department: string;
  member_count: number;
  avg_dds: number | null;
}

export interface DeptBenchmarkRow {
  department: string;
  memberCount: number;
  avgDds: number | null;
  /** Fewer than minSize active members — shown greyed, "too small to compare". */
  tooSmall: boolean;
  /** Below the absolute DDS floor (eligible depts only). */
  needsSupport: boolean;
  /** Position relative to the org median; null when too small / no DDS / no median. */
  deltaFromMedian: number | null;
}

export interface DeptBenchmark {
  median: number | null;
  minSize: number;
  rows: DeptBenchmarkRow[];
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

export function buildDeptBenchmark(
  depts: DeptBenchmarkInput[],
  opts: { floor: number; minSize?: number },
): DeptBenchmark {
  const minSize = opts.minSize ?? 4;

  const eligibleDds = depts
    .filter(d => d.member_count >= minSize && d.avg_dds !== null)
    .map(d => d.avg_dds as number);
  const med = median(eligibleDds);

  // Alphabetical order — deliberately NOT ranked by score (no leaderboard).
  const rows: DeptBenchmarkRow[] = [...depts]
    .sort((a, b) => (a.department < b.department ? -1 : 1))
    .map(d => {
      const eligible = d.member_count >= minSize && d.avg_dds !== null;
      const tooSmall = d.member_count < minSize;
      return {
        department: d.department,
        memberCount: d.member_count,
        avgDds: d.avg_dds,
        tooSmall,
        needsSupport: eligible && (d.avg_dds as number) < opts.floor,
        deltaFromMedian: eligible && med !== null ? (d.avg_dds as number) - med : null,
      };
    });

  return { median: med, minSize, rows };
}
