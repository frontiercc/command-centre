// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

// The All / Claude / OpenAI switch shared by the dashboard and Work Pulse.
// One remembered choice per browser, so a view picked on one page carries to
// the others.
import { useState } from 'react';
import { Segmented } from '@/components/precision/ui';
import { VENDORS, VENDOR_LABELS, parseVendor, type Vendor, type VendorSplit } from '@/lib/dashboard/vendor';

const VENDOR_KEY = 'ccc-dashboard-vendor';

export function useVendor(): [Vendor, (v: Vendor) => void] {
  const [vendor, setVendorState] = useState<Vendor>(() => {
    try { return typeof window === 'undefined' ? 'all' : parseVendor(window.localStorage.getItem(VENDOR_KEY)); } catch { return 'all'; }
  });
  const setVendor = (v: Vendor) => {
    setVendorState(v);
    try { window.localStorage.setItem(VENDOR_KEY, v); } catch { /* not remembered */ }
  };
  return [vendor, setVendor];
}

/** Shown once OpenAI data exists, or while a vendor view is still chosen. */
export function VendorSwitch({ vendor, onChange, openaiPresent, labels = VENDOR_LABELS }: {
  vendor: Vendor;
  onChange: (v: Vendor) => void;
  openaiPresent: boolean;
  /** Work Pulse passes WORK_PULSE_VENDOR_LABELS (All / Claude / ChatGPT). */
  labels?: Record<Vendor, string>;
}) {
  if (!openaiPresent && vendor === 'all') return null;
  return (
    <Segmented
      label="Show products from"
      options={VENDORS.map(v => ({ value: v, label: labels[v] }))}
      value={vendor}
      onChange={onChange}
    />
  );
}

/** "Claude 12 · OpenAI 4" under a figure in the All view ("ChatGPT" in Work Pulse). */
export function formatSplit(s: Pick<VendorSplit, 'claude' | 'openai'>, openaiLabel = 'OpenAI'): string {
  const n = (v: number) => v.toLocaleString('en-GB');
  return `Claude ${n(s.claude)} · ${openaiLabel} ${n(s.openai)}`;
}
