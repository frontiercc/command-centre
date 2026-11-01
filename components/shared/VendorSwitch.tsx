// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

// The All / Claude / OpenAI switch shared by the dashboard, Work Pulse and
// Developer Pulse. One remembered choice per browser, so a view picked on one
// page carries to the others. An install with only OpenAI connected has no
// switch: every page shows the OpenAI view.
import { useEffect, useState } from 'react';
import { Segmented } from '@/components/precision/ui';
import { VENDORS, VENDOR_LABELS, parseVendor, type Vendor, type VendorSplit } from '@/lib/dashboard/vendor';
import { isOpenAiOnly, type ConnectedProducts } from '@/lib/sources/connected-shared';
import { fetchConfigOnce } from '@/lib/client/config-once';

const VENDOR_KEY = 'ccc-dashboard-vendor';
const CONNECTED_KEY = 'ccc-connected-products';

// One read per page load (lib/client/config-once.ts). The last answer is kept
// in the browser, so a returning visitor's first render is already right.
function readStoredConnected(): ConnectedProducts | null {
  try {
    const v = JSON.parse(window.localStorage.getItem(CONNECTED_KEY) || 'null');
    return v && typeof v.claude === 'boolean' && typeof v.openai === 'boolean' ? v : null;
  } catch { return null; }
}
function fetchConnected(): Promise<ConnectedProducts | null> {
  return fetchConfigOnce().then((d) => {
    const c = d?.connectedProducts as ConnectedProducts | undefined;
    if (!c || typeof c.claude !== 'boolean' || typeof c.openai !== 'boolean') return null;
    try { window.localStorage.setItem(CONNECTED_KEY, JSON.stringify(c)); } catch { /* not remembered */ }
    return c;
  });
}

/** Which vendors are connected; null until known (no stored answer yet). */
export function useConnectedProducts(): ConnectedProducts | null {
  const [connected, setConnected] = useState<ConnectedProducts | null>(() =>
    typeof window === 'undefined' ? null : readStoredConnected());
  useEffect(() => {
    let live = true;
    fetchConnected().then((c) => { if (live && c) setConnected(c); });
    return () => { live = false; };
  }, []);
  return connected;
}

/** True when OpenAI is connected and Claude is not (lib/sources/connected-shared.ts). */
export function useOpenAiOnly(): boolean {
  return isOpenAiOnly(useConnectedProducts());
}

export function useVendor(): [Vendor, (v: Vendor) => void] {
  const [vendor, setVendorState] = useState<Vendor>(() => {
    try { return typeof window === 'undefined' ? 'all' : parseVendor(window.localStorage.getItem(VENDOR_KEY)); } catch { return 'all'; }
  });
  const openaiOnly = useOpenAiOnly();
  const setVendor = (v: Vendor) => {
    setVendorState(v);
    try { window.localStorage.setItem(VENDOR_KEY, v); } catch { /* not remembered */ }
  };
  return [openaiOnly ? 'openai' : vendor, setVendor];
}

/** Shown once both vendors have data, or while a vendor view is still chosen. */
export function VendorSwitch({ vendor, onChange, openaiPresent, labels = VENDOR_LABELS }: {
  vendor: Vendor;
  onChange: (v: Vendor) => void;
  openaiPresent: boolean;
  /** Work Pulse passes WORK_PULSE_VENDOR_LABELS (All / Claude / ChatGPT). */
  labels?: Record<Vendor, string>;
}) {
  const openaiOnly = useOpenAiOnly();
  if (openaiOnly) return null;
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
