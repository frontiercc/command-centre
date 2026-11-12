// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

/**
 * Spend Review index, first panel: who needs a look this month. People who asked Anthropic for
 * more usage come first, then the biggest spenders with a better route their colleagues use.
 * Amber marks a limit used up (the limit is the target); everything else is the measured colour.
 */
import { AnswerPanel, AC, TargetBars } from '@/components/precision/answer';
import { fmtUsd, monthName, plural } from '@/lib/ui/answer-text';

interface PersonLite {
  userId: string | null;
  displayName: string;
  department: string | null;
  totalUsd: number;
  routeCount: number;
  pendingRequestAt: string | null;
  anthropic: { limit: number | null; spend: number; shareUsed: number | null } | null;
  mainWork: { label: string } | null;
}

export default function WhoNeedsALook({ people, period, isCurrentMonth }: { people: PersonLite[]; period: string; isCurrentMonth: boolean }) {
  const asked = people.filter(p => p.pendingRequestAt).sort((a, b) => b.totalUsd - a.totalUsd);
  const routed = people.filter(p => !p.pendingRequestAt && p.routeCount > 0).sort((a, b) => b.totalUsd - a.totalUsd);
  const routedSpend = people.filter(p => p.routeCount > 0).reduce((a, p) => a + p.totalUsd, 0);
  const withRoutes = people.filter(p => p.routeCount > 0).length;
  const month = monthName(period, true);
  const href = (p: PersonLite) => (p.userId ? `/finops/spend-review/${encodeURIComponent(p.userId)}?period=${encodeURIComponent(period)}` : undefined);

  if (asked.length === 0 && withRoutes === 0) {
    return (
      <AnswerPanel
        question="Who needs a look this month?"
        period={isCurrentMonth ? `${month} so far` : month}
        quiet={<>Nobody has asked for more usage, and no one has a cheaper route their colleagues already use.</>}
        detail={{ href: '#people', label: `See all ${plural(people.length, 'person', 'people')}` }}
      />
    );
  }
  const rows = [...asked, ...routed].slice(0, 7);
  return (
    <AnswerPanel
      question="Who needs a look this month?"
      period={isCurrentMonth ? `${month} so far` : month}
      tag="judged"
      answer={<>
        {asked.length > 0 ? <><b>{plural(asked.length, 'person', 'people')}</b> asked for more usage, and </> : null}
        <b>{plural(withRoutes, 'person', 'people')}</b> {withRoutes === 1 ? 'has' : 'have'} a cheaper route their colleagues already use, covering <b>{fmtUsd(routedSpend)}</b> of spend.
      </>}
      detail={{ href: '#people', label: `See all ${plural(people.length, 'person', 'people')}` }}
      note="a route is a skill, connector or model that at least 3 colleagues doing the same kind of work use. Kind of work is Claude's judgement; spend is measured, the same figures as FinOps."
    >
      <TargetBars
        labelWidth={190}
        rows={rows.map(p => {
          const used = p.anthropic?.shareUsed ?? null;
          const over = p.pendingRequestAt && used !== null && used >= 0.9;
          return {
            key: p.userId ?? p.displayName,
            label: <span>{p.displayName}<span className="text-[#8F8F8F]">{p.pendingRequestAt ? ' · asked for more' : p.mainWork ? ` · ${p.mainWork.label.toLowerCase()}` : ''}</span></span>,
            value: p.totalUsd,
            display: fmtUsd(p.totalUsd),
            href: href(p),
            colour: over ? AC.warn : AC.measured,
          };
        })}
      />
      {(asked.length + routed.length) > rows.length && <div className="text-[12px] text-[#8F8F8F] pt-1">and {asked.length + routed.length - rows.length} more</div>}
      <div className="flex flex-wrap gap-x-4 mt-2 text-[12px] text-[#666666]">
        <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-[2px]" style={{ background: AC.measured }} />Spend this month</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-[2px]" style={{ background: AC.warn }} />Asked for more with 90% or more of their limit used</span>
      </div>
    </AnswerPanel>
  );
}
