// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

/**
 * Work Pulse overview panels in the answer layout (components/precision/answer.tsx). Each answer
 * sentence is written here from the figures the page already loads; nothing is AI-written.
 */
import { AnswerPanel, AC, Columns, DotCompare, Legend, SplitBar, TargetBars, type AttentionItem } from '@/components/precision/answer';
import { WORK_PRODUCT_COLOR, BY_PRODUCT_ROW_COLOR } from '@/lib/ui/chart-colours';
import { dayMonth, fmtInt, fmtPct, listWords, plural, shareChangeWords } from '@/lib/ui/answer-text';
import { buildDeptBenchmark } from '@/lib/pulse/dept-benchmark';
import type { DeptRow } from '@/components/pulse/DeptTable';
import type { SessionOutputReport } from '@/components/pulse/SessionOutputCard';
import type { HumanTimeSummary } from '@/components/pulse/HumanTimeCard';
import type { ByProductData } from '@/components/pulse/ByProductPanel';

export interface TierWeek { weekStart: number; t1: number; t2: number; t3: number }
export interface DeptTrend { dept: string; sparkline: Array<number | null>; thenVsNow: { then: number; now: number; deltaPp: number; arrow: 'up' | 'flat' | 'down' } | null }

export function taskTypeWords(t: string): string {
  const s = t.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function deepShare(weeks: TierWeek[]): number | null {
  const t = weeks.reduce((a, w) => ({ all: a.all + w.t1 + w.t2 + w.t3, deep: a.deep + w.t2 + w.t3 }), { all: 0, deep: 0 });
  return t.all > 0 ? t.deep / t.all : null;
}

/* ── Are people handing Claude bigger jobs? ─────────────────────── */

export function BiggerJobs({ weeks, departments, product, onWindow, window }: {
  weeks: TierWeek[];
  departments: DeptTrend[];
  product: string;
  window: 13 | 26 | 52;
  onWindow: (w: 13 | 26 | 52) => void;
}) {
  if (weeks.length === 0) return null;
  const now = deepShare(weeks.slice(-4));
  const before = weeks.length >= 8 ? deepShare(weeks.slice(-8, -4)) : null;
  const pct = (w: TierWeek, k: 't1' | 't2' | 't3') => { const t = w.t1 + w.t2 + w.t3; return t > 0 ? (w[k] / t) * 100 : null; };
  const falling = departments
    .filter(d => d.thenVsNow && d.thenVsNow.arrow === 'down')
    .sort((a, b) => a.thenVsNow!.deltaPp - b.thenVsNow!.deltaPp);
  const lastShare = deepShare(weeks.slice(-1));
  const windowPicker = (
    <span className="inline-flex border border-[#EAEAEA] rounded-[8px] overflow-hidden">
      {([13, 26, 52] as const).map(w => (
        <button key={w} type="button" onClick={() => onWindow(w)} className={`text-[12px] px-2 py-0.5 ${w === window ? 'bg-[#F2F2F2] text-[#0A0A0A] font-medium' : 'bg-white text-[#666666]'}`}>{w}w</button>
      ))}
    </span>
  );
  return (
    <AnswerPanel
      question={`Are people handing ${product} bigger jobs?`}
      right={windowPicker}
      tag="judged"
      answer={now === null ? <>Not enough classified work yet to say.</> : <><Fig>{fmtPct(now)}</Fig> of {product} work in the last 4 weeks was meaningful or frontier{before !== null ? `, ${shareChangeWords(now, before)} in the 4 weeks before` : ''}.</>}
      quiet={undefined}
      legend={[{ label: 'Routine', colour: AC.tier1 }, { label: 'Meaningful', colour: AC.tier2 }, { label: 'Frontier', colour: AC.tier3 }]}
      attention={{
        title: 'Departments where it is falling',
        items: falling.slice(0, 3).map(d => ({
          key: d.dept, label: d.dept,
          why: `meaningful or frontier, ${fmtPct(d.thenVsNow!.then)} to ${fmtPct(d.thenVsNow!.now)}`,
          spark: d.sparkline, value: `−${Math.round(-d.thenVsNow!.deltaPp)} pts`,
          href: `/pulse/dept?dept=${encodeURIComponent(d.dept)}`,
        })),
        more: falling.length > 3 ? falling.length - 3 : undefined,
      }}
      detail={{ href: '#detail-delegation', label: `See every department's trend` }}
      note="Claude reads each prompt and judges its depth against your tier rules. Weeks run Monday to Sunday; only completed weeks are shown."
    >
      <Columns
        labels={weeks.map(w => dayMonth(w.weekStart))}
        series={[
          { label: 'Routine', colour: AC.tier1, values: weeks.map(w => pct(w, 't1')) },
          { label: 'Meaningful', colour: AC.tier2, values: weeks.map(w => pct(w, 't2')) },
          { label: 'Frontier', colour: AC.tier3, values: weeks.map(w => pct(w, 't3')) },
        ]}
        max={100}
        yTicks={[0, 50, 100]}
        yFormat={v => `${v}%`}
        callout={lastShare !== null ? { index: weeks.length - 1, text: `${fmtPct(lastShare)} last week`, judged: true } : undefined}
      />
    </AnswerPanel>
  );
}

function Fig({ children }: { children: React.ReactNode }) { return <b>{children}</b>; }

/* ── Is the know-how spreading? ─────────────────────────────────── */

export function KnowHow({ counts, people, depts }: { counts: number[]; people: number; depts: DeptRow[] }) {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) {
    return <AnswerPanel question="Is the know-how spreading?" period="Last 14 days" tag="judged" quiet="No frontier work in the last 14 days, so there is nothing to spread yet." />;
  }
  const top3 = counts.slice(0, 3).reduce((a, b) => a + b, 0);
  const share = top3 / total;
  const lowResilience = depts.filter(d => d.avg_ors !== null && d.member_count >= 2).sort((a, b) => (a.avg_ors ?? 0) - (b.avg_ors ?? 0));
  const weak = lowResilience.filter(d => (d.avg_ors ?? 1) < 0.5);
  const max = counts[0] || 1;
  const W = 600, H = 120, top = 26, n = counts.length, gap = n > 30 ? 2 : 4, bw = (W - gap * (n - 1)) / Math.max(1, n);
  const cut = Math.min(3, n);
  const xCut = cut * (bw + gap) - gap / 2;
  const answer = people <= 3
    ? <><b>{plural(people, 'person', 'people')}</b> did all the frontier work in the last 14 days.</>
    : <>Frontier work rests on few people: the top <b>3 of {fmtInt(people)}</b> did <b>{fmtPct(share)}</b> of it in the last 14 days.</>;
  return (
    <AnswerPanel
      question="Is the know-how spreading?"
      period="Last 14 days"
      tag="judged"
      answer={answer}
      attention={{
        title: 'Departments where practice is least shared',
        items: weak.slice(0, 3).map(d => ({ key: d.department, label: d.department, why: `resilience ${d.avg_ors!.toFixed(2)} of 1`, href: `/pulse/dept?dept=${encodeURIComponent(d.department)}`, action: 'Open' })),
        more: weak.length > 3 ? weak.length - 3 : undefined,
      }}
      detail={{ href: '#detail-departments', label: `See every department's resilience` }}
      note="each bar is one person's frontier prompts, most first, with no names shown here. Resilience is how widely a department's skills, connectors and practice are shared, from 0 to 1."
    >
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block" role="img">
        {counts.map((c, i) => {
          const h = (c / max) * (H - top - 16);
          return <rect key={i} x={i * (bw + gap)} y={H - 16 - h} width={bw} height={Math.max(h, 1)} fill={AC.tier3} opacity={i < cut ? 1 : 0.55} />;
        })}
        {n > 3 && <line x1={xCut} x2={xCut} y1={top - 8} y2={H - 16} stroke={AC.ink} strokeDasharray="3 2" />}
        {n > 3 && <text x={xCut + 6} y={top - 10} fontSize="11" fontWeight="600" fill={AC.ink}>{`← top 3 people, ${fmtPct(share)} of frontier work`}</text>}
        {n > 3 && <text x={xCut + 6} y={top + 6} fontSize="11" fill={AC.faint}>{`${fmtInt(people - 3)} more people share the other ${fmtPct(1 - share)} →`}</text>}
        <text x={0} y={H - 2} fontSize="11" fill={AC.faint}>Most frontier work</text>
        <text x={W} y={H - 2} textAnchor="end" fontSize="11" fill={AC.faint}>Least</text>
      </svg>
    </AnswerPanel>
  );
}

