// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

/**
 * The Dashboard's Work Pulse section: the four signals as plain questions (panel 10), how deep
 * the work is this month against last (11), the Developer Pulse panel passed in (12), and which
 * skills and connectors are spreading (13). Figures come from /api/pulse/org-summary; every
 * sentence is written here from them, never by the AI.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Panel, Tag, Muted, Empty, Segmented } from '@/components/precision/ui';
import { WORK_PULSE_VENDOR_LABELS, type Vendor } from '@/lib/dashboard/vendor';
import { useOpenAiOnly } from '@/components/shared/VendorSwitch';
import { QuestionCard, changeFrom } from '@/components/dashboard/QuestionCard';

type Tier = { t1: number; t2: number; t3: number };

interface SpreadRow { name: string; people: number; priorPeople: number; isNew: boolean }

interface OrgSummary {
  signalCards: { oti: number | null; dds: number | null; psr: number | null; ors: number | null };
  tierCounts: Tier;
  dashboard?: {
    weeks: number[];
    otiWeeks: Array<number | null>;
    orsWeeks: Array<number | null>;
    tierWeeks: Array<Tier | null>;
    priorTierCounts: Tier;
    capabilityWeeks: number[];
    capabilitiesRecent: number;
    capabilitiesPending: number;
    skillSpread: { total: number; rows: SpreadRow[] };
    connectorSpread: { total: number; rows: SpreadRow[] };
    activePeople30d: number;
  };
}

const T1 = '#CCD1DB', T2 = '#8DB2FC', T3 = '#3D6CE8';

const total = (t: Tier) => t.t1 + t.t2 + t.t3;
const deep = (t: Tier) => (total(t) > 0 ? (t.t2 + t.t3) / total(t) : null);
const pct = (v: number) => `${Math.round(v * 100)}%`;

/** The last non-null value, and the value four weeks before it. */
function nowAndBefore(series: Array<number | null>): { now: number | null; before: number | null } {
  const idx = series.map(v => v !== null).lastIndexOf(true);
  if (idx < 0) return { now: null, before: null };
  return { now: series[idx], before: idx >= 4 ? series[idx - 4] : null };
}

/* ── 10: Work Pulse, four questions ─────────────────────────────── */

