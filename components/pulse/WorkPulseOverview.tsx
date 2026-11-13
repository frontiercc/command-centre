// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

/**
 * Work Pulse overview panels (panels 2 to 7 of the redesigned page). Plain statements written
 * here from the figures, one chart colour (petrol), amber only below a floor. AI-judged is
 * shown by a grey tag, never a colour.
 */
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { Tag, B } from '@/components/precision/ui';
import { DASH, DASH_SHADES, shareWords, cap } from '@/components/dashboard/QuestionCard';
import { cleanTitle } from '@/components/pulse/CapabilityLog';
import type { ByProductData } from '@/components/pulse/ByProductPanel';
import type { SessionOutputReport } from '@/components/pulse/SessionOutputCard';
import type { HumanTimeSummary } from '@/components/pulse/HumanTimeCard';
import type { ActNextItem, DeptProcessBoxItem } from '@/components/pulse/ActNextPanel';
import { FAMILY_LABEL, PRODUCT_FAMILY, PRODUCT_LABEL, type WorkProduct } from '@/lib/pulse/cowork/products';

const AMBER = '#DC8A00';
const words = (v: number) => (v < 0.15 ? `${Math.round(v * 100)}%` : shareWords(v));

/* ── Frame shared by every panel ────────────────────────────────── */

function Frame({ title, judged, period, answer, children, note, id }: {
  title: string; judged?: boolean; period?: string; answer?: ReactNode; children?: ReactNode; note?: ReactNode; id?: string;
}) {
  return (
    <section id={id} className="bg-white border border-[#EAEAEA] rounded-[14px] px-4 py-3.5 min-w-0">
      <div className="flex items-baseline gap-2 flex-wrap">
        <h2 className="m-0 text-[14px] font-semibold text-[#0A0A0A]">{title}</h2>
        {judged && <Tag tone="neutral">AI-judged</Tag>}
        {period && <span className="ml-auto text-[12px] text-[#8F8F8F]">{period}</span>}
      </div>
      {answer && <p className="m-0 mt-2 mb-2.5 text-[14px] leading-[22px] text-[#1A1A1A] [&_b]:font-semibold">{answer}</p>}
      {children}
      {note && <p className="m-0 mt-3 pt-2 border-t border-dashed border-[#EAEAEA] text-[12px] text-[#8F8F8F]">{note}</p>}
    </section>
  );
}

function Track({ value, colour = DASH, floor, striped }: { value: number; colour?: string; floor?: number | null; striped?: boolean }) {
  return (
    <span className="relative block h-[6px] rounded-[3px] bg-[#F1F1F3]">
      <span className="absolute inset-y-0 left-0 rounded-[3px]" style={{ width: `${Math.max(0.5, Math.min(100, value * 100))}%`, background: striped ? `repeating-linear-gradient(45deg, ${colour} 0 3px, #fff 3px 6px)` : colour }} />
      {floor != null && <span className="absolute -top-1 -bottom-1 border-l-[1.5px] border-dashed border-[#555555]" style={{ left: `${floor * 100}%` }} />}
    </span>
  );
}

const linkCls = 'text-[#245BF3] font-medium hover:underline';

/* ── 2: Use cases to act on next ───────────────────────────────── */

export function UseCasesNext({ boxes, items }: { boxes: DeptProcessBoxItem[]; items: ActNextItem[] }) {
  type Row = { key: string; title: string; detail: string; kind: string; reach: number; href: string; action: string };
  const rows: Row[] = [
    ...boxes.flatMap(b => b.suggestions.map(s => ({
      key: `p-${s.id}`, title: s.title,
      detail: `${b.department}${(s as { people?: number | null }).people ? ` · ${(s as { people?: number | null }).people} people repeat it` : ''}`,
      kind: 'PROCESS TO REVIEW', reach: (s as { people?: number | null }).people ?? 1, href: '/use-cases', action: 'Review',
    }))),
    ...items.filter(i => i.type === 'coaching').map((i, n) => ({
      key: `c-${n}`, title: i.title, detail: i.detail, kind: 'COACHING', reach: i.reach, href: i.href, action: 'See who',
    })),
  ].sort((a, b) => b.reach - a.reach);
  if (rows.length === 0) return null;
  const shown = rows.slice(0, 5);
  const first = shown[0];
  return (
    <Frame
      title="Use cases to act on next"
      period="Updated weekly"
      answer={<><b>{shown.length === 1 ? 'One use case' : `${cap(numberWord(shown.length))} use cases`}</b> would make the most difference now. The first, {first.title.toLowerCase()}, reaches {first.reach} {first.reach === 1 ? 'person' : 'people'}.</>}
      note="Ranked by how many people each one reaches. Processes are Claude's reading of what departments repeat; coaching is people doing a use case's work without its skill."
    >
      {shown.map((r, i) => (
        <div key={r.key} className="grid grid-cols-[22px_minmax(0,1fr)_150px_70px] gap-2.5 items-center py-1.5 border-b border-[#F2F2F2] last:border-b-0 text-[13px]">
          <span className="w-5 h-5 rounded-full bg-[#EEF4F6] text-[11px] font-bold flex items-center justify-center" style={{ color: DASH }}>{i + 1}</span>
          <span className="min-w-0 truncate"><span className="font-semibold text-[#0A0A0A]">{r.title}</span> <span className="text-[#777777]">· {r.detail}</span></span>
          <span className="text-[10px] font-semibold text-[#4D4D4D] bg-[#F2F2F2] rounded-[3px] px-1.5 py-px justify-self-start">{r.kind}</span>
          <Link href={r.href} className={`${linkCls} text-right`}>{r.action}</Link>
        </div>
      ))}
      {rows.length > shown.length && <div className="mt-1.5 text-[13px]"><Link href="/use-cases" className={linkCls}>and {rows.length - shown.length} more in Use Cases</Link></div>}
    </Frame>
  );
}

