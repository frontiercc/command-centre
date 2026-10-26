// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Developer Pulse "Value (estimate)" math — pure, deterministic, unit-tested.
 *
 * Headline reduces to a clean identity: valuing recovered coding hours at each
 * engineer's coding-hour cost, the hours/weeks cancel, leaving
 *   Value = team_size × lift% × loaded_comp.
 * This is the AGGRESSIVE end of the estimate (full comp loaded onto coding hours
 * only) — matches Claude Desktop's native Value tab; the UI must state the
 * assumption. The figure is an ESTIMATE, presented separately from measured data.
 */

export type Provenance = 'from_data' | 'default' | 'edited';

export interface Calibrations {
  teamSize: number;
  liftPct: number;      // percent, e.g. 30
  loadedComp: number;   // USD/yr per engineer
  codingHrs: number;    // hrs/week
  annualSpend: number;  // USD/yr
}

export interface ResolvedField { value: number; provenance: Provenance; }
export interface ResolvedCalibrations {
  teamSize: ResolvedField;
  liftPct: ResolvedField;
  loadedComp: ResolvedField;
  codingHrs: ResolvedField;
  annualSpend: ResolvedField;
}

interface ValueConfig {
  codeValueLiftPct: string;
  codeValueLoadedComp: string;
  codeValueCodingHrs: string;
  codeValueTeamSize: string;
  codeValueAnnualSpend: string;
}

const DEFAULTS = { liftPct: 30, loadedComp: 300000, codingHrs: 15 };

function field(override: string, fallback: number, fallbackProv: Provenance): ResolvedField {
  const t = override.trim();
  if (t !== '') {
    const v = parseFloat(t);
    if (!isNaN(v)) {
      return { value: v, provenance: 'edited' };
    }
  }
  return { value: fallback, provenance: fallbackProv };
}

export function resolveCalibrations(config: ValueConfig, fromData: { activeUsers: number; annualSpend: number }): ResolvedCalibrations {
  return {
    teamSize: field(config.codeValueTeamSize, fromData.activeUsers, 'from_data'),
    annualSpend: field(config.codeValueAnnualSpend, fromData.annualSpend, 'from_data'),
    liftPct: field(config.codeValueLiftPct, DEFAULTS.liftPct, 'default'),
    loadedComp: field(config.codeValueLoadedComp, DEFAULTS.loadedComp, 'default'),
    codingHrs: field(config.codeValueCodingHrs, DEFAULTS.codingHrs, 'default'),
  };
}

export function calibrationValues(r: ResolvedCalibrations): Calibrations {
  return {
    teamSize: r.teamSize.value,
    liftPct: r.liftPct.value,
    loadedComp: r.loadedComp.value,
    codingHrs: r.codingHrs.value,
    annualSpend: r.annualSpend.value,
  };
}

export interface ValueEstimate {
  hasData: boolean;
  valueAnnual: number;
  timeRecoveredHours: number;
  netValue: number;
  returnMultiple: number | null;
}

export function computeValueEstimate(c: Calibrations): ValueEstimate {
  const lift = c.liftPct / 100;
  const valueAnnual = c.teamSize * lift * c.loadedComp;
  const timeRecoveredHours = c.teamSize * c.codingHrs * 52 * lift;
  const hasData = c.teamSize > 0 && lift > 0 && c.loadedComp > 0;
  return {
    hasData,
    valueAnnual,
    timeRecoveredHours,
    netValue: valueAnnual - c.annualSpend,
    returnMultiple: c.annualSpend > 0 ? valueAnnual / c.annualSpend : null,
  };
}