function WorkPulsePanel({ data, product }: { data: OrgSummary; product: string }) {
  const d = data.dashboard;
  const now = deep(data.tierCounts);
  const before = d ? deep(d.priorTierCounts) : null;
  const oti = d ? nowAndBefore(d.otiWeeks) : { now: null, before: null };
  const ors = d ? nowAndBefore(d.orsWeeks) : { now: null, before: null };
  const otiNow = data.signalCards.oti ?? oti.now;
  const orsNow = data.signalCards.ors ?? ors.now;
  const answer = now === null
    ? null
    : before === null
      ? <><b>{pct(now)}</b> of the work people handed {product} in the last 30 days was meaningful or frontier.</>
      : <>People are handing {product} {now > before ? 'deeper' : now < before ? 'less deep' : 'the same depth of'} work: <b>{pct(now)}</b> of it was meaningful or frontier, {Math.round(now * 100) === Math.round(before * 100) ? 'the same as' : now > before ? 'up from' : 'down from'} <b>{pct(before)}</b>{Math.round(now * 100) === Math.round(before * 100) ? ' the 30 days before' : ''}.</>;
  return (
    <section className="bg-white border border-[#EAEAEA] rounded-[14px] px-4 py-3.5">
      <div className="flex items-baseline gap-2 flex-wrap">
        <h2 className="m-0 text-[14px] font-semibold text-[#0A0A0A]">Work Pulse</h2>
        <Tag tone="judged">AI-judged</Tag>
        <span className="ml-auto text-[12px] text-[#8F8F8F]">Last 30 days against the 30 before</span>
      </div>
      {answer && <p className="m-0 mt-2 text-[15px] leading-6 text-[#0A0A0A] [&_b]:font-semibold">{answer}</p>}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-2.5 mt-3">
        <QuestionCard
          question="Is the work getting more valuable?"
          judged
          value={otiNow !== null ? `${otiNow.toFixed(2)}×` : undefined}
          unit={otiNow !== null ? 'baseline' : undefined}
          change={changeFrom(oti.now, oti.before, v => `${v.toFixed(2)}×`, 'four weeks ago')}
          trend={d?.otiWeeks}
          notMeasured={otiNow === null ? 'Needs a baseline and recent classified work' : undefined}
        />
        <QuestionCard
          question="How much is meaningful or frontier?"
          judged
          value={now !== null ? pct(now) : undefined}
          change={now !== null && before !== null ? changeFrom(now, before, pct, 'the 30 days before') : null}
          trend={d?.tierWeeks.map(t => (t ? deep(t) : null))}
          notMeasured={now === null ? 'No classified work in the last 30 days' : undefined}
        />
        <QuestionCard
          question="New capabilities confirmed"
          value={d ? String(d.capabilitiesRecent) : undefined}
          unit="last 30 days"
          sub={<>{data.signalCards.psr ?? 0} in all{d && d.capabilitiesPending > 0 ? <> · <Link href="/admin/pulse?tab=overview" className="text-[#245BF3] hover:underline">{d.capabilitiesPending} waiting for review</Link></> : null}</>}
          trend={d?.capabilityWeeks}
          trendKind="bars"
          notMeasured={!d ? 'Not available' : undefined}
        />
        <QuestionCard
          question="Is know-how shared, or held by a few?"
          judged
          value={orsNow !== null ? orsNow.toFixed(2) : undefined}
          unit={orsNow !== null ? 'of 1' : undefined}
          change={changeFrom(ors.now, ors.before, v => v.toFixed(2), 'four weeks ago')}
          trend={d?.orsWeeks}
          notMeasured={orsNow === null ? 'Needs departments with several active people' : undefined}
        />
      </div>
      <p className="m-0 mt-3 pt-2.5 border-t border-dashed border-[#EAEAEA] text-[12px] text-[#8F8F8F]">
        Claude reads each prompt and judges its depth; capabilities are confirmed by a manager. Lines show the last 8 weeks. <Link href="/pulse/cio" className="text-[#245BF3] font-medium hover:underline">Open Work Pulse</Link>
      </p>
    </section>
  );
}

/* ── 11: How deep is the work? This month against last ─────────── */

