// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * FinOps "This month in cost" insight card.
 *
 * Renders the server-computed deterministic facts (`lib/finance/insights.ts`
 * `buildInsightFacts`) as plain-language bullets, plus — when present — the
 * grounded LLM narrative (`lib/finance/insight-narrative.ts`), clearly
 * labelled as generated. Both are computed server-side and passed straight
 * through; this component does no recomputation and never invents numbers.
 */
import { Panel, Tag, Muted } from '@/components/precision/ui';

export interface InsightFacts {
  biggestMover: { centre: string; deltaUsd: number; deltaPct: number | null; atPace?: boolean } | null;
  concentration: { topCentrePct: number | null; topUsersPct: number | null };
  projection: { projectedUsd: number; priorUsd: number; vsPriorPct: number | null } | null;
  dataQuality: { unallocatedPct: number; unpricedModelCount: number; estimated: boolean };
}

export interface InsightCardProps {
  insight: { facts: InsightFacts; narrative: string | null } | null;
  dataQualityNotes: string[];
}

const fmtUsd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const fmtPct = (n: number) => `${Math.round(n)}%`;

/** Deterministic bullets derived from server facts — no invented numbers. */
function buildFactBullets(facts: InsightFacts, dataQualityNotes: string[]): string[] {
  const bullets: string[] = [];

  if (facts.biggestMover) {
    const { centre, deltaUsd, deltaPct, atPace } = facts.biggestMover;
    const lead = atPace ? `${centre} is running furthest ahead of last month's pace` : `${centre} grew the most vs last month`;
    bullets.push(
      deltaPct != null
        ? `${lead}, up ${fmtUsd(deltaUsd)} (${fmtPct(deltaPct)}).`
        : `${lead}, up ${fmtUsd(deltaUsd)}.`
    );
  }

  if (facts.concentration.topCentrePct != null) {
    bullets.push(`The top cost centre accounts for ${fmtPct(facts.concentration.topCentrePct)} of total spend.`);
  }

  if (facts.projection) {
    const { projectedUsd, vsPriorPct } = facts.projection;
    bullets.push(
      vsPriorPct != null
        ? `On pace for ~${fmtUsd(projectedUsd)} by month end (${vsPriorPct >= 0 ? '+' : ''}${Math.round(vsPriorPct)}% vs last month).`
        : `On pace for ~${fmtUsd(projectedUsd)} by month end.`
    );
  }

  if (dataQualityNotes.length > 0) {
    bullets.push(...dataQualityNotes);
  } else if (facts.dataQuality.unallocatedPct === 0 && facts.dataQuality.unpricedModelCount === 0) {
    bullets.push('No data-quality issues this month: every dollar is priced and allocated.');
  }

  return bullets;
}

export default function InsightCard({ insight, dataQualityNotes }: InsightCardProps) {
  const facts = insight?.facts ?? null;
  const narrative = insight?.narrative;
  const bullets = facts ? buildFactBullets(facts, dataQualityNotes) : dataQualityNotes;

  return (
    <Panel title="This month in cost" subtitle="Deterministic facts, computed server-side" flush>
      {bullets.length > 0 && (
        <ul className="m-0 p-0 list-none">
          {bullets.map((b, i) => (
            <li key={i} className="px-4 py-2 border-t border-[#F2F2F2] first:border-t-0 text-[14px] leading-5 text-[#333333]">
              {b}
            </li>
          ))}
        </ul>
      )}
      {narrative && (
        <div className={`px-4 py-3 ${bullets.length > 0 ? 'border-t border-[#EAEAEA]' : ''} flex flex-col items-start gap-1.5`}>
          <Tag tone="measured">Summary</Tag>
          <p className="m-0 text-[14px] leading-6 text-[#333333]">{narrative}</p>
          <Muted>Built from the figures above.</Muted>
        </div>
      )}
    </Panel>
  );
}