/* ── What did the work produce? ─────────────────────────────────── */

export function Produced({ output, human, product }: { output: SessionOutputReport | null | undefined; human: HumanTimeSummary | null | undefined; product: string }) {
  if (!output?.hasData) return null;
  const kinds = [...(output.byTaskType ?? [])].sort((a, b) => b.rate - a.rate);
  const ratio = human?.ratio ?? null;
  const shown = kinds.slice(0, 6);
  return (
    <AnswerPanel
      question="What did the work produce?"
      period="Last 13 weeks"
      tag={ratio !== null ? 'estimate' : 'measured'}
      answer={<>
        <b>{output.rate === null ? 'Not measured' : fmtPct(output.rate)}</b> of {product} sessions produced a file
        {ratio !== null ? <>. By hand the same work would have taken about <b>{ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)} times</b> as long</> : null}.
      </>}
      detail={{ href: '#detail-output', label: `See every kind of work` }}
      note={<>a session produced a file when Claude saved, sent or published one.{ratio !== null && human ? ` By-hand time is Claude's estimate for the ${fmtInt(human.sessions)} sessions with both figures, last ${human.windowDays} days.` : ''}</>}
    >
      {ratio !== null && human && (
        <div className="mb-4">
          <TargetBars
            labelWidth={150}
            rows={[
              { key: 'c', label: 'Claude time', value: human.claudeMinutes / 60, display: `${fmtInt(human.claudeMinutes / 60)} h` },
              { key: 'h', label: 'By hand (estimate)', value: human.humanMinutes.likely / 60, display: `≈${fmtInt(human.humanMinutes.likely / 60)} h`, colour: AC.judged },
            ]}
          />
        </div>
      )}
      {shown.length > 0 && (
        <>
          <div className="text-[12px] text-[#8F8F8F] mb-1">Share that produced a file, by kind of work</div>
          <TargetBars labelWidth={150} max={100} rows={shown.map(k => ({ key: k.taskType, label: taskTypeWords(k.taskType), value: k.rate * 100, display: `${Math.round(k.rate * 100)}%` }))} />
          {kinds.length > shown.length && <div className="text-[12px] text-[#8F8F8F] pt-1">and {kinds.length - shown.length} more kinds of work</div>}
        </>
      )}
    </AnswerPanel>
  );
}