function DepthPanel({ now, before, product }: { now: Tier; before: Tier | null; product: string }) {
  if (total(now) === 0) {
    return <Panel title="How deep is the work?" right={<Tag tone="judged">AI-judged</Tag>}><Muted>No classified work in the last 30 days.</Muted></Panel>;
  }
  const f = (t: Tier) => (total(t) > 0 ? t.t3 / total(t) : 0);
  const hasBefore = before !== null && total(before) > 0;
  const answer = hasBefore
    ? <>Frontier work {f(now) > f(before!) ? 'rose' : f(now) < f(before!) ? 'fell' : 'held'} {Math.round(f(now) * 100) === Math.round(f(before!) * 100) ? 'at' : `from ${pct(f(before!))} to`} <b>{pct(f(now))}</b> of everything people handed {product}.</>
    : <>Frontier work was <b>{pct(f(now))}</b> of everything people handed {product} in the last 30 days.</>;
  const row = (label: string, t: Tier, bold: boolean) => (
    <div className="grid grid-cols-[96px_minmax(0,1fr)_44px] gap-2.5 items-center text-[13px] py-1.5">
      <span className="text-[#333333]">{label}</span>
      <div className="flex h-[22px] rounded-[3px] overflow-hidden gap-[2px]">
        {t.t1 > 0 && <span style={{ flex: t.t1, background: T1 }} title={`Routine ${pct(t.t1 / total(t))}`} />}
        {t.t2 > 0 && <span style={{ flex: t.t2, background: T2 }} title={`Meaningful ${pct(t.t2 / total(t))}`} />}
        {t.t3 > 0 && <span style={{ flex: t.t3, background: T3 }} title={`Frontier ${pct(t.t3 / total(t))}`} />}
      </div>
      <span className={`text-right tabular-nums ${bold ? 'font-semibold text-[#0A0A0A]' : 'text-[#666666]'}`}>{pct(deep(t)!)}</span>
    </div>
  );
  return (
    <section className="bg-white border border-[#EAEAEA] rounded-[14px] px-4 py-3.5 h-full">
      <div className="flex items-baseline gap-2">
        <h2 className="m-0 text-[14px] font-semibold text-[#0A0A0A]">How deep is the work?</h2>
        <Tag tone="judged">AI-judged</Tag>
        <span className="ml-auto text-[12px] text-[#8F8F8F]">30 days</span>
      </div>
      <p className="m-0 mt-2 mb-2 text-[15px] leading-6 text-[#0A0A0A] [&_b]:font-semibold">{answer}</p>
      {hasBefore && row('30 days before', before!, false)}
      {row('Last 30 days', now, true)}
      <div className="flex flex-wrap gap-x-3.5 gap-y-1 mt-2 text-[12px] text-[#666666]">
        <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-[2px]" style={{ background: T1 }} />Routine</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-[2px]" style={{ background: T2 }} />Meaningful</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-[2px]" style={{ background: T3 }} />Frontier</span>
        <span className="ml-auto">right: meaningful or frontier</span>
      </div>
    </section>
  );
}

/* ── 13: Which skills and connectors are spreading? ─────────────── */

function formatName(kind: 'skills' | 'connectors', name: string): string {
  return kind === 'skills' ? name.replace(':', ' · ') : name.replace(/^mcp__/, '').replace(/_/g, ' ');
}

