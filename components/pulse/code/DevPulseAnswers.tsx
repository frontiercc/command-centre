// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

/**
 * Developer Pulse overview panels in the answer layout (components/precision/answer.tsx). Answer
 * sentences are written here from the org-summary figures; nothing is AI-written.
 */
import { useEffect, useState } from 'react';
import { AnswerPanel, AC, Columns, TargetBars, type AttentionItem } from '@/components/precision/answer';
import { ageWords, changeWords, dayMonth, fmtInt, fmtPct, fmtUsd, fmtUsdShort, plural } from '@/lib/ui/answer-text';
import { codeWorkTypeLabel } from '@/lib/pulse/code/work-type-labels';
import { SURFACE_COLOR, PRODUCT_COLOR } from '@/lib/ui/chart-colours';
import type { Vendor } from '@/lib/dashboard/vendor';

interface WeeklyPoint { weekStart: number; value: number | null; partial: boolean }

export function toolName(vendor: Vendor, codexPresent: boolean): string {
  if (vendor === 'openai') return 'Codex';
  if (vendor === 'claude' || !codexPresent) return 'Claude Code';
  return 'Claude Code and Codex';
}

function completed(series: WeeklyPoint[]): { last: number | null; prev: number | null } {
  const done = series.filter(p => !p.partial && p.value !== null);
  return { last: done.length ? done[done.length - 1].value : null, prev: done.length >= 2 ? done[done.length - 2].value : null };
}

/* ── What is it costing? ─────────────────────────────────────────── */

export function Costing({ series, projection, tool, estimated }: {
  series: WeeklyPoint[];
  projection: { projected: number } | null;
  tool: string;
  estimated: boolean;
}) {
  const [spikes, setSpikes] = useState<AttentionItem[] | null>(null);
  useEffect(() => {
    fetch('/api/alerts?status=open')
      .then(r => (r.ok ? r.json() : []))
      .then((rows: Array<{ id: string; alert_type: string; title: string; generated_at: number }>) => {
        const nowS = Math.floor(Date.now() / 1000);
        setSpikes((Array.isArray(rows) ? rows : [])
          .filter(a => a.alert_type === 'code_cost_spike' || a.alert_type === 'codex_cost_spike')
          .map(a => ({ key: a.id, label: a.title, why: `· ${ageWords(a.generated_at, nowS)} ago`, href: `/alerts?id=${encodeURIComponent(a.id)}`, action: 'Review' })));
      })
      .catch(() => setSpikes([]));
  }, []);
  const { last, prev } = completed(series);
  if (last === null && projection === null) return null;
  const words = last !== null ? changeWords(last, prev) : null;
  const lastIdx = series.map(p => !p.partial && p.value !== null).lastIndexOf(true);
  return (
    <AnswerPanel
      question={`What is ${tool} costing?`}
      period="Last 8 weeks"
      tag={projection ? 'estimate' : 'measured'}
      answer={<>
        {last !== null ? <>{tool} cost <b>{fmtUsd(last)}</b> last week{words ? `, ${words} the week before` : ''}.</> : null}
        {projection ? <> This month is on pace for <b>{fmtUsd(projection.projected)}</b>.</> : null}
      </>}
      attention={spikes && spikes.length > 0 ? { title: 'Over the daily spend limit', items: spikes.slice(0, 3), more: spikes.length > 3 ? spikes.length - 3 : undefined } : undefined}
      detail={{ href: '/finops/spend-review', label: "See everyone's spend in Spend Review" }}
      note={<>tokens priced at your admin rates{estimated ? ' (some at list price, an estimate)' : ''}. The current week is drawn hollow. Change is shown in grey: more spend isn&apos;t good or bad on its own.</>}
    >
      <Columns
        labels={series.map(p => dayMonth(p.weekStart))}
        series={[{ label: 'Spend', colour: AC.measured, values: series.map(p => p.value) }]}
        yFormat={fmtUsdShort}
        hollowLast={series[series.length - 1]?.partial}
        callout={lastIdx >= 0 && last !== null ? { index: lastIdx, text: fmtUsd(last) } : undefined}
      />
    </AnswerPanel>
  );
}

/* ── Is the work shipping? ───────────────────────────────────────── */

