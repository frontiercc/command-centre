// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// "What to act on next", from the Workflow Impact package, reworked by
// Department Process Transformation. Model review returns beneath coaching.
// Department process boxes render first (one card per department with open
// process suggestions, each linking through to the /use-cases tray), then the
// per-department coaching-opportunity rows, then model-review rows
// (admin|manager only, when FinOps Model Efficiency is enabled). New workflow
// and going-quiet stay retired — they already surface on the tray and
// alerts/digest respectively. Renders nothing when both `items` and
// `deptBoxes` are empty.
'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import DeptProcessBoxes from '@/components/usecases/DeptProcessBoxes';
import { Panel, SubHead, Tag } from '@/components/precision/ui';

export type ActNextType = 'coaching' | 'model_review';
export interface ActNextItem { type: ActNextType; title: string; detail: string; reach: number; href: string }
export interface DeptProcessBoxItem {
  department: string;
  key?: string;
  label?: string;
  count: number;
  suggestions: { id: string; title: string }[];
  /** Cowork and Claude Code lists, each ranked by people then sessions. */
  groups?: { surface: string; label: string; suggestions: { id: string; title: string }[] }[];
}

const CHIP: Record<ActNextType, { label: string; tone: 'measured' | 'judged' }> = {
  coaching: { label: 'Coaching', tone: 'measured' },
  model_review: { label: 'Model review', tone: 'judged' },
};

export default function ActNextPanel({
  items,
  deptBoxes = [],
}: {
  items: ActNextItem[];
  deptBoxes?: DeptProcessBoxItem[];
}) {
  const router = useRouter();
  if (items.length === 0 && deptBoxes.length === 0) return null;

  return (
    <Panel title="What to act on next" subtitle="Drawn from what is actually happening" flush>
      {deptBoxes.length > 0 && (
        <div className="p-4">
          <SubHead>Department process opportunities</SubHead>
          <DeptProcessBoxes boxes={deptBoxes} onOpen={() => router.push('/use-cases')} />
        </div>
      )}

      {items.length > 0 && (
        <div className={deptBoxes.length > 0 ? 'border-t border-[#F2F2F2]' : ''}>
          <div className="px-4 pt-3 pb-1"><SubHead>Coaching and model review</SubHead></div>
          <ul className="m-0 p-0 list-none">
            {items.map((item, i) => (
              <li key={`${item.type}-${i}`} className="px-4 py-2.5 flex items-center gap-3 border-t border-[#F2F2F2] first:border-t-0">
                <span className="w-[96px] shrink-0"><Tag tone={CHIP[item.type].tone}>{CHIP[item.type].label}</Tag></span>
                <span className="min-w-0 flex-1 text-[14px]">
                  <Link href={item.href} className="font-medium text-[#0A0A0A] hover:underline">{item.title}</Link>
                  <span className="text-[#8F8F8F]"> · {item.detail}</span>
                </span>
                {item.reach > 0 && (
                  <span className="text-[13px] text-[#666666] whitespace-nowrap shrink-0 tabular-nums">
                    {item.reach} {item.reach === 1 ? 'person' : 'people'}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}
