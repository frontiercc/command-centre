// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { B, cx } from '@/components/precision/ui';

interface Turn {
  question: string;
  answer?: string;
  outcome?: 'answered' | 'not_answerable' | 'refused' | 'capped' | 'error';
  sources?: Array<{ label: string; href: string }>;
  trimmed?: boolean;
  failed?: string;
}

/** An answer's **bold** phrases as bold, with no asterisks ever shown; everything else as text (never as HTML). */
function withBold(text: string): React.ReactNode[] {
  return text.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 === 1
    ? <b key={i} className="font-semibold">{part}</b>
    : part.replace(/\*\*/g, '')));
}

const EXAMPLES = [
  'How much have we spent on AI this month, and where could we save?',
  'Which department does the most deep work?',
  'How many critical alerts are open, and in which products?',
  'Which connectors are used most?',
];

/**
 * The conversation used by the Ask the data page and the drawer. Answers live only in this
 * component's state: the server returns them but never stores them.
 */
export default function AskChat({ initialQuestion, page, pageNote, compact = false, onNavigate }: {
  initialQuestion?: string;
  /** The page the person is on, so "this page" questions make sense. */
  page?: string;
  /** What the page is showing (its period, team and product filter), read when a question is asked. */
  pageNote?: () => string;
  compact?: boolean;
  /** Called when a source link is followed (the drawer closes). */
  onNavigate?: () => void;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const asked = useRef<string | null>(null);
  const end = useRef<HTMLDivElement>(null);

  const ask = async (q: string) => {
    const question = q.trim();
    if (!question) { setError('Type a question first.'); return; }
    if (busy) return;
    setError('');
    setBusy(true);
    setDraft('');
    const history = turns.filter(t => t.answer).map(t => ({ question: t.question }));
    setTurns(prev => [...prev, { question }]);
    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, history, page, pageNote: pageNote?.() || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      setTurns(prev => prev.map((t, i) => i === prev.length - 1
        ? (res.ok ? { ...t, answer: data.answer, outcome: data.outcome, sources: data.sources ?? [], trimmed: data.trimmed === true } : { ...t, failed: data.error ?? 'Something went wrong.' })
        : t));
    } catch {
      setTurns(prev => prev.map((t, i) => (i === prev.length - 1 ? { ...t, failed: "Couldn't reach Command Centre. Try again." } : t)));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (initialQuestion && asked.current !== initialQuestion) {
      asked.current = initialQuestion;
      void ask(initialQuestion);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuestion]);

  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [turns, busy]);

  return (
    <div className={cx('flex flex-col min-h-0', compact ? 'h-full' : '')}>
      <div className={cx('flex flex-col gap-4 overflow-y-auto', compact ? 'flex-1 px-4 py-4' : 'min-h-[240px]')}>
        {turns.length === 0 && (
          <div className="flex flex-col gap-2">
            <p className="m-0 text-[13px] text-[#666666]">Ask about usage, depth of work, spend, alerts, or skills and connectors. Every figure comes from the pages, and each answer links to them.</p>
            <div className="flex flex-col gap-1.5">
              {EXAMPLES.map(e => (
                <button key={e} type="button" onClick={() => void ask(e)} className="text-left text-[13px] text-[#1F6F8B] hover:underline">{e}</button>
              ))}
            </div>
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className="flex flex-col gap-2">
            <div className="self-end max-w-[85%] bg-[#F2F2F2] rounded-[12px] px-3 py-2 text-[14px] leading-5 text-[#0A0A0A]">{t.question}</div>
            {t.failed && <p className="m-0 text-[13px] text-[#B42318]">{t.failed}</p>}
            {!t.failed && t.answer === undefined && <p className="m-0 text-[13px] text-[#8F8F8F]">Looking that up…</p>}
            {t.answer !== undefined && (
              <div className="max-w-[95%] flex flex-col gap-1.5">
                <div className={cx('text-[14px] leading-[22px] whitespace-pre-line', t.outcome === 'answered' ? 'text-[#0A0A0A]' : 'text-[#666666]')}>{withBold(t.answer)}</div>
                {t.trimmed && <p className="m-0 text-[12px] text-[#8F8F8F]">Part of this answer was removed because its figures didn&apos;t check out against the pages.</p>}
                {!!t.sources?.length && (
                  <div className="flex flex-wrap gap-x-3 gap-y-1">
                    {t.sources.map(s => (
                      <Link key={s.href} href={s.href} onClick={onNavigate} className="text-[12px] font-medium text-[#1F6F8B] hover:underline">{s.label} →</Link>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
        {turns.length > 0 && !busy && (
          <button type="button" onClick={() => { setTurns([]); setError(''); }} className="self-start text-[13px] font-medium text-[#1F6F8B] hover:underline">
            ← Back to example questions
          </button>
        )}
        <div ref={end} />
      </div>
      <form
        className={cx('flex gap-2 items-start', compact ? 'border-t border-[#EAEAEA] px-4 py-3' : 'mt-4')}
        onSubmit={e => { e.preventDefault(); void ask(draft); }}
      >
        <div className="flex-1 flex flex-col gap-1">
          <input
            value={draft}
            onChange={e => { setDraft(e.target.value); if (error) setError(''); }}
            placeholder="Ask anything about usage, depth, spend or alerts"
            aria-label="Your question"
            maxLength={500}
            className={cx(B.input, 'w-full')}
            disabled={busy}
          />
          {error && <span className="text-[13px] text-[#B42318]">{error}</span>}
        </div>
        <button type="submit" className={B.primary} disabled={busy}>{busy ? 'Asking…' : 'Ask'}</button>
      </form>
    </div>
  );
}
