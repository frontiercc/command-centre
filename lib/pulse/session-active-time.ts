// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Gap-based active-time helper (Workflow Impact follow-up).
 *
 * Wall-clock session duration (last event minus first event) badly overstates
 * work for long-lived/persistent Cowork sessions that can sit open across
 * days or weeks between messages — a real production use case measured
 * 6,885.9 "hours" of measured session time this way (a long-lived scheduled
 * session, not a person working non-stop). Active time instead sums only the
 * gaps between events that plausibly reflect someone actually working.
 *
 * Definition (chosen option): a session's active time is the sum of gaps
 * between consecutive event timestamps where the gap is <= idleGapS (default
 * 30 minutes); a gap larger than that contributes nothing (treated as idle
 * time, not work); a single-event (or zero-event) session contributes 0 —
 * honest and conservative. This is deliberately a floor, not an estimate: the
 * violet "estimated" figures elsewhere in the product remain the comparator,
 * and this measured figure is never inflated to try to match them.
 *
 * The event timestamps fed into this function are NOT the same set on both
 * surfaces, and the set itself is what defines the metric:
 *   - Cowork (lib/pulse/cowork/session-aggregator.ts): every OTel
 *     cowork_messages row for the session — cowork_api_request,
 *     cowork_tool_metadata, AND cowork_user_message — regardless of type.
 *   - Code (lib/pulse/code/aggregator.ts): every code_assistant_meta row
 *     for the session PLUS every code_user_message row (cowork_messages,
 *     surface='code').
 * A session with denser event capture (more distinct logged events per unit
 * of real time — e.g. an integration that emits a tool_metadata row per tool
 * call rather than one per turn) will mechanically read a HIGHER active time
 * for the same amount of real work, because more of the real elapsed time
 * gets covered by a <=30-minute gap between two logged events. This is not a
 * bug to fix here — it's an inherent property of a gap-based measure derived
 * from event timestamps rather than a continuous clock — but it does mean
 * active_secs is not directly comparable across sessions/surfaces with
 * meaningfully different event-emission density.
 */

/** Idle threshold in seconds: a gap this long or shorter counts as active time. */
export const IDLE_GAP_SECS = 1800;

/**
 * Sum the gaps between consecutive event timestamps that are <= idleGapS.
 * Timestamps need not arrive sorted or de-duplicated — sorted internally;
 * two equal timestamps produce a zero-length gap, which is harmless (adds 0)
 * rather than an error.
 */
export function activeSecondsFromTimestamps(timestamps: number[], idleGapS: number = IDLE_GAP_SECS): number {
  if (timestamps.length < 2) return 0;
  const sorted = [...timestamps].sort((a, b) => a - b);
  let total = 0;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap <= idleGapS) total += gap;
  }
  return total;
}
