// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import AskChat from '@/components/ask/AskChat';
import { currentPageNote, useAskAvailable } from '@/components/ask/useAskAvailable';
import { VENDOR_KEY } from '@/components/shared/VendorSwitch';
import { Tag } from '@/components/precision/ui';

/**
 * The slide-out Ask the data panel, opened from the top bar on any page (admins, when it is on).
 * It passes the current page, so "this page" questions make sense. Mounted once in the root layout.
 */
export default function AskDrawer() {
  const available = useAskAvailable();
  const pathname = usePathname() ?? '/';
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState<string | undefined>();
  // A fresh conversation each time the drawer opens.
  const [session, setSession] = useState(0);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const q = (e as CustomEvent<{ question?: string }>).detail?.question;
      setQuestion(q);
      setSession(s => s + 1);
      setOpen(true);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('ask:open', onOpen);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('ask:open', onOpen); window.removeEventListener('keydown', onKey); };
  }, []);

  if (!available || !open || pathname === '/ask') return null;
  // Read when a question is asked, so it matches what the page shows at that moment.
  const pageNote = () => {
    let vendor: string | null = null;
    try { vendor = window.localStorage.getItem(VENDOR_KEY); } catch { /* All */ }
    return currentPageNote(vendor);
  };
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/20" onClick={() => setOpen(false)}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Ask the data"
        className="h-full w-full max-w-[460px] bg-white border-l border-[#EAEAEA] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[#EAEAEA]">
          <h2 className="m-0 text-[14px] font-semibold text-[#0A0A0A]">Ask the data</h2>
          <Tag tone="warn">Preview</Tag>
          <Tag>Admin</Tag>
          <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="ml-auto text-[#666666] hover:text-[#0A0A0A] px-1 text-[18px] leading-none">×</button>
        </div>
        <p className="m-0 px-4 pt-2 text-[12px] text-[#8F8F8F]">In preview: answers may be incomplete, so check the linked page before acting on a figure.</p>
        <div className="flex-1 min-h-0">
          <AskChat key={session} initialQuestion={question} page={pathname} pageNote={pageNote} compact onNavigate={() => setOpen(false)} />
        </div>
      </aside>
    </div>
  );
}
