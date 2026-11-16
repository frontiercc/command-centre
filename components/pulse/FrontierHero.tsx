// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

// Top box: best recent work. A person sees their deepest
// session of the last 7 days; a department sees how many people did Tier 3
// work and the top three sessions, each naming who.
import type { FrontierView } from '@/lib/pulse/frontier-view';
import WorkDetail, { kindLabel } from '@/components/pulse/frontier/WorkDetail';
import { Panel, Tag, Muted, LOAD_FAILED } from '@/components/precision/ui';
import { tierNamesOr, type TierNames } from '@/lib/pulse/tier-names';

interface FrontierHeroProps {
  view: FrontierView | null;
  canOpenUseCases: boolean;
  /** The tier names set in Admin, shown in place of tier numbers. */
  names?: TierNames;
}

const TITLE = 'Best work this week';

function EmptyHero({ text }: { text: string }) {
  return (
    <Panel title={TITLE} subtitle="Last 7 days">
      <Muted>{text}</Muted>
    </Panel>
  );
}

export default function FrontierHero({ view, canOpenUseCases, names }: FrontierHeroProps) {
  // The view is only missing when it failed to build.
  if (!view) return <EmptyHero text={LOAD_FAILED} />;
  const t = tierNamesOr(names);
  const tierName = (n: number) => (n === 3 ? t.t3 : n === 2 ? t.t2 : t.t1);

  if (view.scope === 'person') {
    const item = view.bestWork[0];
    if (!item) return <EmptyHero text="No work in the last 7 days" />;
    return (
      <Panel
        title={TITLE}
        subtitle="Deepest session in the last 7 days"
        right={<Tag tone="judged" title="Tiers are AI-judged">{tierName(item.tier)}</Tag>}
      >
        <h3 className="m-0 mb-1.5 text-[16px] leading-6 font-semibold text-[#0A0A0A]">{kindLabel(item.taskType)}</h3>
        <WorkDetail item={item} showName={false} canOpenUseCases={canOpenUseCases} />
      </Panel>
    );
  }

  if (view.bestWork.length === 0) return <EmptyHero text="No work in the last 7 days" />;
  const n = view.tier3People;
  return (
    <Panel
      title={TITLE}
      subtitle={n === 0 ? `No ${t.t3.toLowerCase()} work in the last 7 days` : `${n} ${n === 1 ? 'person' : 'people'} did ${t.t3.toLowerCase()} work in the last 7 days`}
      right={<Tag tone="judged">AI-judged tiers</Tag>}
      flush
    >
      <ul className="m-0 p-0 list-none">
        {view.bestWork.map(item => (
          <li key={item.sessionId} className="px-4 py-3 border-t border-[#F2F2F2] first:border-t-0">
            <p className="m-0 mb-1 flex items-center gap-2 flex-wrap text-[14px]">
              <span className="font-semibold text-[#0A0A0A]">{item.displayName}</span>
              <span className="text-[#666666]">{kindLabel(item.taskType)}</span>
              <Tag tone="judged">{tierName(item.tier)}</Tag>
            </p>
            <WorkDetail item={item} showName={false} canOpenUseCases={canOpenUseCases} />
          </li>
        ))}
      </ul>
    </Panel>
  );
}
