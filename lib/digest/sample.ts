// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Weekly Exec Digest — built-in sample data.
 *
 * Used by the admin preview/test endpoints as a fallback when
 * `buildDigest()` returns null (no completed-week data yet, e.g. a brand
 * new instance) so admins can always see what the digest looks like and
 * always exercise the delivery channels. Values are illustrative only —
 * never a claim about real usage — hence the watermark banner prepended by
 * the caller (see app/api/admin/digest/preview/route.ts).
 */
import type { DigestData } from '@/lib/digest/build';

const DAY = 86400;
const WEEK = 7 * DAY;

// Fixed Monday 00:00 UTC — deterministic, not tied to "now" so the sample
// renders identically regardless of when it's requested.
const SAMPLE_WEEK_START = Date.UTC(2026, 5, 22) / 1000; // 2026-06-22 (Mon)

export const SAMPLE_DIGEST_DATA: DigestData = {
  weekStart: SAMPLE_WEEK_START,
  weekEnd: SAMPLE_WEEK_START + WEEK,
  code: {
    spendUsd: 1284.32,
    spendDeltaPct: 0.08,
    spendIsPartlyEstimated: false,
    unpricedModelCount: 0,
    commits: 96,
    prs: 14,
    engagedHours: 142.5,
    activeUsers: 18,
  },
  cowork: {
    classifiedEvents: 640,
    eventsDeltaPct: 0.04,
    tier3Count: 52,
    tier3DeltaPct: -0.1,
    activeUsers: 24,
  },
  anomaly: { title: 'Sample anomaly: unusual spend spike on a shared repo', severity: 'medium', occurredAt: SAMPLE_WEEK_START + DAY, userLinked: false },
  briefingExcerpt: 'This is sample briefing text illustrating where the latest Developer Pulse weekly briefing excerpt appears in the digest.',
  useCases: {
    atRisk: [{ title: 'Sample use case: contract triage', owner: 'sample-owner', quietWeeks: 2 }],
    newlyAdopted: ['Sample use case: meeting notes summarisation'],
    newlyAtRisk: [],
  },
  coaching: [{ dept: 'Sample department: Finance', count: 3 }],
};

export const SAMPLE_WATERMARK = 'SAMPLE DATA: no completed-week data yet, this preview uses illustrative numbers';
