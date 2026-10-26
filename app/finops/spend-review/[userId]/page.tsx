// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { Fragment, Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { sessionsFact, spansDays } from '@/lib/finance/spend-review-format';
import { CostDrivers, shadeForModel, prettyModel, type CostDriverFigures } from '@/components/finance/ModelEfficiencySection';
import { MonthPicker, monthOptions, monthName, money, pct, ukDate, duration, LimitsNotice, LimitBar, UpdatedLine, type LimitsStatus } from '@/components/spend-review/shared';
import { PageBody, Toolbar, Panel, PanelFoot, Strip, Figure, T, B, Tag, Pill, Notice, Muted, SubHead, Bar, cx } from '@/components/precision/ui';
import { formatModelLabel } from '@/lib/pulse/code/model-label';
import { displayDefinition } from '@/lib/pulse/code/work-type-labels';
import WhereMoneyWent from '@/components/finance/WhereMoneyWent';
import { hasBreakdown, type SpendSplit } from '@/lib/finance/where-money-went';

type Surface = 'code' | 'cowork';

interface Session {
  surface: Surface;
  sessionId: string;
  startedAt: number | null;
  endedAt: number | null;
  scheduledTask: string | null;
  workKey: string | null;
  workLabel: string | null;
  tier: number | null;
  activeSecs: number | null;
  prompts: number | null;
  actions: number | null;
  spendUsd: number | null;
  hasUnpriced: boolean;
  models: string[];
  skills: string[];
  connectors: string[];
  subagents: string[];
  outputs: string[];
  commits: number | null;
  producedOutput: boolean | null;
}

type Route =
  | { kind: 'tool'; toolType: 'skill' | 'connector'; name: string; peerUsers: number; peerSessionShare: number; libraryEntryId: number | null }
  | ModelAdvice
  | { kind: 'context'; rereadShare: number; peerRereadShare: number };

interface ModelFigures { sessions: number; people: number; typicalSessionUsd: number | null; producedRate: number | null; deepRate: number | null }
interface ModelFitRow { model: string; spendUsd: number | null; spendShare: number; you: ModelFigures | null; colleagues: ModelFigures | null }
interface ModelAdvice {
  kind: 'model';
  direction: 'save' | 'step_up' | 'trial';
  fromModel: string;
  toModel: string;
  metric: 'produced' | 'deep' | null;
  from: { typicalSessionUsd: number | null; rate: number | null; basis: 'colleagues' | 'you' };
  to: { typicalSessionUsd: number | null; rate: number | null; people: number; sessions: number };
  estSavingUsd: number | null;
  priceRatio: number;
  savingShare: number | null;
}

/** "half", "a quarter", "a third", else "40%". */
function priceShare(ratio: number): string {
  if (Math.abs(ratio - 0.5) < 0.03) return 'half';
  if (Math.abs(ratio - 0.25) < 0.02) return 'a quarter';
  if (Math.abs(ratio - 1 / 3) < 0.02) return 'a third';
  if (Math.abs(ratio - 0.2) < 0.02) return 'a fifth';
  return pct(ratio);
}

interface WorkRow {
  key: string;
  surface: Surface;
  workKey: string | null;
  label: string;
  definition: string | null;
  spendUsd: number;
  share: number;
  sessions: number;
  activeSecs: number | null;
  firstAt: number | null;
  lastAt: number | null;
  typicalSessionUsd: number | null;
  peer: { users: number; sessions: number; typicalSessionUsd: number | null } | null;
  produced: { measured: number; produced: number } | null;
  commits: number | null;
  deepSessions: number;
  topModel: { model: string; share: number } | null;
  routes: Route[];
  models: ModelFitRow[];
  split: SpendSplit;
}

interface ScheduledTask {
  name: string;
  surface: Surface;
  runs: number;
  days: number;
  spendUsd: number;
  mainModel: string | null;
  costlyShare: number;
  costlyModel: string | null;
  cheaperFamilies: string[];
}

interface LimitRow { period: string; limit: number | null; spend: number; currency: string; source: string; shareUsed: number | null }

interface Review {
  userId: string;
  displayName: string;
  email: string | null;
  department: string | null;
  period: string;
  isCurrentMonth: boolean;
  updatedAt?: number;
  totals: { totalUsd: number; codeUsd: number; coworkUsd: number; sessions: number };
  unpricedModels: string[];
  work: WorkRow[];
  sessions: Session[];
  sessionsTotal: number;
  scheduledTasks: ScheduledTask[];
  peerWindowDays: number;
  modelEfficiency: CostDriverFigures;
  anthropic: { status: LimitsStatus; fetchedAt: number | null; matched: boolean; limit: LimitRow | null; pendingRequestAt: string | null };
  nearLimitShare: number;
  canSeePrompts: boolean;
}

