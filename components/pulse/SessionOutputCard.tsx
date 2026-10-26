// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Session output rate card — /pulse/cio, beside Work Mix.
 *
 * Work Mix (violet, AI-judged) says what people were doing. This (blue,
 * measured) says whether anything came out. Deliberately adjacent so the pair
 * reads as one thought.
 *
 * Presented as a RATE with a 13-week trend, never a raw count — a bare count of
 * sessions tells a reader nothing about whether the number is good or moving.
 *
 * Null-not-zero: no measured sessions renders "not measured", never 0%.
 */
import { Panel, Tag, BarRow } from '@/components/precision/ui';

export interface SessionOutputWeek {
  weekStart: number;
  sessions: number;
  produced: number;
  rate: number | null;
}

export interface SessionOutputByTaskType {
  taskType: string;
  sessions: number;
  produced: number;
  rate: number;
}

export interface SessionOutputReport {
  hasData: boolean;
  sessions: number;
  produced: number;
  rate: number | null;
  weeks: SessionOutputWeek[];
  byTaskType?: SessionOutputByTaskType[];
}

function pct(rate: number | null): string {
  if (rate === null) return 'Not measured';
  return `${Math.round(rate * 100)}%`;
}

function formatTaskType(t: string): string {
  return t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function SessionOutputCard({ report }: { report: SessionOutputReport }) {
  // No sessions at all in the window — render nothing rather than an empty shell.
  if (!report.hasData) return null;

  const byTaskType = report.byTaskType ?? [];

  return (
    <Panel title="Produced a file" right={<Tag tone="measured">Measured</Tag>} flush>
      {/* No weekly trend chart: on a 0-100% scale the real values sit at a few per cent
          and every bar rounded to the floor, which read as missing data. */}
      <div className="px-4 pt-3 pb-2">
        <p className="m-0 text-[24px] leading-7 font-semibold tabular-nums text-[#05073F]">{pct(report.rate)}</p>
        <p className="m-0 mt-1 text-[13px] text-[#8F8F8F] tabular-nums">
          {report.produced.toLocaleString()} of {report.sessions.toLocaleString()} sessions, 13 weeks
        </p>
      </div>
      {byTaskType.length > 0 && (
        <div className="border-t border-[#F2F2F2]">
          {/* The bar is the rate against a fixed 0-100% track, never normalised to the
              strongest row, so a 40% and a 90% converter never draw the same width. */}
          {byTaskType.map(t => (
            <BarRow
              key={t.taskType}
              label={formatTaskType(t.taskType)}
              value={`${pct(t.rate)} · ${t.produced} of ${t.sessions}`}
              pct={Math.round(t.rate * 100)}
              tone="measured"
            />
          ))}
        </div>
      )}
    </Panel>
  );
}
