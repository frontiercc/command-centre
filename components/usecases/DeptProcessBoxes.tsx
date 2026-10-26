// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Department Process Transformation — the "by department" boxes
// rendered above the existing cross-department suggestions tray on
// app/use-cases/page.tsx. Pure presentational: count is derived from
// suggestions.length, never a separately-passed number, so it can never
// drift from what's actually rendered.
'use client';

import { TITLES_PER_GROUP } from '@/lib/usecases/dept-boxes';

interface DeptBoxSuggestion { id: string; title: string }
/** One box per department (groupDeptBoxes, lib/usecases/dept-boxes.ts). `groups` holds the
 *  Cowork and Claude Code lists, each ranked by people then sessions; `suggestions` is every
 *  suggestion in Review order. */
interface DeptBoxGroup { surface: string; label: string; suggestions: DeptBoxSuggestion[] }
interface DeptBox { department: string; key?: string; label?: string; suggestions: DeptBoxSuggestion[]; groups?: DeptBoxGroup[] }

export default function DeptProcessBoxes({
  boxes,
  onOpen,
}: {
  boxes: DeptBox[];
  onOpen: (id: string) => void;
}) {
  if (boxes.length === 0) return null;

  return (
    <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">
      {boxes.map(box => {
        const count = box.suggestions.length;
        const groups = box.groups && box.groups.length > 0 ? box.groups : [{ surface: '', label: '', suggestions: box.suggestions }];
        return (
          <div key={box.key ?? box.department} className="bg-white border border-[#EAEAEA] rounded-[14px] p-3.5 flex flex-col gap-2.5 hover:border-[#DADADA]">
            <div className="flex items-baseline gap-2">
              <span className="text-[15px] font-semibold text-[#0A0A0A] leading-snug">{box.label ?? box.department}</span>
              <span className="ml-auto text-[13px] text-[#8F8F8F] whitespace-nowrap tabular-nums">
                {count} opportunit{count === 1 ? 'y' : 'ies'}
              </span>
            </div>
            {groups.map(g => {
              const hidden = g.suggestions.length - TITLES_PER_GROUP;
              return (
                <div key={g.surface || 'all'} className="flex flex-col">
                  {g.label && (
                    <span className="text-[12px] font-medium uppercase tracking-wide text-[#8F8F8F] pb-1">{g.label}</span>
                  )}
                  <div className="flex flex-col divide-y divide-[#F2F2F2]">
                    {g.suggestions.slice(0, TITLES_PER_GROUP).map(s => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => onOpen(s.id)}
                        className="block w-full text-left py-1.5 first:pt-1 text-[14px] leading-5 text-[#0A0A0A] hover:text-[#245BF3]"
                      >
                        {s.title}
                      </button>
                    ))}
                  </div>
                  {hidden > 0 && (
                    <button
                      type="button"
                      onClick={() => onOpen(g.suggestions[TITLES_PER_GROUP].id)}
                      className="self-start pt-1 text-[13px] text-[#8F8F8F] hover:text-[#245BF3]"
                    >
                      +{hidden} more
                    </button>
                  )}
                </div>
              );
            })}
            <button
              type="button"
              onClick={() => onOpen(box.suggestions[0].id)}
              className="self-start mt-auto text-[14px] font-medium text-[#245BF3] hover:underline"
            >
              Review
            </button>
          </div>
        );
      })}
    </div>
  );
}