const SURFACE_LABEL: Record<Surface, string> = { code: 'Code', cowork: 'Cowork' };
/** Below this many sessions in the current month, offer last month instead. */
const EARLY_MONTH_SESSIONS = 5;
/** Through the first week, a month's shares rest on few sessions and the page says so. */
const EARLY_MONTH_DAYS = 7;

/** "Build, deploy and tooling" → "build, deploy and tooling" for use inside a sentence. */
/** A kind-of-work label inside a sentence: lower case, keeping acronyms such as API. */
function lowerFirst(label: string): string {
  return label.split(' ').map((w) => (/^[A-Z0-9]{2,}$/.test(w) ? w : w.toLowerCase())).join(' ');
}

/** "Where the money goes" opens on the top kinds of work by spend. */
const TOP_WORK_SHOWN = 5;
/** Mirrors MIN_WORK_SHARE_FOR_ROUTES in lib/finance/spend-review.ts. */
const MIN_WORK_SHARE_FOR_ROUTES = 0.1;

/** Surface as a neutral mono tag: on these pages violet means AI-judged and blue means measured. */
function SurfacePill({ surface }: { surface: Surface }) {
  return <Tag>{SURFACE_LABEL[surface]}</Tag>;
}

function AnthropicCard({ a, nearShare, email }: { a: Review['anthropic']; nearShare: number; email: string | null }) {
  if (a.status !== 'ok') return <LimitsNotice status={a.status} />;
  if (!a.matched || !a.limit) {
    return (
      <Notice tone="info">
        {email ? `No one with ${email} is in your Anthropic organisation, so there's no limit to show.` : "This person has no email on record, so their Anthropic limit can't be matched."}
      </Notice>
    );
  }
  const l = a.limit;
  return (
    <Panel
      title="Anthropic spend limit, this month"
      badge={<Tag tone="measured">Reported by Anthropic</Tag>}
      right={a.pendingRequestAt && <Tag tone="warn">Asked for more usage on {ukDate(a.pendingRequestAt)}</Tag>}
      flush
    >
      <div className="px-4 py-3 flex items-end gap-6 flex-wrap">
        <div>
          <p className="m-0 text-[24px] leading-7 font-semibold tracking-[-0.02em] tabular-nums text-[#0A0A0A]">{money(l.spend, l.currency)}</p>
          <p className="m-0 mt-1 text-[13px] text-[#8F8F8F] tabular-nums">spent of {l.limit === null ? 'no limit' : money(l.limit, l.currency)}</p>
        </div>
        <div className="flex-1 min-w-[200px] pb-1"><LimitBar share={l.shareUsed} nearShare={nearShare} /></div>
        <p className="m-0 text-[13px] text-[#666666] pb-1">{l.source}</p>
      </div>
      <PanelFoot>
        Covers every surface, including Chat, so it can differ from Command Centre&apos;s measured figure below.
        {a.pendingRequestAt && ' Approve or deny the request in claude.ai Organisation settings.'}
      </PanelFoot>
    </Panel>
  );
}

/** The kind of route, as the mono tag at the start of each route row. */
function routeKind(r: Route): string {
  if (r.kind === 'context') return 'Context';
  if (r.kind === 'tool') return r.toolType === 'skill' ? 'Skill' : 'Connector';
  return r.direction === 'trial' ? 'Trial' : 'Model';
}

