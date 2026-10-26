// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// OTI v2 interpretive status line.
// Pure + client-safe (no DB/IO) so every card that shows OTI renders
// identical copy. OTI is a TRAJECTORY signal; this describes direction of
// travel, never a cross-person ranking.

export interface OtiThresholds {
  /** "Meaningful progress" floor. */
  progress: number;
  /** "Significant uplift" floor. */
  uplift: number;
}

/** Provisional thresholds; stored in config `oti_thresholds`. */
export const DEFAULT_OTI_THRESHOLDS: OtiThresholds = { progress: 1.2, uplift: 1.5 };

export interface OtiStatus {
  label: string;
  tone: 'positive' | 'neutral' | 'watch';
}

interface OtiStatusOpts {
  /** Baseline still forming — the UI shows its own early-read copy, so no status here. */
  earlyRead?: boolean;
  /** The accuracy audit has NOT cleared its floor, so hold the interpretive copy. */
  underReview?: boolean;
}

const NEAR_ONE_LOW = 0.9;
const NEAR_ONE_HIGH = 1.1;
const DEEP_DELEGATION_DDS = 2.5;

/**
 * Interpret an OTI value into a plain-language status line.
 * Returns null when there is nothing to say (no value, or still in early read).
 *
 * `dds` is the delegation-depth score used only for the "started/operating
 * deep" reading (a deep operator sitting near 1.0 is sustaining the frontier,
 * not plateauing). Uses the current DDS available to the card.
 */
export function otiStatus(
  oti: number | null,
  dds: number | null,
  thresholds: OtiThresholds = DEFAULT_OTI_THRESHOLDS,
  opts: OtiStatusOpts = {},
): OtiStatus | null {
  if (oti === null) return null;
  if (opts.earlyRead) return null;
  // No confident interpretation until the classifier audit clears its floor.
  if (opts.underReview) return { label: 'Settling: accuracy under review', tone: 'neutral' };

  // A deep operator holding near their own baseline is sustaining the
  // frontier, NOT plateaued. This reading wins over the threshold branches.
  if (dds !== null && dds >= DEEP_DELEGATION_DDS && oti >= NEAR_ONE_LOW && oti <= NEAR_ONE_HIGH) {
    return { label: 'Sustained frontier operation', tone: 'positive' };
  }

  if (oti >= thresholds.uplift) return { label: 'Significant uplift', tone: 'positive' };
  if (oti >= thresholds.progress) return { label: 'Meaningful progress', tone: 'positive' };
  if (oti >= NEAR_ONE_LOW) return { label: 'Holding steady', tone: 'neutral' };
  return { label: 'Below baseline', tone: 'watch' };
}
