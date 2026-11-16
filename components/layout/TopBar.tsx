// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { usePrecision } from './ThemeContext';
import { crumbsFor, shortTitle } from '@/lib/nav/breadcrumb';
import { openAskDrawer, useAskAvailable } from '@/components/ask/useAskAvailable';

export default function TopBar({ title, subtitle }: { title: ReactNode; subtitle?: string }) {
  const precision = usePrecision();
  const pathname = usePathname() ?? '/';
  // Admins, when Ask the data is on: a button that opens the slide-out panel on any page.
  const askOk = useAskAvailable();

  // Precision theme: a slim breadcrumb bar, then the page heading on the grey page.
  if (precision) {
    const { trail, page } = crumbsFor(pathname);
    const heading: ReactNode = page ?? (typeof title === 'string' ? shortTitle(title, trail) : title);
    return (
      <>
        <header className="ccc-pbar">
          {trail.map(c => (
            <span key={c} className="ccc-pbar-crumb">
              <span className="ccc-pbar-muted">{c}</span>
              <span className="ccc-pbar-sep" aria-hidden="true">/</span>
            </span>
          ))}
          <span className="ccc-pbar-current">{heading}</span>
          {/* One chart colour (petrol) for measured and AI-judged alike; panels tag AI-judged figures. */}
          {askOk && pathname !== '/ask' && (
            <button type="button" onClick={() => openAskDrawer()} className="ml-auto shrink-0 whitespace-nowrap inline-flex items-center gap-1.5 text-[13px] font-medium px-2.5 py-1 rounded-[10px] border border-[#DADADA] bg-white text-[#0A0A0A] hover:bg-[#FAFAFA]">
              Ask the data
            </button>
          )}
        </header>
        <div className="ccc-ptitle">
          <h1>{heading}</h1>
          {subtitle && <p>{subtitle}</p>}
        </div>
      </>
    );
  }

  return (
    <header className="ccc-topbar bg-white border-b border-gray-200 px-8 py-5">
      <h2 className="text-xl font-semibold text-gray-900">{title}</h2>
      {subtitle && <p className="text-sm text-gray-500 mt-0.5">{subtitle}</p>}
    </header>
  );
}
