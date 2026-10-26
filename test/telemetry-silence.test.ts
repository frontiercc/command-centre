// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Telemetry-silence rule (system-health spec part 4, rule (b)) — pure, no database.
import { describe, it, expect } from 'vitest';
import {
  planSilenceAlerts, workingSecondsBetween, parseWorkHours, silenceSettingsFrom, SILENCE_DEFAULTS,
  type SilenceSurface,
} from '@/lib/alerts/telemetry-silence';

const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const LON = SILENCE_DEFAULTS; // 3 working hours, Europe/London, 08–18
const surface = (lastReceivedAt: number | null, key = 'cowork', label = 'Cowork'): SilenceSurface => ({ key, label, lastReceivedAt });

describe('workingSecondsBetween', () => {
  it('counts only Monday to Friday inside the working day, in local time', () => {
    // Fri 2 Oct 2026 16:00 BST → Mon 5 Oct 10:00 BST = 2 h Friday + 2 h Monday.
    expect(workingSecondsBetween(at('2026-10-02T15:00:00Z'), at('2026-10-05T09:00:00Z'), LON)).toBe(4 * 3600);
  });
  it('a whole weekend counts nothing', () => {
    expect(workingSecondsBetween(at('2026-10-03T00:00:00Z'), at('2026-10-05T06:00:00Z'), LON)).toBe(0);
  });
  it('uses the hub time zone, not UTC', () => {
    // 07:00–09:00 UTC on a Wednesday in October = 08:00–10:00 BST (2 h) but 04:00–06:00 in São Paulo (0 h).
    const from = at('2026-09-30T07:00:00Z');
    const to = at('2026-09-30T09:00:00Z');
    expect(workingSecondsBetween(from, to, LON)).toBe(2 * 3600);
    expect(workingSecondsBetween(from, to, { ...LON, timeZone: 'America/Sao_Paulo' })).toBe(0);
  });
});

describe('planSilenceAlerts', () => {
  it('alerts once a surface has been quiet for the threshold in working hours', () => {
    const now = at('2026-09-30T12:00:00Z'); // Wed 13:00 BST
    expect(planSilenceAlerts([surface(at('2026-09-30T09:30:00Z'))], now, LON)).toEqual([]); // 2.5 h
    const p = planSilenceAlerts([surface(at('2026-09-30T09:00:00Z'))], now, LON); // 3 h
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ rule: 'telemetry_silence', subject: 'cowork', since: at('2026-09-30T09:00:00Z'), title: 'No Cowork telemetry for 3 working hours' });
    expect(p[0].explanation).toContain('Monday to Friday, 08:00 to 18:00 Europe/London time');
  });

  it('a quiet weekend is not a Monday-morning alert', () => {
    // Last event Fri 17:30 BST; Mon 09:00 BST = 0.5 + 1 = 1.5 working hours.
    expect(planSilenceAlerts([surface(at('2026-10-02T16:30:00Z'))], at('2026-10-05T08:00:00Z'), LON)).toEqual([]);
  });

  it('a surface never used on this hub never alerts', () => {
    expect(planSilenceAlerts([surface(null, 'code', 'Claude Code')], at('2026-09-30T12:00:00Z'), LON)).toEqual([]);
  });

  it('a surface quiet for over 14 days is not raised for the first time now', () => {
    expect(planSilenceAlerts([surface(at('2026-09-01T09:00:00Z'))], at('2026-09-30T12:00:00Z'), LON)).toEqual([]);
  });

  it('0 hours turns the rule off', () => {
    expect(planSilenceAlerts([surface(at('2026-09-20T09:00:00Z'))], at('2026-09-30T12:00:00Z'), { ...LON, hours: 0 })).toEqual([]);
  });

  it('checks each surface separately', () => {
    const now = at('2026-09-30T12:00:00Z');
    const p = planSilenceAlerts([
      surface(at('2026-09-30T11:50:00Z')),
      surface(at('2026-09-29T12:00:00Z'), 'code_metrics', 'Claude Code metrics'),
    ], now, LON);
    expect(p.map(x => x.subject)).toEqual(['code_metrics']);
    expect(p[0].title).toBe('No Claude Code metrics telemetry for 10 working hours');
  });
});

describe('settings', () => {
  it('parses a working day and rejects malformed ones', () => {
    expect(parseWorkHours('08-18')).toEqual({ startHour: 8, endHour: 18 });
    expect(parseWorkHours(' 9 - 17 ')).toEqual({ startHour: 9, endHour: 17 });
    expect(parseWorkHours('18-08')).toBeNull();
    expect(parseWorkHours('8am-6pm')).toBeNull();
    expect(parseWorkHours('')).toBeNull();
  });
  it('falls back to the defaults for blank or malformed values, and keeps 0', () => {
    expect(silenceSettingsFrom({ hours: '', timeZone: '', workHours: '' })).toEqual(SILENCE_DEFAULTS);
    expect(silenceSettingsFrom({ hours: 'x', timeZone: 'Mars/Olympus', workHours: 'nope' })).toEqual(SILENCE_DEFAULTS);
    expect(silenceSettingsFrom({ hours: '0', timeZone: 'America/Sao_Paulo', workHours: '09-18' }))
      .toEqual({ hours: 0, timeZone: 'America/Sao_Paulo', startHour: 9, endHour: 18 });
  });
});
