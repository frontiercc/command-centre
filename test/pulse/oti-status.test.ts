// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { otiStatus, DEFAULT_OTI_THRESHOLDS } from '@/lib/pulse/metrics/oti-status';

describe('otiStatus (OTI v2 interpretive status line, §1e/1g/1h)', () => {
  const T = DEFAULT_OTI_THRESHOLDS; // { progress: 1.2, uplift: 1.5 }

  it('returns null when OTI has no value', () => {
    expect(otiStatus(null, 2.0, T)).toBeNull();
  });

  it('returns null during early read (UI shows its own early-read copy)', () => {
    expect(otiStatus(1.4, 2.0, T, { earlyRead: true })).toBeNull();
  });

  it('§1h gate closed → "accuracy under review", regardless of value', () => {
    expect(otiStatus(1.6, 2.0, T, { underReview: true })?.label).toBe('Settling: accuracy under review');
  });

  it('§1e: a deep operator (DDS ≥ 2.5) sitting near 1.0 reads "Sustained frontier operation", not "plateaued"', () => {
    const s = otiStatus(1.0, 2.6, T);
    expect(s?.label).toBe('Sustained frontier operation');
    expect(s?.tone).toBe('positive');
  });

  it('at/above the uplift threshold → "Significant uplift"', () => {
    expect(otiStatus(1.5, 1.8, T)?.label).toBe('Significant uplift');
  });

  it('between progress and uplift → "Meaningful progress"', () => {
    expect(otiStatus(1.3, 1.8, T)?.label).toBe('Meaningful progress');
  });

  it('near 1.0 with shallow delegation → "Holding steady" (never "plateaued")', () => {
    const s = otiStatus(1.0, 1.4, T);
    expect(s?.label).toBe('Holding steady');
    expect(s?.label.toLowerCase()).not.toContain('plateau');
  });

  it('below baseline → "Below baseline", watch tone', () => {
    const s = otiStatus(0.7, 1.4, T);
    expect(s?.label).toBe('Below baseline');
    expect(s?.tone).toBe('watch');
  });

  it('§1e beats the uplift branch: deep operator near 1.0 is frontier, not scored on thresholds', () => {
    // DDS high + oti just below progress threshold but within the near-1.0 band.
    expect(otiStatus(1.05, 3.0, T)?.label).toBe('Sustained frontier operation');
  });
});
