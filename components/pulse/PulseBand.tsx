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
import { QuestionCard, DASH, DASH_SHADES, shareWords, cap } from '@/components/dashboard/QuestionCard';

type Tier = { t1: number; t2: number; t3: number };

interface SpreadRow { name: string; people: number; priorPeople: number; isNew: boolean }

export interface OrgSummary {
  signalCards: { oti: number | null; dds: number | null; psr: number | null; ors: number | null };
  tierCounts: Tier;
  dashboard?: {
    window?: 'month' | 'quarter';
    tierCounts?: Tier;
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
    deepPeople30d?: number;
    deepPeopleWeeks?: number[];
    frontierPeople30d?: number;
    frontierHalfPeople?: number | null;
    frontierTopShare?: number | null;
  };
}

const [T1, T2, T3] = DASH_SHADES;

const total = (t: Tier) => t.t1 + t.t2 + t.t3;
const deep = (t: Tier) => (total(t) > 0 ? (t.t2 + t.t3) / total(t) : null);
const pct = (v: number) => `${Math.round(v * 100)}%`;

/* ── 10: Work Pulse, four questions ─────────────────────────────── */

export function WorkPulsePanel({ data, product, title = 'Work Pulse', actions = false }: { data: OrgSummary; product: string; title?: string; /** Add a line under each card saying what to do. */ actions?: boolean }) {
  const d = data.dashboard;
  const q = d?.window === 'quarter';
  const span = q ? 'the last quarter' : 'the last 30 days';
  const prior = q ? 'the quarter before' : 'the month before';
  const now = deep(d?.tierCounts ?? data.tierCounts);
  const before = d ? deep(d.priorTierCounts) : null;
  const people = d?.deepPeople30d ?? null;
  const active = d?.activePeople30d ?? null;
  const half = d?.frontierHalfPeople ?? null;
  const shareChange = now !== null && before !== null
    ? (Math.round(now * 100) === Math.round(before * 100) ? `the same as ${prior}` : `${now > before ? 'up' : 'down'} from ${shareWords(before) === 'half' ? 'about half' : shareWords(before)} ${prior}`)
    : null;
  const answer = people !== null && active !== null && people > 0
    ? <><b>{people} of {active}</b> people handed {product} real work in {span}{now !== null ? <>, and <b>{shareWords(now)}</b> of all the tasks they gave it were real work</> : null}.</>
    : now !== null
      ? <><b>{cap(shareWords(now))}</b> of the tasks people handed {product} in {span} were real work.</>
      : null;
  return (
    <section className="bg-white border border-[#EAEAEA] rounded-[14px] px-4 py-3.5">
      <div className="flex items-baseline gap-2 flex-wrap">
        <h2 className="m-0 text-[14px] font-semibold text-[#0A0A0A]">{title}</h2>
        <Tag tone="neutral">AI-judged</Tag>
        <span className="ml-auto text-[12px] text-[#8F8F8F]">{q ? 'Last quarter against the quarter before' : 'Last 30 days against the 30 before'}</span>
      </div>
      {answer && <p className="m-0 mt-2 text-[14px] leading-[22px] text-[#1A1A1A] [&_b]:font-semibold">{answer}</p>}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-2.5 mt-3">
        <QuestionCard
          question="People doing real work with it"
          value={people !== null && active !== null ? `${people} of ${active}` : undefined}
          unit="people"
          trend={d?.deepPeopleWeeks}
          trendKind="bars"
          notMeasured={people === null ? 'No classified work yet' : undefined}
          todo={actions && people !== null && active !== null
            ? (active - people > 0
              ? <>{active - people} {active - people === 1 ? 'person only uses' : 'people only use'} it for routine tasks. <Link href="/pulse/users" className="text-[#1F6F8B] font-medium hover:underline">See who</Link></>
              : 'Everyone active is doing some real work.')
            : undefined}
        />
        <QuestionCard
          question="Tasks that are real work"
          value={now !== null ? cap(shareWords(now)) : undefined}
          change={shareChange}
          trend={d?.tierWeeks.map(t => (t ? deep(t) : null))}
          notMeasured={now === null ? `No classified work in ${span}` : undefined}
          todo={actions && now !== null && before !== null
            ? (Math.round(now * 100) > Math.round(before * 100) ? 'Rising. Nothing to do.'
              : Math.round(now * 100) < Math.round(before * 100) ? 'Falling. See the departments below.' : 'Steady.')
            : undefined}
        />
        <QuestionCard
          question="New ways of working"
          value={d ? (d.capabilitiesRecent === 0 ? 'None' : String(d.capabilitiesRecent)) : undefined}
          unit={q ? 'confirmed this quarter' : 'confirmed this month'}
          sub={d && d.capabilitiesPending > 0
            ? <Link href="/admin/pulse?tab=overview" className="text-[#1F6F8B] font-medium hover:underline">{d.capabilitiesPending} waiting for your review</Link>
            : undefined}
          trend={d?.capabilityWeeks}
          trendKind="bars"
          notMeasured={!d ? 'Not available' : undefined}
          todo={actions && d ? (d.capabilitiesPending > 0 ? 'Confirm the ones that are real, below.' : 'Nothing waiting for review.') : undefined}
        />
        <QuestionCard
          question="Frontier work rests on"
          value={half !== null ? (half === 1 ? 'One person' : `${half} people`) : undefined}
          sub={half !== null && d ? <>They do half of it, out of {d.frontierPeople30d} doing any. <Link href="/pulse/cio" className="text-[#1F6F8B] font-medium hover:underline">See who</Link></> : undefined}
          notMeasured={half === null ? `No frontier work in ${span}` : undefined}
          todo={actions && d?.frontierTopShare != null
            ? <>If the busiest person left, {d.frontierTopShare < 0.15 ? `${Math.round(d.frontierTopShare * 100)}%` : shareWords(d.frontierTopShare)} of it would go. <Link href="/pulse/dept" className="text-[#1F6F8B] font-medium hover:underline">See who</Link></>
            : undefined}
        />
      </div>
      <p className="m-0 mt-3 pt-2.5 border-t border-dashed border-[#EAEAEA] text-[12px] text-[#8F8F8F]">
        Real work means a task Claude judged meaningful or frontier, not routine. A new way of working is one a manager has confirmed. {q ? 'Bars and lines show the quarter week by week.' : 'Bars and lines show the last 8 weeks.'} <Link href="/pulse/cio" className="text-[#1F6F8B] font-medium hover:underline">Open Work Pulse</Link>
      </p>
    </section>
  );
}

