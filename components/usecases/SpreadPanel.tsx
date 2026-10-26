// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Spread panel — who does matching work without using this use case.
// Measured counts; names stay behind this page's
// existing admin/manager gate. Renders nothing for null (non-confirmed).
//
// NOTE: the "4 weeks"/"4 completed weeks" strings below must track
// lib/usecases/spread.ts's SPREAD_ACTIVITY_WINDOW_WEEKS constant, and
// VISIBLE_PER_DEPT below must track that module's SPREAD_PANEL_VISIBLE. That
// module cannot be imported here — it pulls in getTypedClient (server-only
// DB client) and would break this 'use client' component's bundle — so both
// are duplicated as literals. Update all spots by hand if either constant
// ever changes.
'use client';

import { evidenceLine, humaniseSignal, activityPhrase, type SpreadSignalKind, type MatchedSignalEvidence } from '@/lib/usecases/spread-format';
import { Panel, PanelFoot, Tag, Muted } from '@/components/precision/ui';

// Mirrors lib/usecases/spread.ts's SPREAD_PANEL_VISIBLE (was
// accidentally shrunk to a bare 5 here, hiding half of a full-cap department).
const VISIBLE_PER_DEPT = 10;

interface SpreadCandidate { userId: string; displayName: string; matchedSignal: string; matchedKind: SpreadSignalKind; activityCount: number; signals?: MatchedSignalEvidence[] }
interface SpreadDept { dept: string; adopterCount: number; users: SpreadCandidate[]; more: number }
export type SpreadData = { departments: SpreadDept[] } | { unsupported: 'no_skill' } | null;

export default function SpreadPanel({ spread }: { spread: SpreadData }) {
  if (!spread) return null;

  if ('unsupported' in spread) {
    return (
      <Panel title="Spread opportunities">
        <p className="m-0 text-[13px] text-[#666666]">
          Spread starts once this use case has a skill. It then lists the people doing this work who haven&rsquo;t used the skill yet: who to show it to.
        </p>
      </Panel>
    );
  }

  if (spread.departments.length === 0) {
    return (
      <Panel title="Spread opportunities">
        <Muted>
          No one needs showing the skill: everyone doing this work regularly in the last 4 weeks has already used it.
        </Muted>
      </Panel>
    );
  }

  return (
    <Panel
      title="Spread opportunities"
      subtitle="People doing this work who haven't used its skill yet, last 4 completed weeks"
      right={<Tag tone="measured">Measured</Tag>}
      flush
    >
      {spread.departments.map(d => {
        const totalWithoutIt = d.users.length + d.more;
        const visibleUsers = d.users.slice(0, VISIBLE_PER_DEPT);
        const hiddenCount = totalWithoutIt - visibleUsers.length;
        return (
          <div key={d.dept} className="min-w-0 border-t border-[#F2F2F2] first:border-t-0">
            <div className="flex items-baseline justify-between gap-2 min-w-0 px-4 pt-3 pb-1">
              <p className="m-0 text-[13px] font-medium text-[#0A0A0A] truncate min-w-0" title={d.dept}>{d.dept}</p>
              <p className="m-0 text-[13px] text-[#8F8F8F] whitespace-nowrap tabular-nums shrink-0">
                {d.adopterCount === 0
                  ? <>no one in {d.dept} has used the skill yet · {totalWithoutIt} doing the work without it</>
                  : <>{d.adopterCount} {d.adopterCount === 1 ? 'person has' : 'people have'} used the skill · {totalWithoutIt} doing the work without it</>}
              </p>
            </div>
            <ul className="m-0 p-0 list-none">
              {visibleUsers.map(u => {
                // Full matched evidence (design rule) — every signal
                // behind the listing, not just the strongest; fall back to the
                // single-signal line if `signals` is absent (stale API payload).
                const evidence = u.signals && u.signals.length > 0
                  ? evidenceLine(u.signals, 4)
                  : `${humaniseSignal(u.matchedSignal, u.matchedKind)} · ${activityPhrase(u.activityCount, u.matchedKind)} in the last 4 weeks`;
                return (
                  <li key={u.userId} className="px-4 py-2 flex items-center gap-3 min-w-0 border-t border-[#F2F2F2] first:border-t-0">
                    <span className="text-[14px] text-[#0A0A0A] truncate min-w-0" title={u.displayName}>{u.displayName}</span>
                    <span
                      className="text-[13px] text-[#05073F] tabular-nums truncate shrink-0 max-w-[60%] text-right ml-auto"
                      title={evidence}
                    >
                      {evidence}
                    </span>
                  </li>
                );
              })}
            </ul>
            {hiddenCount > 0 && <p className="m-0 px-4 pb-2 text-[13px] text-[#8F8F8F] tabular-nums">and {hiddenCount} more</p>}
          </div>
        );
      })}
      <PanelFoot>
        Sessions judged to be this work (AI-judged) in the last 4 completed weeks; skill use is measured.
        Task types come from the AI classifier.
      </PanelFoot>
    </Panel>
  );
}
