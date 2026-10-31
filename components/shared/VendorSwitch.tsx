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
export function VendorSwitch({ vendor, onChange, openaiPresent }: {
  vendor: Vendor;
  onChange: (v: Vendor) => void;
  openaiPresent: boolean;
}) {
  if (!openaiPresent && vendor === 'all') return null;
  return (
    <Segmented
      label="Show products from"
      options={VENDORS.map(v => ({ value: v, label: VENDOR_LABELS[v] }))}
      value={vendor}
      onChange={onChange}
    />
  );
}

/** "Claude 12 · OpenAI 4" under a figure in the All view. */
export function formatSplit(s: Pick<VendorSplit, 'claude' | 'openai'>): string {
  const n = (v: number) => v.toLocaleString('en-GB');
  return `Claude ${n(s.claude)} · OpenAI ${n(s.openai)}`;
}