function RouteText({ r, name }: { r: Route; name: string }) {
  if (r.kind === 'context') {
    return (
      <span>
        <span className="font-semibold">Long conversations.</span> {pct(r.rereadShare)} of this cost is Claude re-reading earlier conversation on every message, against {pct(r.peerRereadShare)} for colleagues doing the same work.
        {' '}Starting a fresh session for each new piece of work cuts that whatever the model, though a fresh session loses the earlier context.
      </span>
    );
  }
  if (r.kind === 'tool') {
    const thing = r.toolType === 'skill' ? 'skill' : 'connector';
    return (
      <span>
        <span className="font-semibold">{r.peerUsers} colleagues</span> use the{' '}
        {r.libraryEntryId
          ? <Link href={`/library/${r.libraryEntryId}`} className="font-medium text-[#245BF3] hover:underline">{r.name}</Link>
          : <span className="font-medium">{r.name}</span>}{' '}
        {thing} for this work, in {pct(r.peerSessionShare)} of their sessions. {name} hasn&apos;t used it in the last 90 days.
      </span>
    );
  }
  const outcome = r.metric === 'produced' ? 'produce a file' : 'reach deep (Tier 3) work';
  const fromWho = r.from.basis === 'colleagues' ? `on ${prettyModel(r.fromModel)}` : `on ${prettyModel(r.fromModel)} (${name}'s own sessions)`;
  const saving = r.estSavingUsd !== null && (
    <span className="text-[#2451F3]"> About {money(r.estSavingUsd)} less this month at list price{r.savingShare !== null ? `, roughly ${pct(r.savingShare)} of this work's cost` : ''} (estimate).</span>
  );
  if (r.direction === 'save') {
    return (
      <span>
        <span className="font-semibold">Save with {prettyModel(r.toModel)}.</span> It costs {priceShare(r.priceRatio)} as much per token as {prettyModel(r.fromModel)}
        {r.metric && r.from.rate !== null && r.to.rate !== null
          ? <>, and colleagues&apos; sessions of this work on it {outcome} {r.to.rate >= r.from.rate ? 'more often' : 'nearly as often'} ({pct(r.to.rate)} against {pct(r.from.rate)} {fromWho}, over {r.to.sessions} sessions).</>
          : <>. {r.to.people} colleagues use it for this work ({r.to.sessions} sessions); Command Centre can&apos;t compare their results yet.</>}
        {saving}
      </span>
    );
  }
  if (r.direction === 'trial') {
    return (
      <span>
        <span className="font-semibold">Worth a trial: {prettyModel(r.toModel)}.</span> A bigger saving: it costs {priceShare(r.priceRatio)} as much per token as {prettyModel(r.fromModel)}.
        {' '}Too few colleagues use it for this work to show how it does (untested here), so try it on a few sessions first.
        {saving}
      </span>
    );
  }
  return (
    <span>
      <span className="font-semibold">Worth trying {prettyModel(r.toModel)}.</span> Colleagues&apos; sessions of this work on it {outcome} {pct(r.to.rate)} of the time,
      against {pct(r.from.rate)} {fromWho}, over {r.to.sessions} sessions. It costs {r.priceRatio.toFixed(1)} times as much per token.
    </span>
  );
}