/* ── Which products are people using? ───────────────────────────── */

const PRODUCT_LABEL: Record<string, string> = {
  cowork: 'Claude Cowork', excel: 'Excel', word: 'Word', powerpoint: 'PowerPoint', outlook: 'Outlook',
  sheets: 'Google Sheets', docs: 'Google Docs', slides: 'Google Slides', claude_chat: 'Claude Chat', chatgpt: 'ChatGPT',
};

export function Products({ data }: { data: ByProductData | null | undefined }) {
  if (!data) return null;
  const rows = data.rows.filter(r => r.product !== 'all' && r.people > 0).sort((a, b) => b.people - a.people);
  if (rows.length === 0) return null;
  const lead = rows[0];
  const colour = (p: string) => (BY_PRODUCT_ROW_COLOR as Record<string, string>)[p] ?? (WORK_PRODUCT_COLOR as Record<string, string>)[p] ?? AC.measured;
  const name = (p: string) => PRODUCT_LABEL[p] ?? p;
  const quietApps = data.rows.filter(r => r.product !== 'all' && r.people === 0).length;
  const maxPeople = Math.max(...rows.map(r => r.people));
  return (
    <AnswerPanel
      question="Which products are people using?"
      period="Last 30 days"
      answer={<>{name(lead.product)} carries most of the work: <b>{plural(lead.people, 'person', 'people')}</b>{lead.meaningfulPct !== null ? <>, with <b>{Math.round(lead.meaningfulPct)}%</b> of it meaningful or frontier</> : null}.</>}
      tag={lead.meaningfulPct !== null ? 'judged' : 'measured'}
      detail={{ href: '#detail-products', label: 'See sessions, outputs and spend by product' }}
      note={<>people with at least one prompt in the product in 30 days. Meaningful or frontier is Claude&apos;s judgement of each prompt.{quietApps > 0 ? ` ${plural(quietApps, 'product')} with no activity left out.` : ''}</>}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-6 text-[12px] text-[#8F8F8F] mb-1"><span>People</span><span>Meaningful or frontier</span></div>
      {rows.map(r => (
        <div key={r.product} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-6 items-center py-[5px] text-[13px]">
          <span className="flex items-center gap-2 min-w-0">
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: colour(r.product) }} />
            <span className="w-[104px] shrink-0 truncate text-[#333333]">{name(r.product)}</span>
            <span className="relative flex-1 h-3 rounded-[2px]" style={{ background: AC.track }}><span className="absolute inset-y-0 left-0 rounded-[2px]" style={{ width: `${(r.people / maxPeople) * 100}%`, background: AC.measured }} /></span>
            <span className="w-8 text-right tabular-nums font-medium">{fmtInt(r.people)}</span>
          </span>
          {r.meaningfulPct === null ? <span className="text-[#8F8F8F]">Not judged</span> : (
            <span className="flex items-center gap-2">
              <span className="relative flex-1 h-3 rounded-[2px]" style={{ background: AC.track }}><span className="absolute inset-y-0 left-0 rounded-[2px]" style={{ width: `${r.meaningfulPct}%`, background: AC.judged }} /></span>
              <span className="w-10 text-right tabular-nums text-[#2451F3] font-medium">{Math.round(r.meaningfulPct)}%</span>
            </span>
          )}
        </div>
      ))}
      <Legend items={[{ label: 'People', colour: AC.measured }, { label: 'Meaningful or frontier (AI-judged)', colour: AC.judged }]} />
    </AnswerPanel>
  );
}

