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
import { Tag, B, Muted, LOAD_FAILED } from '@/components/precision/ui';
import { DASH, shareWords, sharePair, cap } from '@/components/dashboard/QuestionCard';
import { cleanTitle } from '@/components/pulse/CapabilityLog';
import type { ByProductData } from '@/components/pulse/ByProductPanel';
import type { SessionOutputReport } from '@/components/pulse/SessionOutputCard';
import type { HumanTimeSummary } from '@/components/pulse/HumanTimeCard';
import type { ActNextItem, DeptProcessBoxItem } from '@/components/pulse/ActNextPanel';
import { depthColumns, depthSentence, DepthChart, DepthSwitch, type DepthWindow, type TierWeek } from '@/components/pulse/DepthChart';
import { deepWords, tierNamesOr, type TierNames } from '@/lib/pulse/tier-names';
import { FAMILY_LABEL, PRODUCT_FAMILY, PRODUCT_LABEL, type WorkProduct } from '@/lib/pulse/cowork/products';
import { NEW_WAYS_OF_WORKING } from '@/lib/pulse/cowork/coaching-words';
import type { Vendor } from '@/lib/dashboard/vendor';

const AMBER = '#DC8A00';
const words = (v: number) => (v < 0.15 ? `${Math.round(v * 100)}%` : shareWords(v));

/* ── Frame shared by every panel ────────────────────────────────── */

export function Frame({ title, judged, tag, period, answer, children, note, id }: {
  title: string; judged?: boolean; tag?: string; period?: ReactNode; answer?: ReactNode; children?: ReactNode; note?: ReactNode; id?: string;
}) {
  return (
    <section id={id} className="bg-white border border-[#EAEAEA] rounded-[14px] px-4 py-3.5 min-w-0">
      <div className="flex items-baseline gap-2 flex-wrap">
        <h2 className="m-0 text-[14px] font-semibold text-[#0A0A0A]">{title}</h2>
        {(judged || tag) && <Tag tone="neutral">{tag ?? 'AI-judged'}</Tag>}
        {period && <span className="ml-auto text-[12px] text-[#8F8F8F]">{period}</span>}
      </div>
      {answer && <p className="m-0 mt-2 mb-2.5 text-[14px] leading-[22px] text-[#1A1A1A] [&_b]:font-semibold">{answer}</p>}
      {children}
      {note && <p className="m-0 mt-3 pt-2 border-t border-dashed border-[#EAEAEA] text-[12px] text-[#8F8F8F]">{note}</p>}
    </section>
  );
}

export function Track({ value, colour = DASH, floor, striped }: { value: number; colour?: string; floor?: number | null; striped?: boolean }) {
  return (
    <span className="relative block h-[6px] rounded-[3px] bg-[#F1F1F3]">
      <span className="absolute inset-y-0 left-0 rounded-[3px]" style={{ width: `${Math.max(0.5, Math.min(100, value * 100))}%`, background: striped ? `repeating-linear-gradient(45deg, ${colour} 0 3px, #fff 3px 6px)` : colour }} />
      {floor != null && <span className="absolute -top-1 -bottom-1 border-l-[1.5px] border-dashed border-[#555555]" style={{ left: `${floor * 100}%` }} />}
    </span>
  );
}

export const linkCls = 'text-[#1F6F8B] font-medium hover:underline';

/* ── 2: Use cases to act on next ───────────────────────────────── */

