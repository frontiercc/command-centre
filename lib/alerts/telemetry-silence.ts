// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Telemetry-silence rule — pure, no database.
 *
 * A surface that has sent telemetry before raises an alert once it has sent
 * nothing for `hours` WORKING hours: Monday to Friday, inside the hub's working
 * day, in the hub's own time zone. Nights and weekends never count, so a quiet
 * Friday evening is not a Monday-morning alert.
 *
 * Threshold measured on 14 days of real telemetry:
 * the longest gap inside UK working hours was 1.5 h for Cowork, 1.5 h for
 * Claude Code and 1.0 h for Claude Code metrics, so 3 h would have raised
 * nothing. Off on a hub with `hours` = 0 (a demo hub, for example: its data is
 * seeded, not received, and its Code gaps reach 3.9 h inside working hours).
 */

export interface SilenceSettings {
  /** Working hours of silence before alerting. 0 = off. */
  hours: number;
  timeZone: string;
  /** Working day, local hours: start inclusive, end exclusive. */
  startHour: number;
  endHour: number;
}

export const SILENCE_DEFAULTS: SilenceSettings = { hours: 3, timeZone: 'Europe/London', startHour: 8, endHour: 18 };

/** A surface silent for longer than this has already been alerted on; never alert first now. */
export const SILENCE_LOOKBACK_SECS = 14 * 86400;
const STEP_SECS = 300;

export interface SilenceSurface {
  key: string;
  label: string;
  /** When the hub last received anything for this surface (epoch seconds), or null if never. */
  lastReceivedAt: number | null;
}

export interface SilenceAlert {
  rule: 'telemetry_silence';
  subject: string;
  since: number;
  title: string;
  explanation: string;
}

/** Pure: 'HH-HH' → hours, or null when malformed. */
export function parseWorkHours(text: string | null | undefined): { startHour: number; endHour: number } | null {
  const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(text ?? '');
  if (!m) return null;
  const startHour = Number(m[1]);
  const endHour = Number(m[2]);
  if (startHour < 0 || endHour > 24 || startHour >= endHour) return null;
  return { startHour, endHour };
}

export function isValidTimeZone(tz: string | null | undefined): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Settings from stored config strings; anything malformed falls back to the default. */
export function silenceSettingsFrom(raw: { hours?: string; timeZone?: string; workHours?: string }): SilenceSettings {
  const h = Number(raw.hours);
  const work = parseWorkHours(raw.workHours);
  return {
    hours: raw.hours !== undefined && raw.hours !== '' && Number.isFinite(h) && h >= 0 ? h : SILENCE_DEFAULTS.hours,
    timeZone: isValidTimeZone(raw.timeZone) ? (raw.timeZone as string) : SILENCE_DEFAULTS.timeZone,
    startHour: work?.startHour ?? SILENCE_DEFAULTS.startHour,
    endHour: work?.endHour ?? SILENCE_DEFAULTS.endHour,
  };
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function localParts(epochS: number, timeZone: string): { weekday: string; hour: number } {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', hour: '2-digit', hourCycle: 'h23' });
    formatters.set(timeZone, f);
  }
  let weekday = '';
  let hour = 0;
  for (const p of f.formatToParts(new Date(epochS * 1000))) {
    if (p.type === 'weekday') weekday = p.value;
    if (p.type === 'hour') hour = Number(p.value);
  }
  return { weekday, hour };
}

/**
 * Pure: working seconds between two instants (Mon–Fri, local [startHour, endHour)),
 * counted in 5-minute steps — ample for an hours-scale threshold.
 */
export function workingSecondsBetween(fromS: number, toS: number, s: Pick<SilenceSettings, 'timeZone' | 'startHour' | 'endHour'>): number {
  let total = 0;
  for (let t = fromS; t < toS; t += STEP_SECS) {
    const { weekday, hour } = localParts(t, s.timeZone);
    if (weekday === 'Sat' || weekday === 'Sun') continue;
    if (hour < s.startHour || hour >= s.endHour) continue;
    total += Math.min(STEP_SECS, toS - t);
  }
  return total;
}

const pad = (n: number) => String(n).padStart(2, '0');
const workDayText = (s: SilenceSettings) => `Monday to Friday, ${pad(s.startHour)}:00 to ${pad(s.endHour)}:00 ${s.timeZone} time`;

function fmtLocal(epochS: number, timeZone: string): string {
  return new Date(epochS * 1000).toLocaleString('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Pure: which surfaces have been silent for too long. */
export function planSilenceAlerts(surfaces: SilenceSurface[], nowS: number, s: SilenceSettings): SilenceAlert[] {
  if (!(s.hours > 0)) return [];
  const out: SilenceAlert[] = [];
  for (const sf of surfaces) {
    if (sf.lastReceivedAt === null) continue; // never used here: nothing to go quiet
    const last = sf.lastReceivedAt;
    if (nowS - last > SILENCE_LOOKBACK_SECS) continue;
    const working = workingSecondsBetween(last, nowS, s);
    if (working < s.hours * 3600) continue;
    const h = Math.floor(working / 3600);
    out.push({
      rule: 'telemetry_silence',
      subject: sf.key,
      since: last,
      title: `No ${sf.label} telemetry for ${h} working hours`,
      explanation: `The hub has received nothing from ${sf.label} since ${fmtLocal(last, s.timeZone)}: ${h} working hours (${workDayText(s)}). Telemetry that is not received cannot be recovered later. Check the OTel collector, that the hub is reachable from it, and the clients' OTel settings. See System health on /admin/system.`,
    });
  }
  return out;
}
