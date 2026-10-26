// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

// Top box: best recent work. A person sees their deepest
// session of the last 7 days; a department sees how many people did Tier 3
// work and the top three sessions, each naming who.
import type { FrontierView } from '@/lib/pulse/frontier-view';
import WorkDetail, { kindLabel } from '@/components/pulse/frontier/WorkDetail';
import { Panel, Tag, Muted } from '@/components/precision/ui';

interface FrontierHeroProps {
  view: FrontierView | null;
  canOpenUseCases: boolean;
}

const TITLE = 'Best work this week';

function EmptyHero({ text }: { text: string }) {
  return (
    <Panel title={TITLE} subtitle="Last 7 days">
      <Muted>{text}</Muted>
    </Panel>
  );
}

export default function FrontierHero({ view, canOpenUseCases }: FrontierHeroProps) {
  if (!view) return null;

  if (view.scope === 'person') {
    const item = view.bestWork[0];
    if (!item) return <EmptyHero text="No Cowork work in the last 7 days" />;
    return (
      <Panel
        title={TITLE}
        subtitle="Deepest session in the last 7 days"
        right={<Tag tone="judged" title="Tiers are AI-judged">Tier {item.tier}</Tag>}
      >
        <h3 className="m-0 mb-1.5 text-[16px] leading-6 font-semibold text-[#0A0A0A]">{kindLabel(item.taskType)}</h3>
        <WorkDetail item={item} showName={false} canOpenUseCases={canOpenUseCases} />
      </Panel>
    );
  }

  if (view.bestWork.length === 0) return <EmptyHero text="No Cowork work in the last 7 days" />;
  const n = view.tier3People;
  return (
    <Panel
      title={TITLE}
      subtitle={n === 0 ? 'No Tier 3 work in the last 7 days' : `${n} ${n === 1 ? 'person' : 'people'} did Tier 3 work in the last 7 days`}
      right={<Tag tone="judged">AI-judged tiers</Tag>}
      flush
    >
      <ul className="m-0 p-0 list-none">
        {view.bestWork.map(item => (
          <li key={item.sessionId} className="px-4 py-3 border-t border-[#F2F2F2] first:border-t-0">
            <p className="m-0 mb-1 flex items-center gap-2 flex-wrap text-[14px]">
              <span className="font-semibold text-[#0A0A0A]">{item.displayName}</span>
              <span className="text-[#666666]">{kindLabel(item.taskType)}</span>
              <Tag tone="judged">Tier {item.tier}</Tag>
            </p>
            <WorkDetail item={item} showName={false} canOpenUseCases={canOpenUseCases} />
          </li>
        ))}
      </ul>
    </Panel>
  );
}
