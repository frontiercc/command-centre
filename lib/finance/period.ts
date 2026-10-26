// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/** Calendar-month period helpers (UTC, epoch seconds). period = 'YYYY-MM'. */
export function monthBounds(period: string): { start: number; end: number } {
  const [y, m] = period.split('-').map(Number);
  const start = Date.UTC(y, m - 1, 1) / 1000;
  const end = Date.UTC(y, m, 1) / 1000; // first day of next month
  return { start, end };
}
export function currentPeriod(nowS: number): string {
  const d = new Date(nowS * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
export function isCurrentMonth(period: string, nowS: number): boolean {
  return period === currentPeriod(nowS);
}
