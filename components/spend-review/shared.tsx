// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { B, Notice } from '@/components/precision/ui';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** "2026-09" → "September 2026". */
export function monthName(period: string): string {
  const [y, m] = period.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

/** Last 12 calendar months in UTC, the period Anthropic's monthly limits reset on. */
export function monthOptions(): { value: string; label: string }[] {
  const now = new Date();
  const out: { value: string; label: string }[] = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const value = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const name = `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    out.push({ value, label: i === 0 ? `${name} (month to date)` : name });
  }
  return out;
}

export function MonthPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="inline-flex items-center gap-1.5 text-[13px] text-[#666666]">
      Month
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className={B.select}
        aria-label="Month"
      >
        {monthOptions().map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

export function money(n: number | null | undefined, currency = 'USD'): string {
  if (n === null || n === undefined) return '—';
  const digits = Math.abs(n) >= 100 ? 0 : 2;
  // "$28.89" as everywhere else in CCC; other currencies keep their own symbol.
  const locale = currency === 'USD' ? 'en-US' : 'en-GB';
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
  } catch {
    return `${currency} ${n.toFixed(digits)}`;
  }
}

export function pct(share: number | null | undefined): string {
  if (share === null || share === undefined) return '—';
  return `${Math.round(share * 100)}%`;
}

export { ukDate } from '@/lib/finance/spend-review-format';

export function duration(secs: number | null | undefined): string {
  if (secs === null || secs === undefined) return 'not measured';
  if (secs < 60) return secs > 0 ? '<1m' : '0m';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

export type LimitsStatus = 'not_configured' | 'ok' | 'invalid_key' | 'missing_scope' | 'not_available' | 'error';

/** One plain line explaining why Anthropic's limits are not showing. Null when they are. */
export function limitsNotice(status: LimitsStatus): string | null {
  switch (status) {
    case 'ok': return null;
    case 'not_configured':
      return "To see each person's Anthropic spend limit and their requests for more usage, add an Admin API key with the read:spend_limits scope under Admin → Access & Keys.";
    case 'missing_scope':
      return "The Admin API key can't read spend limits. It needs the read:spend_limits scope, a Claude Enterprise plan, and usage credits turned on for the organisation.";
    case 'invalid_key':
      return 'Anthropic rejected the Admin API key. Check it under Admin → Access & Keys.';
    case 'not_available':
      return 'Spend limits are not available for this Anthropic organisation.';
    default:
      return "Anthropic's spend limits could not be read just now. Try again in a few minutes.";
  }
}

export function LimitsNotice({ status }: { status: LimitsStatus }) {
  const text = limitsNotice(status);
  if (!text) return null;
  const isSetup = status === 'not_configured';
  return <Notice tone={isSetup ? 'info' : 'warn'}>{text}</Notice>;
}

/** Bar for share of a limit used. Amber at the near-limit share, red at or over the limit. */
export function LimitBar({ share, nearShare }: { share: number | null; nearShare: number }) {
  if (share === null) return <span className="text-[13px] text-[#8F8F8F]">No limit</span>;
  const colour = share >= 1 ? 'bg-[#D92D20]' : share >= nearShare ? 'bg-[#DC8A00]' : 'bg-[#05073F]';
  return (
    <div className="flex items-center gap-2 min-w-[120px]">
      <div className="flex-1 h-1 rounded-full bg-[#F2F2F2] overflow-hidden">
        <div className={`h-full rounded-full ${colour}`} style={{ width: `${Math.min(100, Math.round(share * 100))}%` }} />
      </div>
      <span className={`text-[13px] tabular-nums ${share >= nearShare ? 'font-medium text-[#0A0A0A]' : 'text-[#666666]'}`}>{pct(share)}</span>
    </div>
  );
}

/** "Updated 3 minutes ago · Refresh": results are kept for a few minutes rather than rebuilt on every load. */
export function UpdatedLine({ at, onRefresh, refreshing }: { at: number | undefined; onRefresh: () => void; refreshing: boolean }) {
  if (!at) return null;
  const mins = Math.max(0, Math.round((Date.now() / 1000 - at) / 60));
  const ago = mins === 0 ? 'just now' : mins === 1 ? '1 minute ago' : mins < 60 ? `${mins} minutes ago` : `${Math.round(mins / 60)} h ago`;
  return (
    <span className="text-[13px] text-[#8F8F8F]">
      Updated {ago} ·{' '}
      <button type="button" onClick={onRefresh} disabled={refreshing} className={B.link}>
        {refreshing ? 'Refreshing…' : 'Refresh'}
      </button>
    </span>
  );
}