function ModelTable({ rows, name }: { rows: ModelFitRow[]; name: string }) {
  if (rows.length === 0) return null;
  const withColleagues = rows.some(r => r.colleagues);
  const showProduced = withColleagues && rows.some(r => r.colleagues?.producedRate != null);
  const rate = (v: number | null | undefined) => (v === null || v === undefined ? '—' : pct(v));
  const th = 'font-medium px-3 py-1.5 whitespace-nowrap';
  const td = 'px-3 py-1.5 tabular-nums';
  return (
    <div className="flex flex-col gap-1.5">
      <SubHead>Models for this work</SubHead>
      <div className="border border-[#F2F2F2] rounded-[6px] overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="text-left text-[#8F8F8F] bg-[#FAFAFA]">
              <th scope="col" className={th}>Model</th>
              <th scope="col" className={cx(th, 'text-right')}>Spend</th>
              <th scope="col" className={cx(th, 'text-right')}>Sessions</th>
              <th scope="col" className={cx(th, 'text-right')}>Typical session</th>
              {withColleagues && <th scope="col" className={cx(th, 'text-right border-l border-[#EAEAEA]')}>Colleagues&apos; typical</th>}
              {showProduced && <th scope="col" className={cx(th, 'text-right')}>Produced a file</th>}
              {withColleagues && <th scope="col" className={cx(th, 'text-right')}>Deep work</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.model} className="border-t border-[#F2F2F2]">
                <td className="px-3 py-1.5 text-[#0A0A0A]">{prettyModel(r.model)}</td>
                <td className={cx(td, 'text-right')}>{r.spendUsd === null ? <span className="text-[#B54708]">Not priced</span> : r.spendUsd > 0 ? <>{money(r.spendUsd)} <span className="text-[#8F8F8F]">{pct(r.spendShare)}</span></> : '—'}</td>
                <td className={cx(td, 'text-right')}>{r.you?.sessions ?? 0}</td>
                <td className={cx(td, 'text-right')}>{r.you ? money(r.you.typicalSessionUsd) : '—'}</td>
                {withColleagues && (
                  <td className={cx(td, 'text-right border-l border-[#EAEAEA]')}>
                    {r.colleagues ? <>{money(r.colleagues.typicalSessionUsd)} <span className="text-[#8F8F8F]">({r.colleagues.people} people, {r.colleagues.sessions} sessions)</span></> : <span className="text-[#B3B3B3]">too few</span>}
                  </td>
                )}
                {showProduced && <td className={cx(td, 'text-right')}>{rate(r.colleagues?.producedRate)}</td>}
                {withColleagues && <td className={cx(td, 'text-right')}>{rate(r.colleagues?.deepRate)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="m-0 text-[12px] text-[#8F8F8F] leading-4">
        Spend is {name}&apos;s for the month. A session counts under the model that carried most of its cost.
        {withColleagues
          ? ' Colleague columns cover models three or more colleagues used for this work; rates need five sessions to show, and a model is only suggested with 20 or more. Command Centre doesn’t judge answer quality.'
          : ''}
      </p>
    </div>
  );
}

/** Model split for one kind of work, coloured like FinOps (one colour per model). */
function SplitBar({ w, modelOrder }: { w: WorkRow; modelOrder: string[] }) {
  const priced = w.models.filter(m => (m.spendUsd ?? 0) > 0);
  const total = priced.reduce((a, m) => a + (m.spendUsd ?? 0), 0);
  if (total <= 0) return <div className="h-2 rounded-full bg-[#F2F2F2]" />;
  return (
    <div className="flex h-2 rounded-full overflow-hidden gap-px bg-[#F2F2F2]" title={priced.map(m => `${prettyModel(m.model)} ${pct((m.spendUsd ?? 0) / total)}`).join(' · ')}>
      {priced.map(m => (
        <div key={m.model} style={{ width: `${((m.spendUsd ?? 0) / total) * 100}%`, backgroundColor: shadeForModel(m.model, modelOrder) }} />
      ))}
    </div>
  );
}

function ReviewChip({ w }: { w: WorkRow }) {
  const models = w.routes.filter((r): r is ModelAdvice => r.kind === 'model');
  const tools = w.routes.filter(r => r.kind === 'tool').length;
  const chips: { label: string; tone: 'info' | 'good' | 'warn' | 'neutral' }[] = [];
  if (w.routes.some(r => r.kind === 'context')) chips.push({ label: 'Long conversations', tone: 'info' });
  for (const model of models) {
    chips.push(model.direction === 'save'
      ? { label: `Save with ${prettyModel(model.toModel)}`, tone: 'good' }
      : model.direction === 'trial'
        ? { label: `Trial ${prettyModel(model.toModel)}`, tone: 'warn' }
        : { label: `Try ${prettyModel(model.toModel)}`, tone: 'neutral' });
  }
  if (tools > 0) chips.push({ label: `${tools} tool${tools === 1 ? '' : 's'}`, tone: 'info' });
  if (chips.length === 0) {
    const why = !w.workKey ? 'Not classified' : !w.peer || w.peer.typicalSessionUsd === null ? 'Too few colleagues' : w.share < MIN_WORK_SHARE_FOR_ROUTES ? 'Small share of spend' : 'No better route';
    return <span className="text-[13px] text-[#B3B3B3]">{why}</span>;
  }
  return (
    <span className="inline-flex flex-wrap gap-1 justify-end">
      {chips.map(c => <Pill key={c.label} tone={c.tone}>{c.label}</Pill>)}
    </span>
  );
}

/** One table across Code and Cowork: each kind of work, its model split, spend and what to review. */
function ModelEfficiency({ data, onShowAll }: { data: Review; onShowAll: () => void }) {
  const me = data.modelEfficiency;
  const rows = data.work.filter(w => w.spendUsd > 0 || w.models.length > 0);
  const open = (key: string) => {
    onShowAll();
    setTimeout(() => document.getElementById(`work-${key}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  };
  return (
    <Panel
      title="Model efficiency"
      subtitle={<>Kind of work is <span className="text-[#2451F3]">AI-judged</span>; spend and model split are <span className="text-[#05073F] font-medium">measured</span>. Click a row for the detail.</>}
      flush
    >
      <div className="overflow-x-auto">
        <table className={T.table}>
          <thead>
            <tr className={T.headRow}>
              <th scope="col" className={T.th}>Kind of work</th>
              <th scope="col" className={cx(T.th, 'w-[30%]')}>Model split</th>
              <th scope="col" className={T.thRight}>Spend</th>
              <th scope="col" className={T.thRight}>Typical session</th>
              <th scope="col" className={T.thRight}>Review</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(w => (
              <tr key={w.key} className={cx(T.row, 'cursor-pointer')} onClick={() => open(w.key)}>
                <td className={cx(T.td, 'min-w-[11rem]')}>
                  <button
                    type="button"
                    onClick={e => { e.stopPropagation(); open(w.key); }}
                    className="block text-left font-medium text-[#0A0A0A] hover:text-[#245BF3] leading-snug"
                    title={w.definition && w.definition.toLowerCase() !== w.label.toLowerCase() ? `Covers: ${displayDefinition(w.definition)}` : undefined}
                  >
                    {w.label}
                  </button>
                  <span className="mt-0.5 flex items-center gap-1.5 text-[13px] text-[#8F8F8F]">
                    <span>{SURFACE_LABEL[w.surface]}</span>
                    {w.workKey && (
                      <span className="inline-flex items-center gap-1 text-[#2451F3]"><span className="w-1.5 h-1.5 rounded-full bg-[#699BFB]" />AI-judged</span>
                    )}
                  </span>
                </td>
                <td className={T.td}><SplitBar w={w} modelOrder={me.modelOrder} /></td>
                <td className={cx(T.tdRight, 'whitespace-nowrap')}>
                  <span className="block font-medium text-[#0A0A0A]">{money(w.spendUsd)}</span>
                  <span className="block text-[13px] text-[#8F8F8F]">{pct(w.share)} of spend</span>
                </td>
                <td className={cx(T.tdRight, 'whitespace-nowrap')}>
                  <span className="block text-[#0A0A0A]">{money(w.typicalSessionUsd)}</span>
                  <span className="block text-[13px] text-[#8F8F8F] min-h-[1rem]">{w.peer?.typicalSessionUsd != null && `colleagues ${money(w.peer.typicalSessionUsd)}`}</span>
                </td>
                <td className={T.tdRight}><ReviewChip w={w} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {me.modelOrder.length > 0 && (
        <div className="px-4 py-2.5 border-t border-[#F2F2F2] flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-[#8F8F8F]">
          {me.modelOrder.map(m => (
            <span key={m} className="inline-flex items-center gap-1.5">
              <span className="inline-block w-2.5 h-2 rounded-full" style={{ backgroundColor: shadeForModel(m, me.modelOrder) }} />
              {prettyModel(m)}
            </span>
          ))}
          <span>most expensive first</span>
        </div>
      )}
      <CostDrivers report={me} />
    </Panel>
  );
}

/** Scheduled tasks run unattended, so a costly model on routine work is easy to miss. */
function ScheduledTasks({ tasks, isCurrentMonth }: { tasks: ScheduledTask[]; isCurrentMonth: boolean }) {
  const when = isCurrentMonth ? 'this month' : 'in the month';
  return (
    <Panel title="Scheduled tasks" subtitle="Sessions started by a scheduled task, which run unattended" flush>
      {tasks.map(t => (
        <div key={t.surface + t.name} className="px-4 py-3 border-t border-[#F2F2F2] first:border-t-0 flex flex-col gap-1.5">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[14px] font-semibold text-[#0A0A0A] truncate">{t.name}</span>
            <SurfacePill surface={t.surface} />
            <span className="ml-auto text-[14px] font-semibold text-[#0A0A0A] tabular-nums shrink-0">{money(t.spendUsd)}</span>
          </div>
          <p className="m-0 text-[13px] text-[#666666] tabular-nums">
            {t.runs} run{t.runs === 1 ? '' : 's'} on {t.days} day{t.days === 1 ? '' : 's'} {when}{t.mainModel ? ` · largest share on ${prettyModel(t.mainModel)}` : ''}
          </p>
          {t.cheaperFamilies.length > 0 && t.costlyModel && (
            <div className="rounded-[6px] bg-[#FAFAFA] border border-[#EAEAEA] px-3.5 py-2.5 text-[14px] leading-5 text-[#0A0A0A]">
              <span className="font-semibold">Try a cheaper model.</span> This task runs unattended, and {t.costlyShare >= 0.995 && t.mainModel === t.costlyModel ? `all of its cost ${when} ran on ${prettyModel(t.costlyModel)}` : `${pct(t.costlyShare)} of its cost ${when} ran on pricier models, mainly ${prettyModel(t.costlyModel)}`}. Routine work like this usually runs fine on {t.cheaperFamilies.join(' or ')}.
            </div>
          )}
        </div>
      ))}
    </Panel>
  );
}

function WorkCard({ w, name, peerDays }: { w: WorkRow; name: string; peerDays: number }) {
  const facts: string[] = [sessionsFact(w)];
  if (w.typicalSessionUsd !== null) facts.push(`typical session ${money(w.typicalSessionUsd)}`);
  if (w.peer?.typicalSessionUsd != null) facts.push(`colleagues' typical ${money(w.peer.typicalSessionUsd)} (${w.peer.users} people)`);
  const outcome: string[] = [];
  if (w.produced) outcome.push(`${w.produced.produced} of ${w.produced.measured} sessions produced a file or artifact`);
  if (w.commits !== null) outcome.push(`${w.commits} commit${w.commits === 1 ? '' : 's'}`);
  if (w.workKey) outcome.push(`${w.deepSessions} deep (Tier 3) session${w.deepSessions === 1 ? '' : 's'}`);
  const tooFew = w.workKey && (!w.peer || w.peer.typicalSessionUsd === null);

  return (
    <div id={`work-${w.key}`} className="px-4 py-4 border-t border-[#F2F2F2] first:border-t-0 scroll-mt-4 flex flex-col gap-2">
      <div className="flex items-baseline gap-2 min-w-0">
        <h3 className="m-0 text-[15px] font-semibold text-[#0A0A0A] truncate">{w.label}</h3>
        <SurfacePill surface={w.surface} />
        <span className="ml-auto text-[14px] font-semibold text-[#0A0A0A] tabular-nums shrink-0">{money(w.spendUsd)} <span className="font-normal text-[#8F8F8F]">· {pct(w.share)}</span></span>
      </div>
      <Bar pct={Math.max(1, Math.round(w.share * 100))} tone="measured" height={4} />
      {w.definition && w.definition.toLowerCase() !== w.label.toLowerCase() && <p className="m-0 text-[13px] text-[#8F8F8F]">Covers: {displayDefinition(w.definition)}</p>}
      <p className="m-0 text-[13px] text-[#666666] tabular-nums">{facts.join(' · ')}</p>
      {outcome.length > 0 && <p className="m-0 text-[13px] text-[#666666] tabular-nums">{outcome.join(' · ')}</p>}
      {hasBreakdown(w.split) && (
        <div className="flex flex-col gap-0.5">
          <span className="text-[13px] font-medium text-[#0A0A0A]">Where it went</span>
          <WhereMoneyWent s={w.split} />
        </div>
      )}
      {w.models.length > 0
        ? <div className="mt-1"><ModelTable rows={w.models} name={name} /></div>
        : w.topModel && <p className="m-0 text-[13px] text-[#666666]">{pct(w.topModel.share)} on {w.topModel.model}</p>}

      {w.routes.length > 0 ? (
        <div className="mt-1 rounded-[6px] border border-[#C9D6FD] bg-[#F5F8FF] px-3.5 py-3 flex flex-col gap-2">
          <span className="text-[13px] font-semibold text-[#245BF3]">
            {w.routes.length} better route{w.routes.length === 1 ? '' : 's'}
          </span>
          {w.routes.map((r, i) => (
            <div key={i} className="flex items-start gap-2.5 text-[14px] leading-5 text-[#0A0A0A]">
              <span className="mt-0.5 shrink-0"><Tag tone="measured">{routeKind(r)}</Tag></span>
              <RouteText r={r} name={name} />
            </div>
          ))}
        </div>
      ) : w.workKey ? (
        <p className="m-0 text-[13px] text-[#8F8F8F]">
          {tooFew
            ? `Too few colleagues did this kind of work in the last ${peerDays} days to compare.`
            : w.share < MIN_WORK_SHARE_FOR_ROUTES
              ? `Routes are suggested on work that's at least ${pct(MIN_WORK_SHARE_FOR_ROUTES)} of ${name}'s spend.`
              : "Colleagues doing this work don't show a different route."}
        </p>
      ) : null}
    </div>
  );
}

function SessionRow({ s, userId, canSeePrompts }: { s: Session; userId: string; canSeePrompts: boolean }) {
  const [open, setOpen] = useState(false);
  const [prompts, setPrompts] = useState<{ id: string; occurredAt: number; text: string }[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function loadPrompts() {
    setLoading(true);
    setErr(null);
    fetch(`/api/finance/spend-review/${encodeURIComponent(userId)}/sessions/${encodeURIComponent(s.sessionId)}`)
      .then(async r => {
        if (!r.ok) {
          const body = r.status === 403 ? await r.json().catch(() => null) : null;
          throw new Error(body?.error === 'no_department'
            ? 'Your account has no department yet, so prompts are hidden. Ask an admin to set your department.'
            : r.status === 403 ? 'Prompts are visible to admins and managers.' : 'Could not load prompts.');
        }
        return r.json();
      })
      .then(d => setPrompts(d.prompts))
      .catch(e => setErr(e.message))
      .finally(() => setLoading(false));
  }

  const detail: [string, string][] = [];
  if (s.models.length) detail.push(['Models', s.models.join(', ')]);
  if (s.skills.length) detail.push(['Skills', s.skills.join(', ')]);
  if (s.subagents?.length) detail.push(['Subagents', s.subagents.join(', ')]);
  if (s.connectors.length) detail.push(['Connectors', s.connectors.join(', ')]);
  if (s.outputs.length) detail.push(['Files produced', s.outputs.join(', ')]);
  if (s.producedOutput === false && !s.outputs.length) detail.push(['Files produced', 'None']);
  if (s.commits !== null) detail.push(['Commits', String(s.commits)]);

  return (
    <div className="border-t border-[#F2F2F2] first:border-t-0">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="w-full flex items-center gap-4 px-4 py-2.5 text-left hover:bg-[#FAFAFA]"
      >
        <span className="flex-1 min-w-0 flex flex-col gap-0.5">
          <span className="flex items-center gap-2 flex-wrap min-w-0">
            <span className="text-[14px] font-medium text-[#0A0A0A] tabular-nums">{spansDays(s.startedAt, s.endedAt) ? `${ukDate(s.startedAt)} to ${ukDate(s.endedAt)}` : ukDate(s.startedAt)}</span>
            <SurfacePill surface={s.surface} />
            <span className="text-[14px] text-[#4D4D4D] truncate">{s.scheduledTask ? `Scheduled task: ${s.scheduledTask} · ` : ''}{s.workLabel}{s.tier ? ` · Tier ${s.tier}` : ''}</span>
          </span>
          <span className="text-[13px] text-[#8F8F8F] tabular-nums">
            {duration(s.activeSecs)} active · {s.prompts ?? '—'} prompt{s.prompts === 1 ? '' : 's'} · {s.actions ?? '—'} action{s.actions === 1 ? '' : 's'}
          </span>
        </span>
        <span className="text-right shrink-0">
          <span className="block text-[14px] font-medium text-[#0A0A0A] tabular-nums">{s.spendUsd === null ? 'Not priced' : money(s.spendUsd)}</span>
          {s.hasUnpriced && s.spendUsd !== null && <span className="block text-[12px] text-[#B54708]">Part not priced</span>}
        </span>
        <span className="w-12 text-right text-[13px] text-[#245BF3] shrink-0">{open ? 'Hide' : 'Details'}</span>
      </button>
      {open && (
        <div className="px-4 pb-3.5 flex flex-col gap-2.5">
          {detail.length > 0 && (
            <dl className="m-0 grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13px]">
              {detail.map(([k, v]) => (<Fragment key={k}><dt className="text-[#8F8F8F]">{k}</dt><dd className="m-0 text-[#0A0A0A] break-words">{v}</dd></Fragment>))}
            </dl>
          )}
          {canSeePrompts && prompts === null && (
            <button type="button" onClick={loadPrompts} disabled={loading} className={cx(B.secondary, 'self-start')}>
              {loading ? 'Loading prompts…' : 'Show prompts'}
            </button>
          )}
          {err && <Notice tone="error">{err}</Notice>}
          {prompts && (
            prompts.length === 0
              ? <Muted>No prompts stored for this session.</Muted>
              : <ol className="m-0 p-0 list-none flex flex-col gap-2">
                  {prompts.map(p => (
                    <li key={p.id} className="text-[13px] bg-[#FAFAFA] border border-[#F2F2F2] rounded-[6px] px-3 py-2">
                      <p className="m-0 text-[12px] text-[#8F8F8F] mb-1">{new Date(p.occurredAt * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</p>
                      <p className="m-0 whitespace-pre-wrap text-[#0A0A0A]">{p.text}</p>
                    </li>
                  ))}
                </ol>
          )}
        </div>
      )}
    </div>
  );
}

function SpendReviewContent() {
  const params = useParams<{ userId: string }>();
  const search = useSearchParams();
  const userId = decodeURIComponent(params.userId);
  const [period, setPeriod] = useState(() => search.get('period') || monthOptions()[0].value);
  const [data, setData] = useState<Review | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAllWork, setShowAllWork] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!refreshKey) { setLoading(true); setShowAllWork(false); }
    setError(null);
    fetch(`/api/finance/spend-review/${encodeURIComponent(userId)}?period=${period}${refreshKey ? '&refresh=1' : ''}`)
      .then(async r => {
        if (r.status === 403) throw new Error("You can see your own spend review. Other people's are for admins and managers.");
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Couldn't load this page. Try again.");
        return r.json();
      })
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => { setLoading(false); setRefreshing(false); });
  }, [userId, period, refreshKey]);

  const name = data?.displayName ?? 'Spend Review';
  const firstName = data ? (data.displayName.includes('@') ? 'This person' : data.displayName.split(' ')[0]) : '';
  const classified = data ? data.work.filter(w => w.workKey).reduce((a, w) => a + w.spendUsd, 0) : 0;
  const top = data?.work.find(w => w.workKey && w.spendUsd > 0);
  const share = (part: number) => (data && data.totals.totalUsd > 0 ? `${pct(part / data.totals.totalUsd)} of spend` : undefined);

  return (
    <>
      <TopBar title={`Spend Review: ${name}`} subtitle={data?.department ?? undefined} />
      <PageBody>
        <Toolbar
          left={
            <span className="flex gap-4">
              {data?.canSeePrompts && <Link href="/finops/spend-review" className={B.link}>← Spend Review</Link>}
              <Link href={`/pulse/person/${encodeURIComponent(userId)}`} className={B.link}>Person 360 →</Link>
            </span>
          }
        >
          <UpdatedLine at={data?.updatedAt} refreshing={refreshing} onRefresh={() => { setRefreshing(true); setRefreshKey(k => k + 1); }} />
          <MonthPicker value={period} onChange={p => { setRefreshKey(0); setPeriod(p); }} />
        </Toolbar>

        {loading && <LoadingSpinner />}
        {error && <Notice tone="error">{error}</Notice>}

        {!loading && data && (
          <>
            {data.isCurrentMonth && <AnthropicCard a={data.anthropic} nearShare={data.nearLimitShare} email={data.email} />}

            <div className="flex flex-col gap-2">
              <Strip cols={4}>
                <Figure label="Measured spend" value={money(data.totals.totalUsd)} sub={data.isCurrentMonth ? 'Month to date' : 'Whole month'} />
                <Figure label="Cowork" value={money(data.totals.coworkUsd)} sub={share(data.totals.coworkUsd)} />
                <Figure label="Code" value={money(data.totals.codeUsd)} sub={share(data.totals.codeUsd)} />
                <Figure label="Sessions" value={String(data.totals.sessions)} />
              </Strip>
              <Muted>
                Measured by Command Centre from telemetry, the same figures as FinOps. Chat isn&apos;t included.
                {data.unpricedModels.length > 0 && ` Not priced, so left out: ${data.unpricedModels.map(m => formatModelLabel(m).label).join(', ')}.`}
              </Muted>
            </div>

            {data.isCurrentMonth && data.totals.sessions < EARLY_MONTH_SESSIONS && (
              <Notice
                tone="info"
                action={
                  <button type="button" onClick={() => setPeriod(monthOptions()[1].value)} className={B.link}>
                    See {monthOptions()[1].label}
                  </button>
                }
              >
                {data.totals.sessions === 0 ? 'Nothing yet this month.' : `Only ${data.totals.sessions} session${data.totals.sessions === 1 ? '' : 's'} so far this month.`}
              </Notice>
            )}

            {data.totals.sessions === 0 ? (
              <div className="border border-dashed border-[#DADADA] bg-white rounded-[14px] px-6 py-8 text-center">
                <span className="text-[14px] font-medium text-[#0A0A0A]">No Code or Cowork spend for this month.</span>
              </div>
            ) : (
              <>
                <ModelEfficiency data={data} onShowAll={() => setShowAllWork(true)} />

                <Panel
                  title="Where the money goes"
                  badge={<Tag tone="judged">Kind of work is AI-judged</Tag>}
                  flush
                >
                  {top && classified > 0 && (
                    <p className="m-0 px-4 pt-3.5 pb-1 text-[15px] leading-6 text-[#0A0A0A]">
                      {pct(top.share)} of {firstName}&apos;s spend {data.isCurrentMonth ? 'this month' : `in ${monthName(data.period)}`} went on {SURFACE_LABEL[top.surface]} sessions judged as {lowerFirst(top.label)}.
                      {data.isCurrentMonth && new Date().getUTCDate() <= EARLY_MONTH_DAYS && (
                        <span className="text-[#666666]"> Early in the month: so far {sessionsFact(top)}.</span>
                      )}
                    </p>
                  )}
                  <div>
                    {(showAllWork ? data.work : data.work.slice(0, TOP_WORK_SHOWN)).map(w => <WorkCard key={w.key} w={w} name={firstName} peerDays={data.peerWindowDays} />)}
                  </div>
                  <div className="px-4 py-2.5 border-t border-[#F2F2F2] flex items-center gap-x-4 gap-y-1 flex-wrap">
                    {data.work.length > TOP_WORK_SHOWN && (
                      <button type="button" onClick={() => setShowAllWork(v => !v)} className={B.link}>
                        {showAllWork ? `Show the top ${TOP_WORK_SHOWN} only` : `Show all ${data.work.length} kinds of work`}
                      </button>
                    )}
                    <span className="sm:ml-auto text-[13px] text-[#8F8F8F]">
                      Colleague figures cover other people&apos;s sessions of the same kind of work in the last {data.peerWindowDays} days, and only show when at least three people did it. Colleagues are never named.
                    </span>
                  </div>
                </Panel>

                {data.scheduledTasks.length > 0 && <ScheduledTasks tasks={data.scheduledTasks} isCurrentMonth={data.isCurrentMonth} />}

                <Panel
                  title="Sessions"
                  subtitle={`Most expensive first${data.sessionsTotal > data.sessions.length ? ` · top ${data.sessions.length} of ${data.sessionsTotal}` : ''}`}
                  flush
                >
                  {data.sessions.map(s => <SessionRow key={s.surface + s.sessionId} s={s} userId={data.userId} canSeePrompts={data.canSeePrompts} />)}
                  <PanelFoot>Active time counts the gaps of 30 minutes or less between events, so a session left open overnight isn&apos;t counted as worked time.</PanelFoot>
                </Panel>
              </>
            )}
          </>
        )}
      </PageBody>
    </>
  );
}

export default function SpendReviewPage() {
  return (
    <Suspense fallback={<LoadingSpinner />}>
      <SpendReviewContent />
    </Suspense>
  );
}
