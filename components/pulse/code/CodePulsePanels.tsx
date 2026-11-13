// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

/**
 * Developer Pulse panels for a person or a department: one period at a time, plain statements
 * written here from the figures, one chart colour (petrol). The same shapes as Work Pulse, so the
 * two read alike; the words differ because the unit of work is a coding session, not a task.
 */
import { QuestionCard, shareWords } from '@/components/dashboard/QuestionCard';
import { Frame, Track } from '@/components/pulse/WorkPulseOverview';
import { PeriodSwitch, type Who } from '@/components/pulse/MyPulsePanels';
import { type PulsePeriod } from '@/lib/pulse/period-shape';
import { deepWords, tierList, type TierNames } from '@/lib/pulse/tier-names';

export interface CodePeriodWork {
  period: PulsePeriod;
  label: string;
  prior: string;
  sessions: { now: number; before: number };
  commits: { now: number; before: number };
  prs: { now: number; before: number };
  engagedSecs: { now: number; before: number };
  linesAdded: { now: number; before: number };
  spendUsd: { now: number; before: number };
  trend: { sessions: number[]; commits: number[]; engagedSecs: number[]; spendUsd: number[] };
  automation: number | null;
  cacheHit: number | null;
  editAcceptance: number | null;
  repos: number | null;
}

export interface CodeWorkMixRow { work_type: string; label: string; sessions: number; deep: number }

export interface BestSession {
  sessionId: string;
  repo: string | null;
  branch: string | null;
  tier: number;
  workType: string;
  label: string;
  occurredAt: number;
  activeSecs: number | null;
  prompts: number;
  actions: number;
  commits: number;
}

