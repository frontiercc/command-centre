// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

// The cards under the top box. Person page: mainstay deep
// work (the Frontier card), capability creation, skills & connectors. Department
// page: a wider capability card and skills & connectors; whether deep work is
// spreading is already answered by Concentration Risk and the Delegation View.
import Link from 'next/link';
import type { FrontierView, WorkItem } from '@/lib/pulse/frontier-view';
import WorkDetail, { kindLabel } from '@/components/pulse/frontier/WorkDetail';
import { Panel, PanelFoot, Tag, Pill, Muted } from '@/components/precision/ui';

export interface ToolUsed {
  name: string;
  type: 'skill' | 'connector';
  count: number;
}

interface MilestoneCardsProps {
  frontier: FrontierView | null;
  canReview: boolean;
  canOpenUseCases: boolean;
  toolsUsed: ToolUsed[];
}

function ItemList({ items, heading, showName, canOpenUseCases, chip }: {
  items: WorkItem[];
  heading: (it: WorkItem) => string;
  showName: boolean;
  canOpenUseCases: boolean;
  chip?: (it: WorkItem) => React.ReactNode;
}) {
  return (
    <ul className="m-0 p-0 list-none">
      {items.map(it => (
        <li key={`${it.kind}-${it.sessionId}`} className="px-4 py-3 border-t border-[#F2F2F2] first:border-t-0">
          <p className="m-0 mb-1 flex items-center gap-2 flex-wrap text-[14px] font-medium text-[#0A0A0A] leading-5">
            <span>{heading(it)}</span>
            <Tag tone="judged">T{it.tier}</Tag>
            {chip?.(it)}
          </p>
          <WorkDetail item={it} showName={showName} canOpenUseCases={canOpenUseCases} compact />
        </li>
      ))}
    </ul>
  );
}

function MainstayCard({ view, canOpenUseCases }: { view: FrontierView; canOpenUseCases: boolean }) {
  const m = view.mainstay;
  return (
    <Panel title="Mainstay deep work" subtitle="30 days">
      {!m ? (
        <Muted>No Tier 3 work in the last 30 days</Muted>
      ) : !m.item ? (
        <p className="m-0 text-[13px] leading-5 text-[#666666]">
          {m.tier3Sessions} Tier 3 {m.tier3Sessions === 1 ? 'session' : 'sessions'} in the last 30 days. Kinds of work are named from 26 September onwards.
        </p>
      ) : (
        <>
          <p className="m-0 mb-1 flex items-center gap-2 flex-wrap text-[14px] font-medium text-[#0A0A0A] leading-5">
            <span>{kindLabel(m.item.taskType)}</span>
            <Tag tone="judged">T3</Tag>
          </p>
          <p className="m-0 mb-1 text-[13px] text-[#333333] tabular-nums">{m.count} of {m.tier3Sessions} Tier 3 {m.tier3Sessions === 1 ? 'session' : 'sessions'}</p>
          <WorkDetail item={m.item} showName={false} canOpenUseCases={canOpenUseCases} compact />
        </>
      )}
    </Panel>
  );
}

function CapabilityCard({ view, canReview, canOpenUseCases, className = '' }: { view: FrontierView; canReview: boolean; canOpenUseCases: boolean; className?: string }) {
  const pending = view.capabilityPending;
  const empty = view.capabilities.length === 0;
  return (
    <Panel title="Capability creation" subtitle="30 days" className={className} flush>
      {empty ? (
        <div className="p-4"><Muted>No new capabilities in the last 30 days</Muted></div>
      ) : (
        <ItemList
          items={view.capabilities}
          heading={it => `${view.scope === 'dept' ? `${it.displayName} built` : 'Built'} something new: ${kindLabel(it.taskType).toLowerCase()}`}
          showName={false}
          canOpenUseCases={canOpenUseCases}
          chip={it => it.capability?.status === 'confirmed'
            ? <Pill tone="good">Confirmed</Pill>
            : <Pill tone="warn">Awaiting review</Pill>}
        />
      )}
      {pending > 0 && (
        <PanelFoot>
          {pending} awaiting review{view.scope === 'dept' ? ' in this department' : ''}
          {canReview && (
            <> · <Link href="/admin/pulse?tab=overview" className="font-medium text-[#245BF3] hover:underline">Review</Link></>
          )}
        </PanelFoot>
      )}
    </Panel>
  );
}

function ToolsUsedCard({ tools }: { tools: ToolUsed[] }) {
  return (
    <Panel title="Skills & connectors" subtitle="7 days" flush>
      {tools.length === 0 ? (
        <div className="p-4"><Muted>No skills or connectors used in the last 7 days</Muted></div>
      ) : (
        <ul className="m-0 p-0 list-none">
          {tools.map((t, i) => (
            <li key={i} className="px-4 py-2 border-t border-[#F2F2F2] first:border-t-0 flex items-center gap-2">
              <Tag>{t.type === 'skill' ? 'skill' : 'mcp'}</Tag>
              <span className="text-[14px] text-[#0A0A0A] truncate min-w-0">{t.name}</span>
              <span className="ml-auto text-[13px] text-[#666666] tabular-nums shrink-0">×{t.count}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export default function MilestoneCards({ frontier, canReview, canOpenUseCases, toolsUsed }: MilestoneCardsProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-start">
      {frontier?.scope === 'person' && <MainstayCard view={frontier} canOpenUseCases={canOpenUseCases} />}
      {frontier && (
        <CapabilityCard
          view={frontier}
          canReview={canReview}
          canOpenUseCases={canOpenUseCases}
          className={frontier.scope === 'dept' ? 'md:col-span-2' : ''}
        />
      )}
      <ToolsUsedCard tools={toolsUsed} />
    </div>
  );
}
