// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

// One piece of work. Measured facts, plus one AI-judged
// sentence marked as such (violet, the product's judged colour, with an AI summary tag). Anything not
// measured is left out, never shown as zero or "no". Descriptions and output
// file names arrive only when this viewer may see them (decided server-side).
import Link from 'next/link';
import type { WorkItem } from '@/lib/pulse/frontier-view';
import { Tag } from '@/components/precision/ui';

export function kindLabel(taskType: string): string {
  const s = taskType.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function formatWorkDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function activeLabel(secs: number): string {
  const mins = Math.round(secs / 60);
  if (mins < 1) return 'under a minute active';
  if (mins < 60) return `${mins} min active`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min active` : `${h} h active`;
}

/** Skill names arrive as `marketplace:name`; the name alone reads better. */
function skillName(s: string): string {
  const i = s.lastIndexOf(':');
  return i >= 0 ? s.slice(i + 1) : s;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function counted(n: number, one: string, many: string): string | null {
  return n > 0 ? (n === 1 ? one : `${n} ${many}`) : null;
}

/** What came out: file names when captured, else counts, else the session-level flag. */
function producedParts(item: WorkItem): string[] {
  const f = item.facts;
  if (f.outputNames.length) {
    const extra = counted(f.outputs.artifacts, 'created an artifact', 'artifacts');
    return [`produced ${f.outputNames.join(', ')}`, ...(extra ? [extra] : [])];
  }
  const parts = [
    counted(f.outputs.written, 'wrote a file', 'files written'),
    counted(f.outputs.artifacts, 'created an artifact', 'artifacts created'),
    counted(f.outputs.sent, 'sent a file', 'files sent'),
  ].filter((x): x is string => !!x);
  if (parts.length) return parts;
  return f.producedOutput === true ? ['produced a file'] : [];
}

function howParts(item: WorkItem): string[] {
  const h = item.facts.how;
  return [
    h.searches ? plural(h.searches, 'web search', 'web searches') : null,
    h.fetches ? `fetched ${plural(h.fetches, 'page', 'pages')}` : null,
    h.reads ? `read ${plural(h.reads, 'file', 'files')}` : null,
    h.planned ? `planned ${plural(h.planned, 'step', 'steps')}` : null,
    h.questions ? `asked ${plural(h.questions, 'question', 'questions')}` : null,
  ].filter((x): x is string => !!x);
}

interface Props {
  item: WorkItem;
  showName: boolean;
  canOpenUseCases: boolean;
  /** Kept for callers; every surface is now a white panel, so both tones render alike. */
  tone?: 'light' | 'dark';
  /** Cards: the description plus one line; the full detail is for the top box. */
  compact?: boolean;
}

export default function WorkDetail({ item, showName, canOpenUseCases, compact = false }: Props) {
  const f = item.facts;

  // The one AI-written sentence: violet, labelled as an AI summary.
  const description = item.description && (
    <p className="m-0 mb-1 text-[13px] leading-5 text-[#2451F3]">
      <span className="mr-1.5 align-middle"><Tag tone="judged">AI summary</Tag></span>
      {item.description}
    </p>
  );

  const when = [
    showName ? item.displayName : null,
    formatWorkDate(item.occurredAt),
    f.activeSecs != null && f.activeSecs > 0 ? activeLabel(f.activeSecs) : null,
    f.steps != null && f.steps > 0 ? plural(f.steps, 'step', 'steps') : null,
  ].filter((x): x is string => !!x);

  const systems = [...f.connectors, ...f.skills.map(skillName)];
  const inputs = f.inputs.length
    ? `${f.inputs.join(' and ')} in`
    : (f.uploads != null && f.uploads > 0 ? `${plural(f.uploads, 'document', 'documents')} in` : null);
  const used = [systems.length ? systems.join(', ') : null, inputs].filter((x): x is string => !!x);
  const produced = producedParts(item);

  if (compact) {
    const one = [...when, ...used, ...produced];
    return (
      <div>
        {description}
        {one.length > 0 && <p className="m-0 text-[13px] leading-5 text-[#666666]">{one.join(' · ')}</p>}
      </div>
    );
  }

  const how = howParts(item);
  const spread = [
    item.repeatsSince > 0 ? `repeated ${plural(item.repeatsSince, 'time', 'times')} since` : null,
    item.othersAtDepth === null || !item.department
      ? null
      : item.othersAtDepth === 0
        ? `only person in ${item.department} working at this depth`
        : `${plural(item.othersAtDepth, 'other', 'others')} in ${item.department} work at this depth`,
  ].filter((x): x is string => !!x);

  const line = (label: string | null, parts: string[]) => (
    <p className="m-0">
      {label && <span className="text-[#8F8F8F]">{label} </span>}
      {parts.join(' · ')}
    </p>
  );

  return (
    <div className="text-[13px] leading-5 text-[#4D4D4D] flex flex-col gap-0.5">
      {description}
      {when.length > 0 && line(null, when)}
      {used.length > 0 && line('Used:', used)}
      {how.length > 0 && line('How:', how)}
      {produced.length > 0 && line('Result:', produced)}
      {spread.length > 0 && line(null, spread)}
      {item.useCase && (
        <p className="m-0">
          <span className="text-[#8F8F8F]">Matches use case: </span>
          {canOpenUseCases
            ? <Link href={`/use-cases/${encodeURIComponent(item.useCase.id)}`} className="text-[#245BF3] hover:underline">{item.useCase.title}</Link>
            : <span>{item.useCase.title}</span>}
        </p>
      )}
    </div>
  );
}