const hours = (secs: number) => {
  const h = secs / 3600;
  if (h < 1) return `${Math.round(secs / 60)}m`;
  return h < 10 ? `${h.toFixed(1)}h` : `${Math.round(h).toLocaleString('en-GB')}h`;
};
const usd = (v: number) => (v >= 100 ? `$${Math.round(v).toLocaleString('en-GB')}` : `$${v.toFixed(2)}`);
const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;
const dateOf = (s: number) => new Date(s * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const subj = (w: Who) => (w.you ? 'You' : w.name);
const poss = (w: Who) => (w.you ? 'your' : `${w.name}'s`);

function change(now: number, before: number, prior: string, fmt: (v: number) => string): string {
  if (before === 0) return `nothing recorded ${prior}`;
  if (fmt(now) === fmt(before)) return `the same as ${prior}`;
  return `${now > before ? 'up' : 'down'} from ${fmt(before)} ${prior}`;
}

/* ── 1: The coding work of the period ──────────────────────────── */

export function CodeWorkPanel({ w, who, period, onPeriod, product }: {
  w: CodePeriodWork; who: Who; period: PulsePeriod; onPeriod: (p: PulsePeriod) => void; product: string;
}) {
  const shipped = w.commits.now + w.prs.now;
  const answer = w.sessions.now === 0
    ? <>No {product} sessions {w.label.toLowerCase()}.</>
    : <>{subj(who)} ran <b>{plural(w.sessions.now, 'session', 'sessions')}</b> with {product} {w.label.toLowerCase()}
      {shipped > 0
        ? <>, shipping <b>{plural(w.commits.now, 'commit', 'commits')}</b>{w.prs.now > 0 ? <> and <b>{plural(w.prs.now, 'pull request', 'pull requests')}</b></> : null}.</>
        : <>, with nothing committed yet.</>}</>;
  return (
    <Frame
      title={who.you ? 'Your coding work' : `${who.name}'s coding work`}
      period={
        <span className="inline-flex items-center gap-2">
          <span>{w.label} against {w.prior}</span>
          <PeriodSwitch period={period} onPeriod={onPeriod} />
        </span>
      }
      answer={answer}
      note={
        <>
          Measured from the sessions themselves.
          {w.automation !== null ? ` The AI took ${w.automation.toFixed(1)} actions per instruction.` : ''}
          {w.editAcceptance !== null ? ` ${Math.round(w.editAcceptance * 100)}% of its edits were accepted.` : ''}
          {w.cacheHit !== null ? ` ${Math.round(w.cacheHit * 100)}% of context came from cache, not re-billed.` : ''}
          {w.repos !== null && w.repos > 0 ? ` ${plural(w.repos, 'codebase', 'codebases')} touched.` : ''}
        </>
      }
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-2.5">
        <QuestionCard
          question={`Sessions with ${product}`}
          value={w.sessions.now.toLocaleString('en-GB')}
          unit={w.sessions.now === 1 ? 'session' : 'sessions'}
          change={change(w.sessions.now, w.sessions.before, w.prior, v => String(v))}
          trend={w.trend.sessions}
          trendKind="bars"
          notMeasured={w.sessions.now === 0 && w.sessions.before === 0 ? `No sessions ${w.label.toLowerCase()}` : undefined}
        />
        <QuestionCard
          question="What it shipped"
          value={w.commits.now.toLocaleString('en-GB')}
          unit={w.commits.now === 1 ? 'commit' : 'commits'}
          change={change(w.commits.now, w.commits.before, w.prior, v => String(v))}
          sub={`${plural(w.prs.now, 'pull request', 'pull requests')} · ${w.linesAdded.now.toLocaleString('en-GB')} lines added`}
          trend={w.trend.commits}
          trendKind="bars"
        />
        <QuestionCard
          question="Engaged time"
          value={hours(w.engagedSecs.now)}
          change={change(w.engagedSecs.now, w.engagedSecs.before, w.prior, hours)}
          trend={w.trend.engagedSecs}
          notMeasured={w.engagedSecs.now === 0 ? 'Not measured in this period' : undefined}
        />
        <QuestionCard
          question="Spend"
          value={usd(w.spendUsd.now)}
          change={change(w.spendUsd.now, w.spendUsd.before, w.prior, usd)}
          trend={w.trend.spendUsd}
          notMeasured={w.spendUsd.now === 0 && w.spendUsd.before === 0 ? 'Nothing priced in this period' : undefined}
        />
      </div>
    </Frame>
  );
}

/* ── 2: Best work this week ────────────────────────────────────── */

export function CodeBestWork({ s, who, names }: { s: BestSession | null; who: Who; names?: TierNames }) {
  const tiers = tierList(names);
  if (!s) {
    return (
      <Frame title="Best work this week" judged period="Last 7 days" answer={<>No classified sessions in the last 7 days.</>} />
    );
  }
  const facts = [
    dateOf(s.occurredAt),
    s.activeSecs ? `${hours(s.activeSecs)} active` : null,
    s.prompts > 0 ? plural(s.prompts, 'instruction', 'instructions') : null,
    s.actions > 0 ? plural(s.actions, 'action', 'actions') : null,
    s.commits > 0 ? plural(s.commits, 'commit', 'commits') : null,
  ].filter(Boolean) as string[];
  return (
    <Frame
      title="Best work this week"
      judged
      period="Deepest session in the last 7 days"
      answer={<><b>{s.label}</b>{s.repo ? <> in {s.repo}{s.branch ? ` · ${s.branch}` : ''}</> : null}, judged {(tiers[s.tier - 1] ?? `tier ${s.tier}`).toLowerCase()}.</>}
      note={`${who.you ? 'Your' : 'Their'} deepest session of the week, by the tier the classifier gave it and then by time at the keyboard.`}
    >
      <p className="m-0 text-[13px] text-[#666666]">{facts.join(' · ')}</p>
    </Frame>
  );
}

/* ── 3: What kinds of coding work ──────────────────────────────── */

export function CodeWorkMix({ rows, who, names }: { rows: CodeWorkMixRow[]; who: Who; names?: TierNames }) {
  if (rows.length === 0) {
    return <Frame title={`${who.you ? 'Your' : 'Their'} work mix`} judged period="Last 30 days" answer={<>No classified sessions in the last 30 days.</>} />;
  }
  const total = rows.reduce((t, r) => t + r.sessions, 0);
  const top = rows[0];
  const max = Math.max(1, ...rows.map(r => r.sessions));
  return (
    <Frame
      title={`${who.you ? 'Your' : 'Their'} work mix`}
      judged
      period="Last 30 days"
      answer={<>Most of {poss(who)} coding work is <b>{top.label.toLowerCase()}</b>: {shareWords(top.sessions / total)} of {plural(total, 'session', 'sessions')}.</>}
      note={<>Claude judges each session once it ends. &ldquo;Deeper&rdquo; means {deepWords(names)}, the top two tiers.</>}
    >
      {rows.slice(0, 6).map(r => (
        <div key={r.work_type} className="grid grid-cols-[minmax(0,210px)_minmax(0,1fr)_116px] gap-2.5 items-center py-[3px] text-[13px]">
          <span className="text-[#333333] leading-4">{r.label}</span>
          <Track value={r.sessions / max} />
          <span className="text-right tabular-nums text-[#333333] whitespace-nowrap">
            {r.sessions} · {r.deep} deeper
          </span>
        </div>
      ))}
    </Frame>
  );
}
