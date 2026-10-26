// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0
// Some icon drawings in this file are from Heroicons (MIT); see THIRD-PARTY-NOTICES.md.

// Department Process Transformation — the draft-canvas modal opened
// from a DeptProcessBoxes title/Open link on app/use-cases/page.tsx. Shows
// what was measured from telemetry ("What we observed"), then confirms via
// PATCH .../suggestions/[id] {action:'add'} (no slot fields:
// owner/baseline/measure-of-success are edited on
// the use case detail page after confirming, not collected in this modal) or
// dismisses via {action:'dismiss'}.
'use client';

import type { ProcessCanvas } from '@/lib/usecases/suggestion-store';
import { SubHead, Tag, B, cx } from '@/components/precision/ui';

// Kept local (not imported from app/use-cases/page.tsx) so this component has
// no dependency on the page module — see suggestion-store for ProcessCanvas.
// Structurally identical to the page's own SuggestionDraft interface.
export interface SuggestionDraft {
  id: string;
  title: string;
  description: string | null;
  matchingRule: { skills: string[]; connectors: string[]; taskTypes: string[]; departments: string[] };
  evidence: { distinctUsers: number; sessionCount: number; departments: string[] };
  department: string | null;
  canvas: ProcessCanvas | null;
}

interface Fact {
  label: string;
  value: string;
  sub?: string;
}

function buildFacts(canvas: ProcessCanvas): Fact[] {
  const facts: Fact[] = [
    ...(canvas.departments?.length ? [{ label: 'Departments', value: canvas.departments.join(', ') }] : []),
    {
      label: 'People',
      value: canvas.people === 1 ? '1 person (key-person dependency)' : `${canvas.people} people`,
    },
    {
      label: 'Sessions',
      value: `${canvas.sessions}`,
      sub: `in ${canvas.windowDays} days`,
    },
    { label: 'Rhythm', value: canvas.rhythm.display },
  ];
  if (canvas.systems.length > 0) {
    facts.push({ label: 'Systems seen', value: canvas.systems.join(' · ') });
  }
  if (canvas.tierNote) {
    facts.push({ label: 'Delegation depth', value: canvas.tierNote });
  }
  if (canvas.activeHours != null) {
    facts.push({ label: 'Time observed', value: `≈${canvas.activeHours} hrs`, sub: 'active work in sessions' });
  }
  return facts;
}

export default function ProcessCanvasCard({
  suggestion,
  busy,
  onConfirm,
  onDismiss,
  onClose,
  position,
  onPrev,
  onNext,
}: {
  suggestion: SuggestionDraft;
  busy: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
  onClose: () => void;
  /** When the department holds several open canvases: this one's place in the
   *  walk ("2 of 5") plus Previous/Next paging — a box promising five
   *  opportunities must let the reader see all five.
   *  All three absent for a single canvas. */
  position?: { index: number; total: number };
  onPrev?: () => void;
  onNext?: () => void;
}) {
  const canvas = suggestion.canvas;
  const facts = canvas ? buildFacts(canvas) : [];

  return (
    <div
      className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={suggestion.title}
        className="bg-white max-w-2xl w-full rounded-[14px] border border-[#EAEAEA] max-h-[85vh] overflow-y-auto relative flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-x-3 gap-y-1 flex-wrap px-4 py-3 border-b border-[#EAEAEA] pr-12">
          <Tag tone="judged">{suggestion.department ?? 'Across departments'} · Process opportunity</Tag>
          {canvas && (
            <span className="text-[13px] text-[#8F8F8F]">
              {suggestion.department
                ? <>Drafted from this department&apos;s own activity over the last {canvas.windowDays} days</>
                : <>Drafted from activity in several departments over the last {canvas.windowDays} days</>}
            </span>
          )}
          {position && (
            <span className="flex items-center gap-3 ml-auto">
              <button
                type="button"
                onClick={onPrev}
                disabled={!onPrev || busy}
                className={cx(B.link, 'disabled:text-[#B3B3B3] disabled:no-underline')}
              >
                Previous
              </button>
              <span className="text-[13px] text-[#8F8F8F] tabular-nums">{position.index} of {position.total}</span>
              <button
                type="button"
                onClick={onNext}
                disabled={!onNext || busy}
                className={cx(B.link, 'disabled:text-[#B3B3B3] disabled:no-underline')}
              >
                Next
              </button>
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute top-2.5 right-3 w-7 h-7 rounded-[10px] inline-flex items-center justify-center text-[#8F8F8F] hover:bg-[#F2F2F2] hover:text-[#0A0A0A]"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-4 flex flex-col gap-4">
          <h2 className="m-0 text-[18px] font-semibold tracking-[-0.02em] text-[#0A0A0A]">{suggestion.title}</h2>

          {canvas && (
            <p className="m-0 text-[14px] leading-6 text-[#333333] max-w-[66ch]">{canvas.story}</p>
          )}

          {canvas && (
            <div>
              <SubHead>The opportunity</SubHead>
              <p className="m-0 text-[14px] leading-6 text-[#333333] max-w-[66ch]">{canvas.valueHypothesis}</p>
            </div>
          )}

          {canvas && facts.length > 0 && (
            <div>
              <SubHead right={<Tag tone="measured">Measured</Tag>}>What we observed</SubHead>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-px bg-[#EAEAEA] border border-[#EAEAEA] rounded-[14px] overflow-hidden">
                {facts.map(fact => (
                  <div key={fact.label} className="bg-white p-3 flex flex-col gap-0.5 min-w-0">
                    <span className="text-[13px] text-[#666666]">{fact.label}</span>
                    <span className="text-[14px] font-semibold text-[#0A0A0A] tabular-nums break-words">{fact.value}</span>
                    {fact.sub && <span className="text-[13px] text-[#8F8F8F]">{fact.sub}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          <p className="m-0 text-[13px] text-[#8F8F8F]">
            Owner, baseline and measure of success are added on the use case page after confirming.
          </p>
        </div>

        <div className="flex items-center gap-2 px-4 py-3 border-t border-[#F2F2F2]">
          <button type="button" onClick={onConfirm} disabled={busy} className={B.primary}>
            Confirm
          </button>
          <button type="button" onClick={onDismiss} disabled={busy} className={B.secondary}>
            Dismiss
          </button>
          <button type="button" onClick={onClose} disabled={busy} className={cx(B.link, 'ml-1 !text-[#666666]')}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
