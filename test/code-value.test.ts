// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { resolveCalibrations, calibrationValues, computeValueEstimate } from '@/lib/pulse/code/value';

const fromData = { activeUsers: 71, annualSpend: 113779 };
const noOverrides = { codeValueLiftPct: '', codeValueLoadedComp: '', codeValueCodingHrs: '', codeValueTeamSize: '', codeValueAnnualSpend: '' };

describe('resolveCalibrations', () => {
  it('uses from_data for team size + annual spend when no override', () => {
    const r = resolveCalibrations(noOverrides, fromData);
    expect(r.teamSize).toEqual({ value: 71, provenance: 'from_data' });
    expect(r.annualSpend).toEqual({ value: 113779, provenance: 'from_data' });
    expect(r.liftPct).toEqual({ value: 30, provenance: 'default' });
    expect(r.loadedComp).toEqual({ value: 300000, provenance: 'default' });
    expect(r.codingHrs).toEqual({ value: 15, provenance: 'default' });
  });
  it('marks overridden fields as edited', () => {
    const r = resolveCalibrations({ ...noOverrides, codeValueLiftPct: '22', codeValueTeamSize: '50' }, fromData);
    expect(r.liftPct).toEqual({ value: 22, provenance: 'edited' });
    expect(r.teamSize).toEqual({ value: 50, provenance: 'edited' });
  });
  it('marks override equal to default as edited', () => {
    const r = resolveCalibrations({ ...noOverrides, codeValueLiftPct: '30' }, fromData);
    expect(r.liftPct).toEqual({ value: 30, provenance: 'edited' });
  });
});

describe('computeValueEstimate', () => {
  it('Value = team × lift × comp (hours cancel)', () => {
    const e = computeValueEstimate({ teamSize: 71, liftPct: 30, loadedComp: 300000, codingHrs: 15, annualSpend: 113779 });
    expect(e.hasData).toBe(true);
    expect(Math.round(e.valueAnnual)).toBe(6390000);            // 71 * 0.30 * 300000
    expect(Math.round(e.timeRecoveredHours)).toBe(16614);       // 71 * 15 * 52 * 0.30
    expect(Math.round(e.netValue)).toBe(6276221);               // value - spend
    expect(e.returnMultiple).toBeCloseTo(6390000 / 113779, 2);
  });
  it('returnMultiple null when spend is 0', () => {
    const e = computeValueEstimate({ teamSize: 71, liftPct: 30, loadedComp: 300000, codingHrs: 15, annualSpend: 0 });
    expect(e.returnMultiple).toBeNull();
    expect(e.valueAnnual).toBeGreaterThan(0);
  });
  it('hasData false when team size or lift is 0', () => {
    expect(computeValueEstimate({ teamSize: 0, liftPct: 30, loadedComp: 300000, codingHrs: 15, annualSpend: 100 }).hasData).toBe(false);
    expect(computeValueEstimate({ teamSize: 71, liftPct: 0, loadedComp: 300000, codingHrs: 15, annualSpend: 100 }).hasData).toBe(false);
  });
});

describe('calibrationValues round-trip', () => {
  it('extracts values from resolved calibrations', () => {
    const r = resolveCalibrations(noOverrides, fromData);
    const c = calibrationValues(r);
    expect(c.teamSize).toBe(71);
    expect(c.liftPct).toBe(30);
    expect(c.loadedComp).toBe(300000);
    expect(c.codingHrs).toBe(15);
    expect(c.annualSpend).toBe(113779);
  });
});
