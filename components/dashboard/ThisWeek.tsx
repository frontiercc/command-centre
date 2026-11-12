// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

/**
 * Dashboard "This week": one answer from each page (Work Pulse, Developer Pulse, FinOps), each
 * read from that page's own API so the two can never disagree, each linking to its page. A card
 * the viewer may not open (403) or whose feature is off (404) is left out.
 */
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { AnswerTagChip, AC, Columns, stripes, type AnswerTag } from '@/components/precision/answer';
import { Spark } from '@/components/precision/ui';
import { changeWords, fmtInt, fmtPct, fmtUsd, monthName, shareChangeWords } from '@/lib/ui/answer-text';
import type { Vendor } from '@/lib/dashboard/vendor';

interface TierWeek { weekStart: number; t1: number; t2: number; t3: number }
interface WeekPoint { weekStart: number; value: number | null; partial: boolean }

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url);
    return r.ok ? (await r.json()) as T : null;
  } catch {
    return null;
  }
}

/** Meaningful-or-frontier share of a run of weeks: pooled counts, never an average of shares. */
function deepShare(weeks: TierWeek[]): number | null {
  const t = weeks.reduce((a, w) => ({ all: a.all + w.t1 + w.t2 + w.t3, deep: a.deep + w.t2 + w.t3 }), { all: 0, deep: 0 });
  return t.all > 0 ? t.deep / t.all : null;
}

export function workProductName(vendor: Vendor, openaiPresent: boolean): string {
  if (vendor === 'openai') return 'ChatGPT';
  if (vendor === 'claude' || !openaiPresent) return 'Claude Cowork';
  return 'Claude Cowork and ChatGPT';
}

interface Card { key: string; dot: string; page: string; href: string; answer: ReactNode; tag?: AnswerTag; chart: ReactNode }

