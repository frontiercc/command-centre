// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Developer Pulse, Decisions (admin and manager): four headline figures with a plain status,
// what to act on this month across teams, and the figures behind them. Each row links into that
// team's coaching plan, which is where the named people live.
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { PageBody, Notice } from '@/components/precision/ui';
import { Frame, Track, linkCls } from '@/components/pulse/WorkPulseOverview';
import { BEYOND_QUICK } from '@/lib/pulse/code/coaching-words';
import { tierNamesOr } from '@/lib/pulse/tier-names';
import type { Decisions, Status } from '@/lib/pulse/code/decisions';

const STATUS_INK: Record<Status, string> = { good: '#1A7F37', watch: '#B54708', poor: '#B42318', unknown: '#8F8F8F' };
const STATUS_WORD: Record<Status, string> = { good: 'Healthy', watch: 'Worth watching', poor: 'Needs attention', unknown: 'Not measured' };
const pct = (v: number) => `${Math.round(v * 100)}%`;

export default function DecisionsPage() {
  const [d, setD] = useState<Decisions | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/pulse/code/decisions')
      .then(async r => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || "Couldn't load this page. Try again.");
        return body as Decisions;
      })
      .then(setD)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const tiers = d ? tierNamesOr(d.tierNames) : null;
  const cohorts = d?.cohorts;
  const everyone = cohorts ? cohorts.counts.hardly + cohorts.counts.single + cohorts.counts.multi : 0;

  return (
    <>
      <TopBar title="Decisions" subtitle="What to act on this month, and where" />
      <PageBody className="dash-compact">
        {loading && <LoadingSpinner />}
        {error && <Notice tone="error" title="Failed to load.">{error}</Notice>}

        {d && (
          <>
            {/* 1. The four figures, each with a plain status */}
            <Frame
              title="Where the organisation stands"
              judged
              period="Last 30 days against the 30 before"
              note={tiers
                ? `${BEYOND_QUICK} is a session the classifier judged "${tiers.t2}" or "${tiers.t3}": it carried out a task across several actions, rather than answering one question.`
                : undefined}
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-2.5">
                {d.headlines.map(h => (
                  <div key={h.key} className="border border-[#EFEFEF] rounded-[10px] px-3 py-3 flex flex-col min-w-0">
                    <span className="text-[12px] text-[#777777] leading-4 min-h-[32px]">{h.question}</span>
                    <span className="mt-1 text-[20px] leading-6 font-semibold tabular-nums text-[#0A0A0A]">{h.value ?? '—'}</span>
                    {h.detail && <span className="text-[12px] text-[#777777] mt-0.5">{h.detail}</span>}
                    <span className="mt-auto pt-2 text-[12px] font-medium" style={{ color: STATUS_INK[h.status] }}>{STATUS_WORD[h.status]}</span>
                  </div>
                ))}
              </div>
            </Frame>

            {/* 2. What to act on */}
            <Frame
              title="What to act on this month"
              judged
              period="Ordered by how many people it touches"
              answer={d.actOn.length === 0
                ? <>Nothing stands out: no team is behind the rest, and none is repeating work without a skill.</>
                : <><b>{d.actOn.length === 1 ? 'One thing' : `${d.actOn.length} things`}</b> are worth your time. The first affects {d.actOn[0].department}.</>}
              note="Each row opens that team's coaching plan, where the people are named and actions can be marked done."
            >
              {d.actOn.map((a, i) => (
                <div key={a.key} className="grid grid-cols-[22px_minmax(0,1fr)_110px] gap-2.5 items-start py-2 border-b border-[#F2F2F2] last:border-b-0 text-[13px]">
                  <span className="w-5 h-5 rounded-full bg-[#EEF4F6] text-[11px] font-bold flex items-center justify-center text-[#1F6F8B]">{i + 1}</span>
                  <span className="min-w-0">
                    <span className="block font-semibold text-[#0A0A0A]">{a.what}</span>
                    <span className="block text-[#777777]">{a.why}</span>
                  </span>
                  <Link href={`/pulse/code/coaching?department=${encodeURIComponent(a.department)}`} className={`${linkCls} text-right`}>Coach this team</Link>
                </div>
              ))}
            </Frame>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {/* 3. Who gets how far */}
              <Frame
                title="How far people get"
                judged
                period="Last 30 days"
                answer={everyone === 0
                  ? <>Nobody has a classified session in the last 30 days.</>
                  : <><b>{cohorts!.counts.multi} of {everyone}</b> people hand over whole pieces of work. {cohorts!.counts.hardly} have hardly used it.</>}
                note="A person is counted once, in their own team. The middle group use it, but get single answers."
              >
                {everyone > 0 && (
                  <div className="mb-3">
                    {([['Hand over whole pieces', cohorts!.counts.multi], ['Use it, single answers', cohorts!.counts.single], ['Hardly used it', cohorts!.counts.hardly]] as const).map(([l, v]) => (
                      <div key={l} className="grid grid-cols-[minmax(0,180px)_minmax(0,1fr)_44px] gap-2.5 items-center py-[3px] text-[13px]">
                        <span className="text-[#333333]">{l}</span>
                        <Track value={v / everyone} />
                        <span className="text-right tabular-nums">{v}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="pt-2 border-t border-[#EAEAEA]">
                  <div className="text-[12px] font-semibold text-[#333333] mb-0.5">By team, deepest first</div>
                  {cohorts!.teams.slice(0, 6).map(t => (
                    <div key={t.department} className="grid grid-cols-[minmax(0,140px)_minmax(0,1fr)_84px] gap-2.5 items-center py-[3px] text-[13px]">
                      <Link href={`/pulse/code/coaching?department=${encodeURIComponent(t.department)}`} className="truncate text-[#0A0A0A] hover:text-[#1F6F8B]">{t.department}</Link>
                      <Track value={t.deepShare ?? 0} />
                      <span className="text-right tabular-nums text-[#333333] whitespace-nowrap">
                        {t.deepShare === null ? 'too few' : pct(t.deepShare)} · {t.people}p
                      </span>
                    </div>
                  ))}
                </div>
              </Frame>

              {/* 4. Effort against intent */}
              <Frame
                title="Is effort going where you intended?"
                judged
                period="Last 30 days"
                answer={d.effort.teams.length === 0
                  ? <>Every team is within five points of the shares you set, or no shares are set yet.</>
                  : <><b>{d.effort.teams.length} {d.effort.teams.length === 1 ? 'team is' : 'teams are'}</b> five points or more off what you intended.</>}
                note="Set the intended share for each kind of work on Admin → Developer Pulse."
              >
                {d.effort.teams.map(t => (
                  <div key={`${t.department}:${t.label}`} className="flex items-baseline gap-2.5 py-1.5 border-b border-[#F2F2F2] last:border-b-0 text-[13px]">
                    <Link href={`/pulse/code/coaching?department=${encodeURIComponent(t.department)}`} className="min-w-0 truncate text-[#0A0A0A] hover:text-[#1F6F8B]">{t.department}</Link>
                    <span className="text-[#777777] truncate">{t.label}</span>
                    <span className="ml-auto tabular-nums whitespace-nowrap" style={{ color: '#B54708' }}>
                      {pct(t.share)} of {t.target}%
                    </span>
                  </div>
                ))}
                {d.effort.teams.length === 0 && d.effort.org.length > 0 && (
                  <div className="mt-1">
                    {d.effort.org.slice(0, 5).map(w => (
                      <div key={w.workType} className="grid grid-cols-[minmax(0,180px)_minmax(0,1fr)_44px] gap-2.5 items-center py-[3px] text-[13px]">
                        <span className="text-[#333333] leading-4">{w.label}</span>
                        <Track value={w.share} floor={w.target === null ? null : w.target / 100} />
                        <span className="text-right tabular-nums">{pct(w.share)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </Frame>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {/* 5. What to codify */}
              <Frame
                title="What to turn into a skill"
                judged
                period="Last 30 days"
                answer={d.codify.length === 0
                  ? <>No kind of work is being repeated across teams without a skill behind it.</>
                  : <><b>{d.codify[0].label}</b> is repeated {d.codify[0].sessions} times across {d.codify[0].teams} {d.codify[0].teams === 1 ? 'team' : 'teams'} with nothing shared behind it.</>}
                note="Work several people repeat, where no session used a skill. One skill would stop them all starting from scratch."
              >
                {d.codify.map(c => (
                  <div key={c.label} className="flex items-baseline gap-2.5 py-1.5 border-b border-[#F2F2F2] last:border-b-0 text-[13px]">
                    <span className="min-w-0 truncate text-[#0A0A0A]">{c.label}</span>
                    <span className="text-[#777777] whitespace-nowrap">{c.people} people · {c.teams} {c.teams === 1 ? 'team' : 'teams'}</span>
                    <span className="ml-auto tabular-nums text-[#333333]">{c.sessions} sessions</span>
                  </div>
                ))}
              </Frame>

              {/* 6. New starters */}
              <Frame
                title="How new people are getting on"
                judged
                period="First six weeks"
                answer={d.newStarters.people === 0
                  ? <>Nobody started in the last six weeks.</>
                  : <><b>{d.newStarters.people} {d.newStarters.people === 1 ? 'person' : 'people'}</b> started recently
                    {d.newStarters.deepShare !== null ? <>, and {pct(d.newStarters.deepShare)} of their sessions were {BEYOND_QUICK}</> : null}
                    {d.newStarters.orgDeepShare !== null ? <>, against {pct(d.newStarters.orgDeepShare)} across everyone</> : null}.</>}
                note="Habits set early, so a gap here is worth closing before it becomes the norm."
              >
                {d.newStarters.people > 0 && d.newStarters.deepShare !== null && d.newStarters.orgDeepShare !== null && (
                  <div>
                    {([['New starters', d.newStarters.deepShare], ['Everyone', d.newStarters.orgDeepShare]] as const).map(([l, v]) => (
                      <div key={l} className="grid grid-cols-[minmax(0,140px)_minmax(0,1fr)_44px] gap-2.5 items-center py-[3px] text-[13px]">
                        <span className="text-[#333333]">{l}</span>
                        <Track value={v} />
                        <span className="text-right tabular-nums">{pct(v)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </Frame>
            </div>
          </>
        )}
      </PageBody>
    </>
  );
}