function numberWord(n: number): string {
  return ['no', 'one', 'two', 'three', 'four', 'five'][n] ?? String(n);
}

/* ── 3: Are people handing Claude bigger jobs? ──────────────────── */

interface TierWeek { weekStart: number; t1: number; t2: number; t3: number }
interface DeptTrend { dept: string; thenVsNow: { then: number; now: number; deltaPp: number; arrow: 'up' | 'flat' | 'down' } | null }

export function BiggerJobs({ weeks, departments, product, window, onWindow }: {
  weeks: TierWeek[]; departments: DeptTrend[]; product: string; window: 13 | 26 | 52; onWindow: (w: 13 | 26 | 52) => void;
}) {
  const real = (ws: TierWeek[]) => { const t = ws.reduce((a, w) => ({ all: a.all + w.t1 + w.t2 + w.t3, r: a.r + w.t2 + w.t3 }), { all: 0, r: 0 }); return t.all > 0 ? t.r / t.all : null; };
  if (weeks.length === 0) return null;
  const first = real(weeks.slice(0, Math.min(4, weeks.length)));
  const last = real(weeks.slice(-4));
  const falling = departments.filter(d => d.thenVsNow?.arrow === 'down').sort((a, b) => a.thenVsNow!.deltaPp - b.thenVsNow!.deltaPp);
  const fmtDate = (s: number) => new Date(s * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const verdict = first !== null && last !== null
    ? (Math.round(last * 100) > Math.round(first * 100) + 2 ? 'Yes. ' : Math.round(last * 100) < Math.round(first * 100) - 2 ? 'No. ' : 'About the same. ')
    : '';
  const n4 = Math.min(4, weeks.length);
  const firstFrom = fmtDate(weeks[0].weekStart);
  const lastTo = fmtDate(weeks[weeks.length - 1].weekStart + 6 * 86400);
  const answer = first !== null && last !== null
    ? <>{verdict}Over the last {weeks.length} weeks, real work went from <b>{words(first)}</b> of tasks in the first {n4} (from {firstFrom}) to <b>{words(last)}</b> in the most recent {n4} (to {lastTo}).{falling.length === 1 ? ` ${falling[0].dept} is going the other way.` : falling.length > 1 ? ` ${falling.length} departments are going the other way.` : ''}</>
    : null;
  // A window longer than the history there is: say so rather than imply the chart covers it.
  const short = weeks.length < window;
  const W = 1100, H = 120, left = 36, top = 6, bottom = 18, plotH = H - top - bottom;
  const n = weeks.length, gap = n > 26 ? 2 : 8, bw = (W - left - gap * (n - 1)) / n;
  const every = n > 26 ? 4 : n > 13 ? 2 : 1;
  return (
    <Frame
      title={`Are people handing ${product} bigger jobs?`}
      judged
      answer={answer}
      note="Each column is one week, Monday to Sunday, split into routine, meaningful and frontier tasks. Only completed weeks are shown."
    >
      <div className="flex justify-end -mt-9 mb-3">
        {short && <span className="mr-3 self-center text-[12px] text-[#8F8F8F]">Only {weeks.length} weeks of history so far</span>}
        <span className="inline-flex border border-[#EAEAEA] rounded-[8px] overflow-hidden">
          {([13, 26, 52] as const).map(w => (
            <button key={w} type="button" onClick={() => onWindow(w)} className={`text-[12px] px-2 py-0.5 ${w === window ? 'bg-[#F2F2F2] text-[#0A0A0A] font-medium' : 'bg-white text-[#666666]'}`}>{w} weeks</button>
          ))}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block" role="img" aria-label="Tasks by depth, each week">
        {[0, 50, 100].map(t => {
          const y = top + plotH - (t / 100) * plotH;
          return <g key={t}><line x1={left} x2={W} y1={y} y2={y} stroke="#F0F0F0" /><text x={left - 6} y={y + 4} textAnchor="end" fontSize="11" fill="#8F8F8F">{t}%</text></g>;
        })}
        {weeks.map((w, i) => {
          const tot = w.t1 + w.t2 + w.t3;
          const x = left + i * (bw + gap);
          if (tot === 0) return null;
          let y = top + plotH;
          return (
            <g key={w.weekStart}>
              {[w.t1, w.t2, w.t3].map((v, j) => { const h = (v / tot) * plotH; y -= h; return <rect key={j} x={x} y={y} width={bw} height={h} fill={DASH_SHADES[j]} />; })}
              {(i % every === 0 || i === n - 1) && <text x={x + bw / 2} y={H - 4} textAnchor="middle" fontSize="11" fill="#8F8F8F">{fmtDate(w.weekStart)}</text>}
            </g>
          );
        })}
      </svg>
      <div className="flex flex-wrap gap-x-3.5 mt-1.5 text-[12px] text-[#777777]">
        {['Routine', 'Meaningful', 'Frontier'].map((l, i) => <span key={l} className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-[2px]" style={{ background: DASH_SHADES[i] }} />{l}</span>)}
      </div>
      {falling.length > 0 && (
        <div className="mt-3 pt-2 border-t border-[#EAEAEA]">
          <div className="text-[12px] font-semibold text-[#333333] mb-0.5">Going the other way</div>
          {falling.slice(0, 3).map(d => (
            <div key={d.dept} className="flex gap-2.5 items-center py-1 text-[13px]">
              <Link href={`/pulse/dept?dept=${encodeURIComponent(d.dept)}`} className="text-[#0A0A0A] hover:text-[#245BF3]">{d.dept}</Link>
              <span className="text-[#777777]">real work is now {words(d.thenVsNow!.now)} of tasks</span>
              <span className="ml-auto text-[#333333]">down from {words(d.thenVsNow!.then)}</span>
            </div>
          ))}
        </div>
      )}
    </Frame>
  );
}

/* ── 4: Which departments are doing real work? ───────────────────── */

export function DeptRealWork({ rows, floorPct }: { rows: Array<{ dept: string; share: number; tasks: number }>; floorPct: number | null }) {
  if (rows.length === 0) return null;
  const floor = floorPct !== null ? floorPct / 100 : null;
  const below = floor === null ? [] : rows.filter(r => r.share < floor);
  const top = rows[0];
  const list = (xs: string[]) => (xs.length <= 1 ? xs[0] ?? '' : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
  const answer = below.length === 0
    ? <>Every department is above your floor of {words(floor ?? 0)} tasks being real work. <b>{top.dept}</b> does the most real work.</>
    : below.length <= 3
      ? <><b>{list(below.map(b => b.dept))}</b> {below.length === 1 ? 'is' : 'are'} below your floor of {words(floor!)}. {top.dept} does the most real work.</>
      : <><b>{below.length} of {rows.length}</b> departments are below your floor of {words(floor!)}. {top.dept} does the most real work.</>;
  return (
    <Frame
      title="Which departments are doing real work?"
      judged
      period="Last 4 weeks"
      answer={answer}
      note={<>Each bar is the share of the department&apos;s tasks that were real work.{floor !== null ? ` The dashed line is your floor, set in Admin → System; departments below it are amber.` : ''} <Link href="/pulse/dept" className={linkCls}>See every department and its people</Link></>}
    >
      {rows.map(r => {
        const isBelow = floor !== null && r.share < floor;
        return (
          <div key={r.dept} className="grid grid-cols-[minmax(0,120px)_minmax(0,1fr)_40px] gap-2.5 items-center py-[3px] text-[13px]">
            <span className="truncate text-[#333333]">{r.dept}</span>
            <Track value={r.share} colour={isBelow ? AMBER : DASH} floor={floor} />
            <span className={`text-right tabular-nums ${isBelow ? 'font-semibold text-[#B54708]' : 'text-[#0A0A0A]'}`}>{Math.round(r.share * 100)}%</span>
          </div>
        );
      })}
    </Frame>
  );
}

/* ── 5: What did the work produce? ──────────────────────────────── */

export function Produced({ output, human }: { output: SessionOutputReport | null | undefined; human: HumanTimeSummary | null | undefined }) {
  if (!output?.hasData) return null;
  const kinds = [...(output.byTaskType ?? [])].sort((a, b) => b.rate - a.rate);
  const shown = kinds.slice(0, 5);
  const ratio = human?.ratio ?? null;
  const h = (m: number) => Math.round(m / 60).toLocaleString('en-GB');
  const times = ratio === null ? null : ratio >= 1.8 && ratio < 2.5 ? 'about twice as long' : ratio >= 2.5 && ratio < 3.5 ? 'about three times as long' : `about ${Math.round(ratio)} times as long`;
  return (
    <Frame
      title="What did the work produce?"
      period="Last 13 weeks"
      answer={<>{output.rate === null ? 'Not measured yet.' : <><b>{cap(words(output.rate))}</b> of sessions produced a file.</>}{times ? <> By hand, the same work would have taken <b>{times}</b>.</> : null}</>}
      note={<>A session produced a file when Claude saved, sent or published one.{times ? ' The by-hand time is Claude’s estimate.' : ''}</>}
    >
      {ratio !== null && human && (
        <div className="mb-3">
          {[['With Claude', human.claudeMinutes, false], ['By hand (estimate)', human.humanMinutes.likely, true]].map(([l, m, est]) => (
            <div key={String(l)} className="grid grid-cols-[minmax(0,120px)_minmax(0,1fr)_60px] gap-2.5 items-center py-[3px] text-[13px]">
              <span className="text-[#333333]">{l as string}</span>
              <Track value={(m as number) / Math.max(human.claudeMinutes, human.humanMinutes.likely)} striped={est as boolean} />
              <span className="text-right tabular-nums">{est ? '≈' : ''}{h(m as number)} h</span>
            </div>
          ))}
        </div>
      )}
      {shown.length > 0 && (
        <div className="pt-2 border-t border-[#EAEAEA]">
          <div className="text-[12px] font-semibold text-[#333333] mb-0.5">Produced a file, by kind of work</div>
          {shown.map(k => (
            <div key={k.taskType} className="grid grid-cols-[minmax(0,120px)_minmax(0,1fr)_40px] gap-2.5 items-center py-[3px] text-[13px]">
              <span className="truncate text-[#333333]">{cap(k.taskType.replace(/_/g, ' '))}</span>
              <Track value={k.rate} />
              <span className="text-right tabular-nums">{Math.round(k.rate * 100)}%</span>
            </div>
          ))}
        </div>
      )}
    </Frame>
  );
}

/* ── 6: Which products are people using? ─────────────────────────── */

export function Products({ data }: { data: ByProductData | null | undefined }) {
  if (!data) return null;
  const label = (p: string) => (p === 'claude_chat' ? 'Claude Chat' : p === 'chatgpt' ? 'ChatGPT' : p === 'cowork' ? 'Claude Cowork' : PRODUCT_LABEL[p as WorkProduct] ?? p);
  const family = (p: string) => (p === 'claude_chat' || p === 'chatgpt' || p === 'cowork' ? null : PRODUCT_FAMILY[p as WorkProduct] ?? null);
  const rows = data.rows.filter(r => r.product !== 'all');
  const lead = [...rows].sort((a, b) => b.people - a.people)[0];
  const max = Math.max(1, ...rows.map(r => r.people));
  let lastFamily: string | null = null;
  return (
    <Frame
      title="Which products are people using?"
      period="Last 30 days"
      answer={lead && lead.people > 0
        ? <>{label(lead.product)} carries most of the work: <b>{lead.people} people</b>{lead.meaningfulPct !== null ? <>, and <b>{words(lead.meaningfulPct / 100)}</b> of their tasks are real work</> : null}.</>
        : <>No product has been used in the last 30 days.</>}
      note={<>Real work is Claude&apos;s judgement of each task. Produced a file counts sessions where Claude saved, sent or published one. Spend for each product is on <Link href="/finops" className={linkCls}>FinOps</Link>.</>}
    >
      <div className="grid grid-cols-[minmax(0,130px)_minmax(0,1fr)_56px_64px_70px] gap-2.5 text-[11px] text-[#8F8F8F] pb-1">
        <span /> <span>People</span><span className="text-right">Sessions</span><span className="text-right">Real work</span><span className="text-right">Made a file</span>
      </div>
      {rows.map(r => {
        const f = family(r.product);
        const head = f && f !== lastFamily ? FAMILY_LABEL[f] : null;
        lastFamily = f;
        return (
          <div key={r.product}>
            {head && <div className="text-[11px] font-semibold text-[#8F8F8F] pt-1.5">{head}</div>}
            <div className="grid grid-cols-[minmax(0,130px)_minmax(0,1fr)_56px_64px_70px] gap-2.5 items-center py-[3px] text-[13px]">
              <span className={`truncate ${f ? 'pl-3' : ''} ${r.people === 0 ? 'text-[#8F8F8F]' : 'text-[#333333]'}`}>{label(r.product)}</span>
              <span className="flex items-center gap-2"><span className="flex-1"><Track value={r.people / max} /></span><span className="w-7 text-right tabular-nums">{r.people}</span></span>
              <span className="text-right tabular-nums text-[#333333]">{r.sessions.toLocaleString('en-GB')}</span>
              <span className="text-right tabular-nums text-[#333333]">{r.meaningfulPct === null ? <span className="text-[#B3B3B3]">Not judged</span> : `${Math.round(r.meaningfulPct)}%`}</span>
              <span className="text-right tabular-nums text-[#333333]">{r.producedPct === null ? <span className="text-[#B3B3B3]">Not measured</span> : `${Math.round(r.producedPct)}%`}</span>
            </div>
          </div>
        );
      })}
    </Frame>
  );
}

/* ── 7: New ways of working ─────────────────────────────────────── */

interface Candidate { id: number; title: string; detected_at: number; department: string | null; display_name: string | null }

export function NewWaysOfWorking({ confirmedTotal, confirmedRecent }: { confirmedTotal: number | null; confirmedRecent: number }) {
  const [list, setList] = useState<Candidate[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const load = () => fetch('/api/pulse/capabilities').then(r => (r.ok ? r.json() : null)).then(d => setList(d?.candidates ?? [])).catch(() => setList([]));
  useEffect(() => { load(); }, []);
  if (list === null) return null;
  const act = async (id: number, action: 'confirm' | 'dismiss') => {
    setBusy(id);
    await fetch('/api/pulse/capabilities', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, action }) }).catch(() => {});
    setBusy(null);
    load();
  };
  const oldest = [...list].sort((a, b) => a.detected_at - b.detected_at);
  const days = (s: number) => { const d = Math.floor((Date.now() / 1000 - s) / 86400); return d <= 0 ? 'today' : `${d} ${d === 1 ? 'day' : 'days'}`; };
  return (
    <Frame
      title="New ways of working"
      period="Last 30 days"
      answer={list.length > 0
        ? <><b>{list.length}</b> {list.length === 1 ? 'is' : 'are'} waiting for your review. {confirmedRecent === 0 ? 'None were' : `${confirmedRecent} ${confirmedRecent === 1 ? 'was' : 'were'}`} confirmed this month.</>
        : <>Nothing is waiting for review. {confirmedRecent === 0 ? 'None were' : `${confirmedRecent} ${confirmedRecent === 1 ? 'was' : 'were'}`} confirmed this month.</>}
      note="Claude flags work that creates something reusable; a manager confirms it."
    >
      {oldest.length > 0 && (
        <>
          <div className="text-[12px] font-semibold text-[#333333] mb-0.5">Waiting for review, oldest first</div>
          {oldest.slice(0, 3).map(c => (
            <div key={c.id} className="flex items-center gap-2.5 py-1.5 border-b border-[#F2F2F2] last:border-b-0 text-[13px]">
              <span className="min-w-0 truncate text-[#0A0A0A]">{cleanTitle(c.title)}</span>
              <span className="text-[#777777] whitespace-nowrap">{c.department ? `${c.department} · ` : ''}{days(c.detected_at)}</span>
              <span className="ml-auto flex gap-1.5 shrink-0">
                <button type="button" disabled={busy === c.id} onClick={() => act(c.id, 'confirm')} className={`${B.secondary} !py-0.5 !px-2 !text-[12px]`}>Confirm</button>
                <button type="button" disabled={busy === c.id} onClick={() => act(c.id, 'dismiss')} className={`${B.secondary} !py-0.5 !px-2 !text-[12px]`}>Dismiss</button>
              </span>
            </div>
          ))}
        </>
      )}
      <div className="mt-1.5 text-[13px]">
        {oldest.length > 3 && <><Link href="/admin/pulse?tab=overview" className={linkCls}>and {oldest.length - 3} more</Link> · </>}
        <Link href="#capability-log" className={linkCls}>{confirmedTotal ?? 0} confirmed so far</Link>
      </div>
    </Frame>
  );
}
