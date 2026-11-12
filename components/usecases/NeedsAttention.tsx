// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

/**
 * Use Cases register, first panel: what needs your attention. Counts by stage as one row of
 * boxes (the at-risk box is amber: gone quiet is worse than the target of steady use), then the
 * use cases that have gone quiet and the suggestions waiting for review.
 */
import { AnswerPanel, AC } from '@/components/precision/answer';
import { fmtInt, plural } from '@/lib/ui/answer-text';

interface UseCaseLite { id: string; title: string; status: 'candidate' | 'confirmed' | 'archived'; lifecycle: 'not_seen' | 'piloting' | 'adopted' | 'at_risk'; ownerUserId: string | null; departments: string[] }

export default function NeedsAttention({ useCases, suggestionsWaiting }: { useCases: UseCaseLite[]; suggestionsWaiting: number }) {
  const live = useCases.filter(u => u.status !== 'archived');
  const confirmed = live.filter(u => u.status === 'confirmed');
  const atRisk = confirmed.filter(u => u.lifecycle === 'at_risk');
  const count = (l: UseCaseLite['lifecycle']) => confirmed.filter(u => u.lifecycle === l).length;
  const stages = [
    { label: 'Suggestions waiting', n: suggestionsWaiting, colour: AC.judged, ink: AC.judgedInk, href: '#suggestions' },
    { label: 'Not seen yet', n: count('not_seen'), colour: AC.grey, ink: '#666666' },
    { label: 'Piloting', n: count('piloting'), colour: AC.measured, ink: AC.ink },
    { label: 'Adopted', n: count('adopted'), colour: AC.measured, ink: AC.ink },
    { label: 'At risk', n: atRisk.length, colour: atRisk.length > 0 ? AC.warn : AC.grey, ink: atRisk.length > 0 ? AC.warnInk : '#666666' },
  ];
  if (atRisk.length === 0 && suggestionsWaiting === 0) {
    return (
      <AnswerPanel
        question="What needs your attention?"
        period={plural(confirmed.length, 'confirmed use case')}
        quiet={<>Nothing needs your attention: no confirmed use case has gone quiet, and no suggestions are waiting. {fmtInt(count('adopted'))} adopted, {fmtInt(count('piloting'))} piloting.</>}
      />
    );
  }
  return (
    <AnswerPanel
      question="What needs your attention?"
      period={plural(confirmed.length, 'confirmed use case')}
      tag="judged"
      answer={<>
        {atRisk.length > 0 ? <><b>{plural(atRisk.length, 'confirmed use case')}</b> {atRisk.length === 1 ? 'has' : 'have'} gone quiet</> : <>No confirmed use case has gone quiet</>}
        {suggestionsWaiting > 0 ? <>, and <b>{plural(suggestionsWaiting, 'suggestion')}</b> {suggestionsWaiting === 1 ? 'is' : 'are'} waiting for review</> : null}.
      </>}
      attention={atRisk.length > 0 ? {
        title: 'Gone quiet',
        items: atRisk.slice(0, 4).map(u => ({ key: u.id, label: u.title, why: `· ${u.ownerUserId ? 'has an owner' : 'no owner'}${u.departments.length ? ` · ${u.departments.join(', ')}` : ''}`, href: `/use-cases/${encodeURIComponent(u.id)}`, action: 'Open' })),
        more: atRisk.length > 4 ? atRisk.length - 4 : undefined,
      } : undefined}
      note="Claude reads each finished session and judges which use case it is. A use case goes quiet after the weeks with no matching work set in Admin → Use Cases."
    >
      <div className="flex items-stretch gap-2">
        {stages.map((st, i) => (
          <div key={st.label} className="flex items-center gap-2 flex-1 min-w-0">
            {st.href ? (
              <a href={st.href} className="flex-1 min-w-0 rounded-[10px] border-2 px-2 py-2.5 text-center hover:bg-[#FAFAFA]" style={{ borderColor: st.colour }}>
                <div className="text-[22px] leading-7 font-bold tabular-nums" style={{ color: st.ink }}>{fmtInt(st.n)}</div>
                <div className="text-[12px] truncate" style={{ color: st.ink }}>{st.label}</div>
              </a>
            ) : (
              <div className="flex-1 min-w-0 rounded-[10px] border-2 px-2 py-2.5 text-center" style={{ borderColor: st.colour }}>
                <div className="text-[22px] leading-7 font-bold tabular-nums" style={{ color: st.ink }}>{fmtInt(st.n)}</div>
                <div className="text-[12px] truncate" style={{ color: st.ink }}>{st.label}</div>
              </div>
            )}
            {i < stages.length - 1 && <span className="text-[#8F8F8F] hidden sm:inline">→</span>}
          </div>
        ))}
      </div>
    </AnswerPanel>
  );
}