function SpreadPanel({ skills, connectors, activePeople }: { skills: { total: number; rows: SpreadRow[] }; connectors: { total: number; rows: SpreadRow[] }; activePeople: number }) {
  const [kind, setKind] = useState<'skills' | 'connectors'>('skills');
  const list = kind === 'skills' ? skills : connectors;
  const one = kind === 'skills' ? 'skill' : 'connector';
  const rows = list.rows;
  const grower = [...rows].sort((a, b) => (b.people - b.priorPeople) - (a.people - a.priorPeople))[0];
  const answer = rows.length === 0
    ? <>No {kind} used in the last 30 days.</>
    : grower && grower.people - grower.priorPeople > 0
      ? <><b>{formatName(kind, grower.name)}</b> reached {grower.people} {grower.people === 1 ? 'person' : 'people'} in the last 30 days, up from {grower.priorPeople}.</>
      : <>No {one} is spreading: <b>{formatName(kind, rows[0].name)}</b> reaches the most people, {rows[0].people}.</>;
  const max = Math.max(1, activePeople, ...rows.map(r => r.people));
  const change = (r: SpreadRow) => {
    const d = r.people - r.priorPeople;
    return d === 0 ? 'same' : d > 0 ? `+${d}` : `−${-d}`;
  };
  return (
    <section className="bg-white border border-[#EAEAEA] rounded-[14px] px-4 py-3.5">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="m-0 text-[14px] font-semibold text-[#0A0A0A]">Which skills and connectors are spreading?</h2>
        <Tag tone="measured">Measured</Tag>
        <span className="ml-auto flex items-center gap-3">
          <span className="text-[12px] text-[#8F8F8F]">Last 30 days</span>
          <Segmented label="Skills or connectors" value={kind} onChange={setKind} options={[{ value: 'skills', label: 'Skills' }, { value: 'connectors', label: 'Connectors' }]} />
        </span>
      </div>
      <p className="m-0 mt-2 mb-2 text-[15px] leading-6 text-[#0A0A0A] [&_b]:font-semibold">{answer}</p>
      {rows.length > 0 && (
        <div>
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_90px] gap-3 text-[12px] text-[#8F8F8F] py-1 border-b border-[#EAEAEA]">
            <span>{kind === 'skills' ? 'Skill' : 'Connector'}</span><span>People using it, of {activePeople} active</span><span className="text-right">Change</span>
          </div>
          {rows.map(r => {
            const grew = r.people - r.priorPeople;
            return (
              <div key={r.name} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_90px] gap-3 items-center text-[13px] py-1.5 border-b border-[#F2F2F2] last:border-b-0">
                <span className="truncate text-[#0A0A0A]">
                  {formatName(kind, r.name)}
                  {r.isNew && <span className="ml-1.5 text-[10px] font-bold text-[#05073F] bg-[#E8E9F2] rounded-[3px] px-1 align-[1px]">NEW</span>}
                </span>
                <span className="relative h-2 rounded-[2px] bg-[#F2F2F4]"><span className="absolute inset-y-0 left-0 rounded-[2px] bg-[#3D4451]" style={{ width: `${(r.people / max) * 100}%` }} /></span>
                <span className={`text-right tabular-nums ${grew > 0 ? 'font-semibold text-[#0A0A0A]' : 'text-[#666666]'}`}>{r.people} · {change(r)}</span>
              </div>
            );
          })}
        </div>
      )}
      <p className="m-0 mt-3 pt-2.5 border-t border-dashed border-[#EAEAEA] text-[12px] text-[#8F8F8F]">
        Bars count the people using each {one}, not how often it was used, so one that is spreading stands out. Change is against the 30 days before; new means first used in the last 30 days.
        {list.total > rows.length ? ` Top ${rows.length} of ${list.total} shown.` : ''} <Link href="/library" className="text-[#245BF3] font-medium hover:underline">See all on the S&amp;C Board</Link>
      </p>
    </section>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function PulseBand({ children, vendor = 'all', showVendor = false }: {
  children?: React.ReactNode;
  /** The dashboard's vendor switch: narrows every figure here. */
  vendor?: Vendor;
  /** OpenAI data is present: name both products in the sentences. */
  showVendor?: boolean;
}) {
  const openaiOnly = useOpenAiOnly();
  const [data, setData] = useState<OrgSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/pulse/org-summary?vendor=${vendor}`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [vendor]);

  const product = vendor === 'openai' ? 'ChatGPT' : vendor === 'claude' || !showVendor ? 'Claude' : 'Claude and ChatGPT';
  const hasData = data && (
    data.signalCards.oti !== null || data.signalCards.dds !== null || data.signalCards.psr !== null || data.signalCards.ors !== null ||
    total(data.tierCounts) > 0
  );

  return (
    <div className="flex flex-col gap-4">
      {loading && <Panel><Muted>Loading Work Pulse…</Muted></Panel>}
      {!loading && !hasData && <Empty title="No Work Pulse data yet">Work appears here once Claude has classified it.</Empty>}
      {(loading || !hasData) && children}

      {!loading && hasData && data && (
        <>
          {vendor !== 'all' && !openaiOnly && (
            <p className="m-0 -mb-2 text-[13px] text-[#8F8F8F]">
              Work Pulse shows {WORK_PULSE_VENDOR_LABELS[vendor]} only{vendor === 'openai' ? ', and Developer Pulse below shows Codex only' : ', and Developer Pulse below shows Claude Code only'}.
            </p>
          )}
          <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-4 items-stretch">
            <WorkPulsePanel data={data} product={product} />
            <DepthPanel now={data.tierCounts} before={data.dashboard?.priorTierCounts ?? null} product={product} />
          </div>

          {children}

          {data.dashboard && (
            <SpreadPanel skills={data.dashboard.skillSpread} connectors={data.dashboard.connectorSpread} activePeople={data.dashboard.activePeople30d} />
          )}
        </>
      )}
    </div>
  );
}