export function UseCasesNext({ boxes, items, failed = false }: { boxes: DeptProcessBoxItem[]; items: ActNextItem[]; failed?: boolean }) {
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
  if (rows.length === 0) return (
    <Frame title="Use cases to act on next" period="Updated weekly">
      <Muted>{failed ? LOAD_FAILED : 'Nothing to act on yet. Work that repeats, and people who could use coaching, show here.'}</Muted>
    </Frame>
  );
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

/** The organisation chart has no per-week grid, so it offers the three longer views only. */
export type OrgDepthWindow = 13 | 26 | 52;
const ORG_WINDOWS: DepthWindow[] = [13, 26, 52];

/** The weeks each end of a then-vs-now compares (lib/pulse/delegation.ts: up to 4, half the weeks with data). */
const weeksWord = (dataWeeks?: number) => { const k = Math.max(1, Math.min(4, Math.floor((dataWeeks ?? 8) / 2))); return k === 1 ? 'week' : `${k} weeks`; };
interface DeptTrend { dept: string; thenVsNow: { then: number; now: number; deltaPp: number; arrow: 'up' | 'flat' | 'down'; dataWeeks?: number } | null }

export function BiggerJobs({ weeks, departments, product, window, onWindow, names }: {
  weeks: TierWeek[]; departments: DeptTrend[]; product: string; window: OrgDepthWindow; onWindow: (w: OrgDepthWindow) => void; names?: TierNames;
}) {
  const t = tierNamesOr(names);
  const cols = depthColumns(weeks, window, Math.floor(Date.now() / 1000));
  const falling = departments.filter(d => d.thenVsNow?.arrow === 'down').sort((a, b) => a.thenVsNow!.deltaPp - b.thenVsNow!.deltaPp);
  const others = falling.length === 1 ? ` ${falling[0].dept} is going the other way.` : falling.length > 1 ? ` ${falling.length} departments are going the other way.` : '';
  return (
    <Frame
      title={`Are people handing ${product} bigger jobs?`}
      judged
      period={<DepthSwitch window={window} onWindow={w => onWindow(w as OrgDepthWindow)} windows={ORG_WINDOWS} />}
      answer={<>{depthSentence(cols, window, '', names)}{others}</>}
      note={`Each column is one ${window === 52 ? 'calendar month' : 'completed week, Monday to Sunday'}, split into ${t.t1.toLowerCase()}, ${t.t2.toLowerCase()} and ${t.t3.toLowerCase()} tasks.`}
    >
      <DepthChart cols={cols} names={names} />
      {falling.length > 0 && (
        <div className="mt-3 pt-2 border-t border-[#EAEAEA]">
          <div className="text-[12px] font-semibold text-[#333333] mb-0.5">Going the other way</div>
          {falling.slice(0, 3).map(d => (
            <div key={d.dept} className="flex gap-2.5 items-center py-1 text-[13px]">
              <Link href={`/pulse/dept?dept=${encodeURIComponent(d.dept)}`} className="text-[#0A0A0A] hover:text-[#1F6F8B]">{d.dept}</Link>
              <span className="text-[#777777]">{deepWords(names)} work was {sharePair(d.thenVsNow!.now, d.thenVsNow!.then)[0]} of tasks in the last {weeksWord(d.thenVsNow!.dataWeeks)}</span>
              <span className="ml-auto text-[#333333]">down from {sharePair(d.thenVsNow!.now, d.thenVsNow!.then)[1]} in the first {weeksWord(d.thenVsNow!.dataWeeks)}</span>
            </div>
          ))}
        </div>
      )}
    </Frame>
  );
}

/* ── 4: Which departments do the deepest work? ───────────────────── */

export function DeptRealWork({ rows, floorPct, names }: { rows: Array<{ dept: string; share: number; tasks: number }>; floorPct: number | null; names?: TierNames }) {
  const deep = deepWords(names);
  if (rows.length === 0) return (
    <Frame title={`Which departments are doing ${deep} work?`} judged period="Last 4 weeks">
      <Muted>No department has classified tasks in the last 4 weeks yet.</Muted>
    </Frame>
  );
  const floor = floorPct !== null ? floorPct / 100 : null;
  const below = floor === null ? [] : rows.filter(r => r.share < floor);
  const top = rows[0];
  const list = (xs: string[]) => (xs.length <= 1 ? xs[0] ?? '' : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
  const answer = below.length === 0
    ? <>Every department is above your floor of {words(floor ?? 0)} tasks being {deep}. <b>{top.dept}</b> does the most.</>
    : below.length <= 3
      ? <><b>{list(below.map(b => b.dept))}</b> {below.length === 1 ? 'is' : 'are'} below your floor of {words(floor!)}. {top.dept} does the most.</>
      : <><b>{below.length} of {rows.length}</b> departments are below your floor of {words(floor!)}. {top.dept} does the most.</>;
  return (
    <Frame
      title={`Which departments are doing ${deep} work?`}
      judged
      period="Last 4 weeks"
      answer={answer}
      note={<>Each bar is the share of the department&apos;s tasks that were {deep}.{floor !== null ? ` The dashed line is your floor, set in Admin → System; departments below it are amber.` : ''} <Link href="/pulse/dept" className={linkCls}>See every department and its people</Link></>}
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

export function Produced({ output, human, loading = false }: { output: SessionOutputReport | null | undefined; human: HumanTimeSummary | null | undefined; loading?: boolean }) {
  if (!output?.hasData) return (
    <Frame title="What did the work produce?" period="Last quarter">
      <Muted>{loading ? 'Loading…' : !output ? LOAD_FAILED : 'No sessions in the last quarter yet.'}</Muted>
    </Frame>
  );
  const kinds = [...(output.byTaskType ?? [])].sort((a, b) => b.rate - a.rate);
  const shown = kinds.slice(0, 5);
  const ratio = human?.ratio ?? null;
  const h = (m: number) => Math.round(m / 60).toLocaleString('en-GB');
  const times = ratio === null ? null : ratio >= 1.8 && ratio < 2.5 ? 'about twice as long' : ratio >= 2.5 && ratio < 3.5 ? 'about three times as long' : `about ${Math.round(ratio)} times as long`;
  return (
    <Frame
      title="What did the work produce?"
      tag={times ? 'Includes an estimate' : undefined}
      period="Last quarter"
      answer={<>{output.rate === null ? 'Not measured yet.' : <><b>{cap(words(output.rate))}</b> {output.rate >= 1 ? '' : 'of the '}sessions produced a file.</>}{times ? <> By hand, the same work would have taken <b>{times}</b>.</> : null}</>}
      note={<>A session produced a file when Claude saved, sent or published one, in Claude Chat when a reply made an artifact or a file, and in ChatGPT when a reply listed a file.{times ? ' The by-hand time is Claude’s estimate.' : ''}</>}
    >
      {ratio !== null && human && (
        <div className="mb-3">
          {[[`With ${human.byProduct ? 'AI' : 'Claude'}`, human.claudeMinutes, false], ['By hand (estimate)', human.humanMinutes.likely, true]].map(([l, m, est]) => (
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

export function Products({ data, names, loading = false }: { data: ByProductData | null | undefined; names?: TierNames; loading?: boolean }) {
  if (!data) return (
    <Frame title="Which products are people using?" period="Last 30 days">
      <Muted>{loading ? 'Loading…' : LOAD_FAILED}</Muted>
    </Frame>
  );
  const label = (p: string) => (p === 'claude_chat' ? 'Claude Chat' : p === 'chatgpt' ? 'ChatGPT' : p === 'cowork' ? 'Claude Cowork' : PRODUCT_LABEL[p as WorkProduct] ?? p);
  const family = (p: string) => (p === 'claude_chat' || p === 'chatgpt' || p === 'cowork' ? null : PRODUCT_FAMILY[p as WorkProduct] ?? null);
  const rows = data.rows.filter(r => r.product !== 'all');
  const lead = [...rows].sort((a, b) => b.people - a.people)[0];
  const max = Math.max(1, ...rows.map(r => r.people));
  let lastFamily: string | null = null;
  return (
    <Frame
      title="Which products are people using?"
      tag="Partly AI-judged"
      period="Last 30 days"
      answer={lead && lead.people > 0
        ? <>{label(lead.product)} is used by the most people: <b>{lead.people.toLocaleString('en-GB')}</b>{lead.meaningfulPct !== null ? <>, and <b>{words(lead.meaningfulPct / 100)}</b> of their tasks are {deepWords(names)}</> : null}.</>
        : <>No product has been used in the last 30 days.</>}
      note={<>{tierNamesOr(names).t2} and {tierNamesOr(names).t3} are Claude&apos;s judgement of each task. Produced counts sessions where Claude saved, sent or published a file, Claude Chat conversations where a reply made an artifact or a file, and ChatGPT conversations where a reply listed a file. Spend for each product is on <Link href="/finops" className={linkCls}>FinOps</Link>.</>}
    >
      <div className="grid grid-cols-[minmax(0,130px)_minmax(0,1fr)_56px_64px_70px] gap-2.5 text-[11px] text-[#8F8F8F] pb-1">
        <span /> <span>People</span><span className="text-right">Sessions</span><span className="text-right">{tierNamesOr(names).t2}+</span><span className="text-right">Produced</span>
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

interface Candidate { id: number; title: string; detected_at: number; department: string | null; display_name: string | null; description?: string | null }

export function NewWaysOfWorking({ confirmedTotal, confirmedRecent, vendor }: { confirmedTotal: number | null; confirmedRecent: number; vendor: Vendor }) {
  const [list, setList] = useState<Candidate[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const load = () => fetch(`/api/pulse/capabilities?vendor=${vendor}`).then(r => (r.ok ? r.json() : null)).then(d => setList(d?.candidates ?? [])).catch(() => setList([]));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [vendor]);
  if (list === null) return null;
  const act = async (id: number, action: 'confirm' | 'dismiss') => {
    setBusy(id);
    await fetch('/api/pulse/capabilities', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, action }) }).catch(() => {});
    setBusy(null);
    load();
  };
  const oldest = [...list].sort((a, b) => a.detected_at - b.detected_at);
  const days = (s: number) => { const d = Math.floor((Date.now() / 1000 - s) / 86400); return d <= 0 ? 'under a day' : `${d} ${d === 1 ? 'day' : 'days'}`; };
  return (
    <Frame
      title="New ways of working"
      period="Last quarter"
      answer={list.length > 0
        ? <><b>{list.length}</b> {list.length === 1 ? 'is' : 'are'} waiting for your review. {confirmedRecent === 0 ? 'None were' : `${confirmedRecent} ${confirmedRecent === 1 ? 'was' : 'were'}`} confirmed in the last quarter.</>
        : <>Nothing is waiting for review. {confirmedRecent === 0 ? 'None were' : `${confirmedRecent} ${confirmedRecent === 1 ? 'was' : 'were'}`} confirmed in the last quarter.</>}
      note={NEW_WAYS_OF_WORKING}
    >
      {oldest.length > 0 && (
        <>
          <div className="text-[12px] font-semibold text-[#333333] mb-0.5">Waiting for review, oldest first</div>
          {oldest.slice(0, 3).map(c => (
            <div key={c.id} className="flex items-center gap-2.5 py-1.5 border-b border-[#F2F2F2] last:border-b-0 text-[13px]">
              <span className="min-w-0 truncate text-[#0A0A0A]" title={c.description ?? undefined}>{c.description ?? cleanTitle(c.title)}</span>
              <span className="text-[#777777] whitespace-nowrap">{c.display_name ? `${c.display_name} · ` : ''}{c.department ? `${c.department} · ` : ''}{days(c.detected_at)} ago</span>
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
