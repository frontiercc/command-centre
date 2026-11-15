// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

/**
 * A folded section on the FinOps page: one row that opens in place. Closed by
 * default. The content is always mounted (hidden while closed), so a section
 * that fetches its own figures loads as it did before it was folded, and with
 * `hideWhenEmpty` a section that renders nothing (Model efficiency when it is
 * switched off) hides its row too.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { cx } from '@/components/precision/ui';

export default function FinopsFold({ title, tag, summary, hideWhenEmpty = false, children }: {
  title: string;
  /** A small tag beside the title, e.g. an Estimate tag. */
  tag?: ReactNode;
  /** A short caption at the right of the row. */
  summary?: ReactNode;
  /** Hide the whole row while the content renders nothing. */
  hideWhenEmpty?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [empty, setEmpty] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!hideWhenEmpty) return;
    const el = bodyRef.current;
    if (!el) return;
    const check = () => setEmpty(el.childElementCount === 0);
    check();
    const observer = new MutationObserver(check);
    observer.observe(el, { childList: true });
    return () => observer.disconnect();
  }, [hideWhenEmpty]);

  return (
    <section className={cx(empty && 'hidden')}>
      <h2 className="m-0">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(o => !o)}
          className="w-full flex items-center gap-2 px-4 py-3 bg-white border border-[#EAEAEA] rounded-[14px] text-left hover:bg-[#FAFAFA]"
        >
          <span className="text-[#B3B3B3] inline-block w-3 text-[13px]" aria-hidden="true">{open ? '▾' : '▸'}</span>
          <span className="text-[13px] font-semibold text-[#0A0A0A] leading-5">{title}</span>
          {tag}
          {summary && <span className="ml-auto text-[12px] font-normal text-[#8F8F8F]">{summary}</span>}
        </button>
      </h2>
      <div id={id} className={open ? 'pt-3' : 'hidden'}>
        <div ref={bodyRef} className="flex flex-col gap-4">{children}</div>
      </div>
    </section>
  );
}