export function Shipping({ commits, github, dark, tool }: {
  commits: WeeklyPoint[];
  github: {
    totalPrs7d: number; totalCommits7d: number;
    shippingSeries: Array<{ date: string; aiCommits: number; ghCommits: number }>;
    repoCards: Array<{ repo: string; commits7d: number; commitsPrev7d: number; daily: number[] }>;
  } | null;
  dark: Array<{ repo: string; last_seen?: number | null }>;
  tool: string;
}) {
  const { last, prev } = completed(commits);
  const words = last !== null ? changeWords(last, prev) : null;
  const ss = github?.shippingSeries ?? [];
  const last7 = ss.slice(-7);
  const ai7 = last7.reduce((a, d) => a + d.aiCommits, 0), gh7 = last7.reduce((a, d) => a + d.ghCommits, 0);
  const share = gh7 > 0 ? Math.min(1, ai7 / gh7) : null;
  const falling = (github?.repoCards ?? []).filter(c => c.commitsPrev7d >= 5 && c.commits7d < c.commitsPrev7d * 0.6);
  const items: AttentionItem[] = [
    ...dark.slice(0, 3).map(d => ({ key: `d-${d.repo}`, label: d.repo, why: 'no activity in 30 days', value: 'Quiet' })),
    ...falling.slice(0, 3).map(c => ({ key: `f-${c.repo}`, label: c.repo, why: `commits ${fmtInt(c.commitsPrev7d)} to ${fmtInt(c.commits7d)} on the week before`, spark: c.daily, value: `−${Math.round((1 - c.commits7d / c.commitsPrev7d) * 100)}%` })),
  ];
  if (last === null && ss.length === 0) return null;
  return (
    <AnswerPanel
      question="Is the work shipping?"
      period={ss.length > 0 ? 'Last 30 days' : 'Last 8 weeks'}
      tag="measured"
      answer={<>
        {last !== null ? <>{tool} helped make <b>{plural(last, 'commit')}</b> last week{words ? `, ${words} the week before` : ''}.</> : null}
        {github && share !== null ? <> That is <b>{fmtPct(share)}</b> of commits in your tracked repos, with <b>{plural(github.totalPrs7d, 'pull request')}</b> merged this week.</> : null}
      </>}
      attention={items.length > 0 ? { title: 'Repos gone quiet or falling', items: items.slice(0, 4), more: items.length > 4 ? items.length - 4 : undefined } : undefined}
      detail={{ href: '#detail-shipping', label: github ? 'See every tracked repo' : 'See shipping in detail' }}
      note={github ? <>commits counted from GitHub for the repos you track, matched to {tool} by author and day.</> : <>commits made in {tool} sessions, counted from telemetry.</>}
    >
      {ss.length > 0 ? (
        <Columns
          labels={ss.map(d => d.date.slice(8, 10) === '01' || ss.indexOf(d) % 7 === 0 ? dayMonth(Date.parse(d.date) / 1000) : '')}
          series={[
            { label: `With ${tool}`, colour: SURFACE_COLOR.code, values: ss.map(d => Math.min(d.aiCommits, Math.max(d.ghCommits, d.aiCommits))) },
            { label: 'No AI tool', colour: '#D6D6D6', values: ss.map(d => Math.max(0, d.ghCommits - d.aiCommits)) },
          ]}
          height={160}
        />
      ) : (
        <Columns
          labels={commits.map(p => dayMonth(p.weekStart))}
          series={[{ label: 'Commits', colour: SURFACE_COLOR.code, values: commits.map(p => p.value) }]}
          hollowLast={commits[commits.length - 1]?.partial}
        />
      )}
      {ss.length > 0 && (
        <div className="flex flex-wrap gap-x-4 mt-2 text-[12px] text-[#666666]">
          <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-[2px]" style={{ background: SURFACE_COLOR.code }} />With {tool}</span>
          <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-[2px] bg-[#D6D6D6]" />No AI tool</span>
        </div>
      )}
    </AnswerPanel>
  );
}

/* ── Are developers delegating? ─────────────────────────────────── */

export function Delegating({ autonomy, workMix, tool }: {
  autonomy: WeeklyPoint[];
  workMix: Array<{ sessions: number; tier3: number }> | null;
  tool: string;
}) {
  const { last, prev } = completed(autonomy);
  const sessions = (workMix ?? []).reduce((a, w) => a + w.sessions, 0);
  const frontier = (workMix ?? []).reduce((a, w) => a + w.tier3, 0);
  const frontierShare = sessions > 0 ? frontier / sessions : null;
  if (last === null) return null;
  const dir = prev === null ? '' : Math.abs(last - prev) < 0.05 ? `, the same as the week before` : last > prev ? `, up from ${prev.toFixed(1)} the week before` : `, down from ${prev.toFixed(1)} the week before`;
  return (
    <AnswerPanel
      question="Are developers delegating?"
      period="Last 8 weeks"
      tag={frontierShare !== null ? 'judged' : 'measured'}
      answer={<>Developers give {tool} <b>{last.toFixed(1)} actions</b> per instruction{dir}.{frontierShare !== null ? <> <b>{fmtPct(frontierShare)}</b> of sessions in the last 30 days were frontier work.</> : null}</>}
      detail={{ href: '/pulse/code/users', label: "See each person's journey" }}
      note="actions per instruction is measured from session telemetry: the tool actions Claude takes for each prompt a developer types. Frontier is Claude's judgement of each finished session."
    >
      <Columns
        labels={autonomy.map(p => dayMonth(p.weekStart))}
        series={[{ label: 'Actions per instruction', colour: AC.measured, values: autonomy.map(p => p.value) }]}
        yFormat={v => v.toFixed(1)}
        hollowLast={autonomy[autonomy.length - 1]?.partial}
      />
    </AnswerPanel>
  );
}

/* ── What kind of work is it? ───────────────────────────────────── */

export function KindOfWork({ workMix, tool }: {
  workMix: Array<{ work_type: string; label?: string; sessions: number }> | null;
  tool: string;
}) {
  if (!workMix || workMix.length === 0) return null;
  const total = workMix.reduce((a, w) => a + w.sessions, 0);
  if (total === 0) return null;
  const rows = [...workMix].sort((a, b) => b.sessions - a.sessions);
  const top = rows[0];
  const shown = rows.slice(0, 5);
  const name = (w: { work_type: string; label?: string }) => w.label ?? codeWorkTypeLabel(w.work_type);
  return (
    <AnswerPanel
      question="What kind of work is it?"
      period="Last 30 days"
      tag="judged"
      answer={<><b>{name(top)}</b> is {fmtPct(top.sessions / total)} of {tool} sessions{rows[1] ? <>, then {name(rows[1]).toLowerCase()} at {fmtPct(rows[1].sessions / total)}</> : null}.</>}
      detail={{ href: '#detail-work', label: `See all ${plural(rows.length, 'kind')} of work` }}
      note={`Claude reads each finished session and names its kind of work. Top ${shown.length} of ${rows.length} shown.`}
    >
      <TargetBars tone="judged" labelWidth={170} max={100} rows={shown.map(w => ({ key: w.work_type, label: name(w), value: (w.sessions / total) * 100, display: fmtPct(w.sessions / total) }))} />
    </AnswerPanel>
  );
}

/* ── Which skills and subagents drive spend? ─────────────────────── */

export function Leverage({ skills, agents, subagentShare }: {
  skills: Array<{ name: string; turns: number; spend_usd: number | null }>;
  agents: Array<{ name: string; turns: number; spend_usd: number | null }>;
  subagentShare: number | null;
}) {
  const rows = [
    ...skills.map(s => ({ ...s, kind: 'Skill' })),
    ...agents.map(a => ({ ...a, kind: 'Subagent' })),
  ].filter(r => r.spend_usd !== null && r.spend_usd > 0).sort((a, b) => (b.spend_usd ?? 0) - (a.spend_usd ?? 0));
  if (rows.length === 0) return null;
  const top = rows[0];
  const shown = rows.slice(0, 5);
  return (
    <AnswerPanel
      question="Which skills and subagents drive spend?"
      period="Last 30 days"
      tag="measured"
      answer={<>The <b>{top.name.replace(':', ' · ')}</b> {top.kind.toLowerCase()} cost the most, <b>{fmtUsd(top.spend_usd!)}</b> over {plural(top.turns, 'turn')}.{subagentShare !== null ? <> Subagents ran <b>{fmtPct(subagentShare)}</b> of all turns.</> : null}</>}
      detail={{ href: '#detail-tools', label: `See all ${plural(rows.length, 'skill and subagent', 'skills and subagents')}` }}
      note="spend on the turns each skill or subagent was active for, priced at your admin rates."
    >
      <TargetBars labelWidth={190} rows={shown.map(r => ({ key: `${r.kind}-${r.name}`, label: `${r.name.replace(':', ' · ')} (${r.kind.toLowerCase()})`, value: r.spend_usd, display: fmtUsd(r.spend_usd!), colour: r.kind === 'Subagent' ? PRODUCT_COLOR.claude_code : AC.measured }))} />
      <div className="flex flex-wrap gap-x-4 mt-2 text-[12px] text-[#666666]">
        <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-[2px]" style={{ background: AC.measured }} />Skill</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-[2px]" style={{ background: PRODUCT_COLOR.claude_code }} />Subagent</span>
      </div>
    </AnswerPanel>
  );
}