/* ── How do departments compare? ────────────────────────────────── */

export function DeptCompare({ depts, floor }: { depts: DeptRow[]; floor: number }) {
  const bench = buildDeptBenchmark(depts.map(d => ({ department: d.department, member_count: d.member_count, avg_dds: d.avg_dds })), { floor });
  const rows = bench.rows.filter(r => !r.tooSmall && r.avgDds !== null).sort((a, b) => (b.avgDds ?? 0) - (a.avgDds ?? 0));
  if (bench.median === null || rows.length < 2) return null;
  const below = rows.filter(r => r.needsSupport);
  const leader = rows[0];
  const lo = Math.min(1, ...rows.map(r => r.avgDds!)), hi = Math.max(floor + 0.5, ...rows.map(r => r.avgDds!));
  const x = (v: number) => ((v - lo) / (hi - lo)) * 100;
  const tooSmall = bench.rows.filter(r => r.tooSmall).length;
  return (
    <AnswerPanel
      question="How do departments compare?"
      period="Last 14 days"
      tag="judged"
      answer={below.length === 0
        ? <>Every department is above the support floor for delegation depth. {leader.department} leads the organisation.</>
        : <><b>{listWords(below.map(b => b.department))}</b> {below.length === 1 ? 'sits' : 'sit'} below the support floor for delegation depth. {leader.department} leads the organisation.</>}
      detail={{ href: '#detail-departments', label: `See all ${plural(bench.rows.length, 'department')}` }}
      note={<>delegation depth is the average tier of each person&apos;s prompts, from 1 to 3. The support floor ({floor.toFixed(1)}) is set in Admin → Work Pulse.{tooSmall > 0 ? ` ${plural(tooSmall, 'department')} with fewer than ${bench.minSize} people left out.` : ''}</>}
    >
      <div className="relative">
        <div className="absolute top-0 bottom-0 bg-[#FFF4E5]" style={{ left: 120, width: `calc((100% - 180px) * ${x(floor) / 100})` }} />
        {rows.map(r => {
          const worse = r.needsSupport;
          return (
            <div key={r.department} className="relative flex items-center gap-2.5 py-[6px] text-[13px]">
              <span className="w-[110px] shrink-0 truncate text-[#333333]">{r.department}</span>
              <span className="relative flex-1 h-4">
                <span className="absolute top-0 bottom-0 border-l border-[#0A0A0A]" style={{ left: `${x(bench.median!)}%` }} />
                <span className="absolute top-1/2 h-[2px] -translate-y-1/2 bg-[#D4D4D8]" style={{ left: `${Math.min(x(bench.median!), x(r.avgDds!))}%`, width: `${Math.abs(x(r.avgDds!) - x(bench.median!))}%` }} />
                <span className="absolute top-1/2 w-3 h-3 -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ left: `${x(r.avgDds!)}%`, background: worse ? AC.warn : AC.tier3 }} />
              </span>
              <span className={`w-[50px] shrink-0 text-right tabular-nums font-medium ${worse ? 'text-[#B54708]' : 'text-[#0A0A0A]'}`}>{r.avgDds!.toFixed(2)}</span>
            </div>
          );
        })}
      </div>
      <Legend items={[{ label: 'Department', colour: AC.tier3, mark: 'dot' }, { label: `Below the support floor (${floor.toFixed(1)})`, colour: AC.warn, mark: 'dot' }, { label: `Organisation median (${bench.median.toFixed(2)})`, colour: AC.ink, mark: 'line' }]} />
    </AnswerPanel>
  );
}