/* ── 11: How deep is the work? This month against last ─────────── */

function DepthPanel({ now, before, product }: { now: Tier; before: Tier | null; product: string }) {
  if (total(now) === 0) {
    return <Panel title="How deep is the work?" right={<Tag tone="neutral">AI-judged</Tag>}><Muted>No classified work in the last 30 days.</Muted></Panel>;
  }
  const f = (t: Tier) => (total(t) > 0 ? t.t3 / total(t) : 0);
  const hasBefore = before !== null && total(before) > 0;
  const answer = hasBefore
    ? <>Frontier work {f(now) > f(before!) ? 'rose' : f(now) < f(before!) ? 'fell' : 'held'} {Math.round(f(now) * 100) === Math.round(f(before!) * 100) ? 'at' : `from ${pct(f(before!))} to`} <b>{pct(f(now))}</b> of everything people handed {product}.</>
    : <>Frontier work was <b>{pct(f(now))}</b> of everything people handed {product} in the last 30 days.</>;
  const row = (label: string, t: Tier, bold: boolean) => (
    <div className="grid grid-cols-[96px_minmax(0,1fr)_44px] gap-2.5 items-center text-[13px] py-1.5">
      <span className="text-[#333333]">{label}</span>
      <div className="flex h-[14px] rounded-[3px] overflow-hidden gap-[2px]">
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
        <Tag tone="neutral">AI-judged</Tag>
        <span className="ml-auto text-[12px] text-[#8F8F8F]">30 days</span>
      </div>
      <p className="m-0 mt-2 mb-2 text-[14px] leading-[22px] text-[#1A1A1A] [&_b]:font-semibold">{answer}</p>
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
        <Tag tone="neutral">Measured</Tag>
        <span className="ml-auto flex items-center gap-3">
          <span className="text-[12px] text-[#8F8F8F]">Last 30 days</span>
          <Segmented label="Skills or connectors" value={kind} onChange={setKind} options={[{ value: 'skills', label: 'Skills' }, { value: 'connectors', label: 'Connectors' }]} />
        </span>
      </div>
      <p className="m-0 mt-2 mb-2 text-[14px] leading-[22px] text-[#1A1A1A] [&_b]:font-semibold">{answer}</p>
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
                  {r.isNew && <span className="ml-1.5 text-[10px] font-bold text-[#1F6F8B] bg-[#E4EFF3] rounded-[3px] px-1 align-[1px]">NEW</span>}
                </span>
                <span className="relative h-[6px] rounded-[3px] bg-[#F1F1F3]"><span className="absolute inset-y-0 left-0 rounded-[3px]" style={{ width: `${(r.people / max) * 100}%`, background: DASH }} /></span>
                <span className={`text-right tabular-nums ${grew > 0 ? 'font-semibold text-[#0A0A0A]' : 'text-[#666666]'}`}>{r.people} · {change(r)}</span>
              </div>
            );
          })}
        </div>
      )}
      <p className="m-0 mt-3 pt-2.5 border-t border-dashed border-[#EAEAEA] text-[12px] text-[#8F8F8F]">
        Bars count the people using each {one}, not how often it was used, so one that is spreading stands out. Change is against the 30 days before; new means first used in the last 30 days.
        {list.total > rows.length ? ` Top ${rows.length} of ${list.total} shown.` : ''} <Link href="/library" className="text-[#1F6F8B] font-medium hover:underline">See all on the S&amp;C Board</Link>
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
