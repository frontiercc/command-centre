// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

// Department feed: every new capability in the last 30 days,
// newest first. The capability card shows the latest three; this is the month.
import type { WorkItem } from '@/lib/pulse/frontier-view';
import WorkDetail, { kindLabel } from '@/components/pulse/frontier/WorkDetail';
import { Panel, Tag, Pill, Muted } from '@/components/precision/ui';

interface FrontierFeedProps {
  items: WorkItem[];
  canOpenUseCases: boolean;
}

export default function FrontierFeed({ items, canOpenUseCases }: FrontierFeedProps) {
  return (
    <Panel title="New capabilities" subtitle="Last 30 days" flush={items.length > 0}>
      {items.length === 0 ? (
        <Muted>No new capabilities in the last 30 days.</Muted>
      ) : (
        <ul className="m-0 p-0 list-none">
          {items.map(it => (
            <li key={`${it.kind}-${it.sessionId}`} className="px-4 py-3 border-t border-[#F2F2F2] first:border-t-0 flex items-start gap-3">
              <span aria-hidden="true" className="w-6 h-6 rounded-full bg-[#F2F2F2] text-[#4D4D4D] text-[12px] font-semibold flex items-center justify-center shrink-0 mt-px">
                {it.displayName.charAt(0).toUpperCase()}
              </span>
              <div className="flex-1 min-w-0">
                <p className="m-0 mb-1 flex items-center gap-2 flex-wrap text-[14px] text-[#0A0A0A]">
                  <span>
                    <span className="font-semibold">{it.displayName}</span>{' '}
                    built something new: {kindLabel(it.taskType).toLowerCase()}
                  </span>
                  <Tag tone="judged">T{it.tier}</Tag>
                  {it.capability?.status === 'confirmed'
                    ? <Pill tone="good">Confirmed</Pill>
                    : <Pill tone="warn">Awaiting review</Pill>}
                </p>
                <WorkDetail item={it} showName={false} canOpenUseCases={canOpenUseCases} compact />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