/* ── Capabilities ───────────────────────────────────────────────── */

export function Capabilities({ timeline, pending, confirmedTotal }: {
  timeline: Array<{ id: number; title: string; status: 'confirmed' | 'candidate'; at: number }>;
  pending: number;
  confirmedTotal: number | null;
}) {
  const nowS = Math.floor(Date.now() / 1000);
  const confirmed30 = timeline.filter(t => t.status === 'confirmed').length;
  if (timeline.length === 0 && pending === 0) {
    return <AnswerPanel question="New capabilities" period="Last 30 days" quiet={<>No new capabilities in the last 30 days{confirmedTotal ? `; ${plural(confirmedTotal, 'capability', 'capabilities')} confirmed in all` : ''}.</>} detail={{ href: '#detail-capabilities', label: 'See the capability log' }} />;
  }
  const start = nowS - 30 * 86400;
  const x = (t: number) => Math.max(0, Math.min(100, ((t - start) / (30 * 86400)) * 100));
  return (
    <AnswerPanel
      question="New capabilities"
      period="Last 30 days"
      tag="judged"
      answer={<><b>{fmtInt(confirmed30)}</b> new {confirmed30 === 1 ? 'capability' : 'capabilities'} confirmed in the last 30 days{pending > 0 ? <>, and <b>{fmtInt(pending)}</b> waiting for review</> : null}.</>}
      detail={pending > 0 ? { href: '/admin/pulse?tab=users', label: `Review ${fmtInt(pending)} waiting` } : { href: '#detail-capabilities', label: 'See the capability log' }}
      note="Claude flags work that creates a reusable process; a manager confirms it."
    >
      <div className="relative h-[86px]">
        <div className="absolute left-0 right-0 top-[38px] h-[2px] bg-[#DADADA]" />
        {timeline.map((t, i) => (
          <div key={t.id} className="absolute -translate-x-1/2 flex flex-col items-center" style={{ left: `${x(t.at)}%`, top: i % 2 === 0 ? 0 : 30 }}>
            {i % 2 === 0 && <span className="text-[11px] max-w-[110px] truncate mb-1" style={{ color: t.status === 'confirmed' ? '#333333' : AC.judgedInk }}>{t.title}</span>}
            <span className="w-4 h-4 rounded-full border-[2.5px]" style={{ background: t.status === 'confirmed' ? AC.measured : '#fff', borderColor: t.status === 'confirmed' ? AC.measured : AC.judged, marginTop: i % 2 === 0 ? 0 : 0 }} />
            {i % 2 === 1 && <span className="text-[11px] max-w-[110px] truncate mt-1" style={{ color: t.status === 'confirmed' ? '#333333' : AC.judgedInk }}>{t.title}</span>}
          </div>
        ))}
      </div>
      <div className="flex justify-between text-[11px] text-[#8F8F8F]"><span>{dayMonth(start)}</span><span>Today</span></div>
      <Legend items={[{ label: 'Confirmed', colour: AC.measured, mark: 'dot' }, { label: 'Waiting for review', colour: AC.judged, mark: 'ring' }]} />
    </AnswerPanel>
  );
}

/* ── What to act on next: answer line above the existing panel ──── */

export function actNextAnswer(processBoxes: number, coaching: number, modelReview: number): string | null {
  const parts: string[] = [];
  if (processBoxes > 0) parts.push(plural(processBoxes, 'department process to review', 'department processes to review'));
  if (coaching > 0) parts.push(plural(coaching, 'coaching opportunity', 'coaching opportunities'));
  if (modelReview > 0) parts.push(plural(modelReview, 'model to review', 'models to review'));
  if (parts.length === 0) return null;
  return `${parts.length === 1 ? 'One thing' : `${parts.length === 2 ? 'Two' : 'Three'} things`} to act on: ${listWords(parts)}.`;
}

export type { AttentionItem };
export { SplitBar, DotCompare };
