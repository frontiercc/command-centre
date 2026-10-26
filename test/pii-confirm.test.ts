// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { parseVerdict, parseVerdictResult } from '../lib/pii/confirm';

describe('parseVerdict', () => {
  it('reads an explicit dismissal', () => {
    expect(parseVerdict('{"verdict":"dismissed","reason":"a Salesforce id"}')).toBe('dismissed');
  });
  it('reads an explicit confirmation', () => {
    expect(parseVerdict('{"verdict":"confirmed","reason":"a real NINO"}')).toBe('confirmed');
  });

  // Every failure mode must land on 'confirmed' — a check can only ever
  // suppress an alert by saying so explicitly.
  it('confirms on null', () => expect(parseVerdict(null)).toBe('confirmed'));
  it('confirms on undefined', () => expect(parseVerdict(undefined)).toBe('confirmed'));
  it('confirms on an empty string', () => expect(parseVerdict('')).toBe('confirmed'));
  it('confirms on unparseable text', () => expect(parseVerdict('I think not')).toBe('confirmed'));
  it('confirms on valid JSON with no verdict field', () => {
    expect(parseVerdict('{"reason":"unsure"}')).toBe('confirmed');
  });
  it('confirms on an unexpected verdict value', () => {
    expect(parseVerdict('{"verdict":"maybe"}')).toBe('confirmed');
  });
  it('confirms on a JSON array', () => expect(parseVerdict('[1,2,3]')).toBe('confirmed'));
  it('confirms on JSON null', () => expect(parseVerdict('null')).toBe('confirmed'));
  it('is case-sensitive — only the exact token dismisses', () => {
    expect(parseVerdict('{"verdict":"DISMISSED"}')).toBe('confirmed');
  });
});

describe('parseVerdictResult', () => {
  it('returns the model reason alongside the verdict', () => {
    expect(parseVerdictResult('{"verdict":"dismissed","reason":"a purchase order reference, not a NI number"}'))
      .toEqual({ verdict: 'dismissed', reason: 'a purchase order reference, not a NI number' });
  });
  it('returns a null reason when there is none', () => {
    expect(parseVerdictResult('{"verdict":"confirmed"}')).toEqual({ verdict: 'confirmed', reason: null });
    expect(parseVerdictResult('{"verdict":"confirmed","reason":"   "}')).toEqual({ verdict: 'confirmed', reason: null });
    expect(parseVerdictResult('{"verdict":"confirmed","reason":42}')).toEqual({ verdict: 'confirmed', reason: null });
  });
  it('caps a runaway reason so it cannot bloat the stored row', () => {
    const r = parseVerdictResult(JSON.stringify({ verdict: 'dismissed', reason: 'x'.repeat(5000) }));
    expect(r.reason).toHaveLength(300);
  });
  it('still confirms with a null reason on every failure path', () => {
    for (const bad of [null, undefined, '', 'not json', '[1,2]', 'null', '{"reason":"orphan"}']) {
      expect(parseVerdictResult(bad as string | null | undefined)).toEqual({ verdict: 'confirmed', reason: null });
    }
  });
});

describe('the stored reason never carries the matched value', () => {
  it('masks a value the model quoted despite being told not to', () => {
    const r = parseVerdictResult(JSON.stringify({
      verdict: 'dismissed',
      reason: 'AB123456C is a warehouse order reference, not a National Insurance number',
    }));
    expect(r.verdict).toBe('dismissed');
    expect(r.reason).not.toContain('AB123456C');
    // The reasoning itself must survive — masking the value is not censoring the answer.
    expect(r.reason).toContain('warehouse order reference');
  });

  it('leaves a reason with no value in it untouched', () => {
    const clean = 'a software version string, not an IP address';
    expect(parseVerdictResult(JSON.stringify({ verdict: 'dismissed', reason: clean })).reason).toBe(clean);
  });
});
