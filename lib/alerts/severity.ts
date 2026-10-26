// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Single source for alert severity ordering. Used by the Weekly Digest's
 * top-anomaly pick (lib/digest/build.ts) and the high-priority Slack
 * notifier (lib/alerts/notify-slack.ts), so both agree on ranking without
 * duplicating it.
 */
export const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

export function severityAtLeast(severity: string, floor: 'low' | 'medium' | 'high' | 'critical'): boolean {
  return (SEVERITY_RANK[severity] ?? 0) >= SEVERITY_RANK[floor];
}