export default function ThisWeek({ vendor, openaiPresent }: { vendor: Vendor; openaiPresent: boolean }) {
  const [cards, setCards] = useState<Card[] | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const [cio, code, fin] = await Promise.all([
        getJson<{ delegation?: { org?: { weeks?: TierWeek[] } } }>(`/api/pulse/cio?weeks=13&vendor=${vendor}`),
        getJson<{ trends?: { commits?: { series: WeekPoint[] } } }>(`/api/pulse/code/org-summary?vendor=${vendor}`),
        getJson<{ grandTotalUsd: number; period: string; projection: { projected: number } | null; insight?: { facts?: { projection?: { priorUsd: number; vsPriorPct: number | null } | null } } }>('/api/finance/chargeback'),
      ]);
      const out: Card[] = [];

      // Work Pulse: the last 4 completed weeks against the 4 before.
      const weeks = cio?.delegation?.org?.weeks ?? [];
      if (weeks.length >= 2) {
        const now = deepShare(weeks.slice(-4));
        const before = weeks.length >= 8 ? deepShare(weeks.slice(-8, -4)) : null;
        if (now !== null) {
          const change = before !== null ? `, ${shareChangeWords(now, before)}` : '';
          out.push({
            key: 'work', dot: '#3F3D9E', page: 'Work Pulse', href: '/pulse/cio', tag: 'judged',
            answer: <><b>{fmtPct(now)}</b> of {workProductName(vendor, openaiPresent)} work in the last 4 weeks was meaningful or frontier{change}.</>,
            chart: <Spark data={weeks.slice(-8).map(w => deepShare([w]))} tone="judged" width={260} height={44} fixedMin={0} />,
          });
        }
      }

      // Developer Pulse: last completed week's commits against the week before.
      const series = (code?.trends?.commits?.series ?? []).filter(p => !p.partial);
      const done = series.filter(p => p.value !== null);
      if (done.length >= 1) {
        const last = done[done.length - 1].value!;
        const prev = done.length >= 2 ? done[done.length - 2].value : null;
        const tool = vendor === 'openai' ? 'Codex' : vendor === 'claude' || !openaiPresent ? 'Claude Code' : 'Claude Code and Codex';
        const words = changeWords(last, prev);
        out.push({
          key: 'code', dot: '#0D8276', page: 'Developer Pulse', href: '/pulse/code', tag: 'measured',
          answer: <>{tool} helped make <b>{fmtInt(last)} commits</b> last week{words ? `, ${words} the week before` : ''}.</>,
          chart: <Columns labels={series.map(() => '')} series={[{ label: 'Commits', colour: AC.measured, values: series.map(p => p.value) }]} height={64} yTicks={[]} />,
        });
      }

      // FinOps: month to date, and the month-end projection against last month.
      if (fin && typeof fin.grandTotalUsd === 'number') {
        const proj = fin.projection?.projected ?? null;
        const vs = fin.insight?.facts?.projection?.vsPriorPct ?? null;
        const prior = fin.insight?.facts?.projection?.priorUsd ?? null;
        const month = monthName(fin.period, true);
        const answer = proj !== null
          ? <>AI spend is on pace for <b>{fmtUsd(proj)}</b> in {month}{vs !== null ? `, ${Math.abs(Math.round(vs))}% ${vs >= 0 ? 'more' : 'less'} than last month` : ''}.</>
          : <>AI spend is <b>{fmtUsd(fin.grandTotalUsd)}</b> so far in {month}.</>;
        const top = Math.max(proj ?? 0, prior ?? 0, fin.grandTotalUsd) || 1;
        out.push({
          key: 'fin', dot: AC.measured, page: 'FinOps', href: '/finops', tag: proj !== null ? 'estimate' : 'measured',
          answer,
          chart: (
            <div className="pt-3">
              <div className="relative h-3.5 rounded-[2px]" style={{ background: AC.track }}>
                <span className="absolute left-0 top-0 bottom-0 rounded-[2px]" style={{ width: `${(fin.grandTotalUsd / top) * 100}%`, background: AC.measured }} />
                {proj !== null && <span className="absolute top-0 bottom-0" style={{ left: `${(fin.grandTotalUsd / top) * 100}%`, width: `${((proj - fin.grandTotalUsd) / top) * 100}%`, background: stripes(AC.judged) }} />}
                {prior !== null && <span className="absolute -top-1.5 -bottom-1.5 border-l-2 border-dashed border-[#0A0A0A]" style={{ left: `${(prior / top) * 100}%` }} />}
              </div>
              <div className="flex justify-between text-[11px] text-[#8F8F8F] mt-1.5">
                <span>{fmtUsd(fin.grandTotalUsd)} so far</span>
                {prior !== null && <span>Last month {fmtUsd(prior)}</span>}
              </div>
            </div>
          ),
        });
      }
      if (live) setCards(out);
    })();
    return () => { live = false; };
  }, [vendor, openaiPresent]);

  if (cards === null || cards.length === 0) return null;
  return (
    <section className="bg-white border border-[#EAEAEA] rounded-[14px] px-5 py-4">
      <div className="flex items-baseline gap-3">
        <h2 className="m-0 text-[14px] font-semibold text-[#0A0A0A]">This week</h2>
        <span className="ml-auto text-[13px] text-[#8F8F8F]">One answer from each page</span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3">
        {cards.map(c => (
          <div key={c.key} className="border border-[#EAEAEA] rounded-[10px] p-3.5 flex flex-col">
            <div className="flex items-center gap-1.5 text-[12px] font-semibold text-[#8F8F8F]">
              <span className="w-2 h-2 rounded-full" style={{ background: c.dot }} />{c.page}
            </div>
            <p className="m-0 mt-1.5 text-[14px] leading-[21px] text-[#0A0A0A] [&_b]:font-semibold">{c.answer}{c.tag && <AnswerTagChip tag={c.tag} />}</p>
            <div className="mt-auto pt-2">{c.chart}</div>
            <Link href={c.href} className="mt-2 text-[13px] font-medium text-[#245BF3] hover:underline">Open {c.page}</Link>
          </div>
        ))}
      </div>
      <p className="m-0 mt-3 pt-2.5 border-t border-dashed border-[#EAEAEA] text-[12px] text-[#8F8F8F]">
        How it&apos;s worked out: each line is written from that page&apos;s own figures, so the Dashboard and the page always agree.
      </p>
    </section>
  );
}
