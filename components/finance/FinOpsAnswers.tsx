// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

/**
 * FinOps panels in the answer layout (components/precision/answer.tsx). Answer sentences are
 * written here from the chargeback figures; nothing is AI-written.
 */
import { useEffect, useState } from 'react';
import { AnswerPanel, AC, Columns, Legend, Waterfall, type AttentionItem } from '@/components/precision/answer';
import { fmtUsd, fmtUsdShort, monthName, plural } from '@/lib/ui/answer-text';
import { FINOPS_PRODUCTS, PRODUCT_FILL, PRODUCT_NAME, type FinopsProduct, type ProductParts } from '@/lib/finance/product-split';

interface TrendPoint { period: string; usd: number | null; parts?: ProductParts }

/* ── What are we spending? ──────────────────────────────────────── */

export function Spending({ period, totalUsd, monthToDate, projection, vsPriorPct, trend, gaps }: {
  period: string;
  totalUsd: number;
  monthToDate: boolean;
  projection: { projected: number; daysElapsed: number; daysInMonth: number } | null;
  vsPriorPct: number | null;
  trend: TrendPoint[];
  gaps: AttentionItem[];
}) {
  const month = monthName(period, true);
  // Products present in the trend, in FinOps' fixed order.
  const used = FINOPS_PRODUCTS.filter(p => trend.some(t => (t.parts?.[p] ?? 0) > 0));
  const products: FinopsProduct[] = used.length > 0 ? used : ['claude'];
  const points = trend.slice(-12);
  const idx = points.findIndex(t => t.period === period);
  const scale = projection && totalUsd > 0 ? projection.projected / totalUsd : 1;
  const series = products.map(p => ({
    label: PRODUCT_NAME[p],
    colour: PRODUCT_FILL[p],
    values: points.map((t, i) => {
      const v = t.parts ? (t.parts[p] ?? 0) : p === 'claude' ? t.usd : 0;
      if (v == null) return null;
      // The month in progress is drawn at its projected size, striped.
      return i === idx && projection ? v * scale : v;
    }),
  }));
  const answer = monthToDate && projection
    ? <>AI spend is <b>{fmtUsd(totalUsd)}</b> so far in {month}. It is on pace for <b>{fmtUsd(projection.projected)}</b>{vsPriorPct !== null ? `, ${Math.abs(Math.round(vsPriorPct))}% ${vsPriorPct >= 0 ? 'more' : 'less'} than last month` : ''}.</>
    : monthToDate
      ? <>AI spend is <b>{fmtUsd(totalUsd)}</b> so far in {month}. A month-end projection starts on day 7.</>
      : <>AI spend in {month} was <b>{fmtUsd(totalUsd)}</b>{vsPriorPct !== null ? `, ${Math.abs(Math.round(vsPriorPct))}% ${vsPriorPct >= 0 ? 'more' : 'less'} than the month before` : ''}.</>;
  return (
    <AnswerPanel
      question="What are we spending?"
      period={monthToDate ? `${month} so far` : month}
      tag={monthToDate && projection ? 'estimate' : 'measured'}
      answer={answer}
      attention={gaps.length > 0 ? { title: 'Gaps in these figures', items: gaps } : undefined}
      detail={{ href: '#detail', label: 'See spend by product, cost centre and person' }}
      note="Claude Code, ChatGPT and Codex are priced from tokens at your rates; Claude Cowork is the cost Anthropic records per request. Claude Chat isn't captured. The month in progress is drawn at its projected size, striped."
    >
      {points.length >= 2 ? (
        <Columns
          labels={points.map(t => monthName(t.period))}
          series={series}
          yFormat={fmtUsdShort}
          projectLast={idx === points.length - 1 && !!projection}
          height={190}
          callout={idx >= 0 ? { index: idx, text: projection ? `${fmtUsdShort(projection.projected)} projected` : fmtUsdShort(totalUsd), judged: !!projection } : undefined}
        />
      ) : null}
      {points.length >= 2 && <Legend items={[...products.map(p => ({ label: PRODUCT_NAME[p], colour: PRODUCT_FILL[p] })), ...(projection ? [{ label: 'Rest of the month, projected', colour: AC.judged, striped: true }] : [])]} />}
    </AnswerPanel>
  );
}

/* ── Which cost centres are growing? ─────────────────────────────── */

export function CentreGrowth({ changes, totalUsd, monthToDate }: {
  changes: Array<{ name: string; currentUsd: number; priorUsd: number }> | null;
  totalUsd: number;
  monthToDate: boolean;
}) {
  if (!changes || changes.length === 0) {
    return monthToDate
      ? <AnswerPanel question="Which cost centres are growing?" period="Against last month" quiet="Too early in the month to compare: the comparison starts on day 7." detail={{ href: '#detail-centres', label: 'See every cost centre' }} />
      : null;
  }
  const rows = changes.map(c => ({ ...c, delta: c.currentUsd - c.priorUsd })).sort((a, b) => b.delta - a.delta);
  const top = rows[0];
  const biggest = [...changes].sort((a, b) => b.currentUsd - a.currentUsd)[0];
  const share = totalUsd > 0 ? Math.round((biggest.currentUsd / totalUsd) * 100) : null;
  const shown = rows.slice(0, 6);
  const maxAbs = Math.max(1, ...shown.map(r => Math.abs(r.delta)));
  const pct = top.priorUsd > 0 ? Math.round((top.delta / top.priorUsd) * 100) : null;
  return (
    <AnswerPanel
      question="Which cost centres are growing?"
      period={monthToDate ? 'Against last month at the same point' : 'Against the month before'}
      tag="measured"
      answer={top.delta > 0
        ? <><b>{top.name}</b> grew most, up <b>{fmtUsd(top.delta)}</b>{pct !== null ? ` (${pct}%)` : ''}.{share !== null ? ` ${biggest.name} is ${share}% of all spend.` : ''}</>
        : <>No cost centre grew on last month.{share !== null ? ` ${biggest.name} is ${share}% of all spend.` : ''}</>}
      detail={{ href: '#detail-centres', label: `See all ${plural(changes.length, 'cost centre')} and their people` }}
      note={<>a person&apos;s spend goes to their department&apos;s cost centre.{monthToDate ? ' Last month is scaled to the same point in the month.' : ''} Spend with no department is listed under gaps, not here.</>}
    >
      {shown.map(r => {
        const w = (Math.abs(r.delta) / maxAbs) * 50;
        return (
          <div key={r.name} className="flex items-center gap-2.5 py-[5px] text-[13px]">
            <span className="w-[130px] shrink-0 truncate text-[#333333]">{r.name}</span>
            <span className="relative flex-1 h-3">
              <span className="absolute top-[-3px] bottom-[-3px] left-1/2 border-l border-[#BDBDBD]" />
              <span className="absolute top-0 bottom-0 rounded-[2px]" style={r.delta >= 0 ? { left: '50%', width: `${w}%`, background: AC.measured } : { right: '50%', width: `${w}%`, background: AC.grey }} />
            </span>
            <span className="w-[80px] shrink-0 text-right tabular-nums font-medium">{r.delta >= 0 ? '+' : '−'}{fmtUsd(Math.abs(r.delta))}</span>
          </div>
        );
      })}
      {rows.length > shown.length && <div className="text-[12px] text-[#8F8F8F] pt-1">and {rows.length - shown.length} more</div>}
    </AnswerPanel>
  );
}

/* ── Where could we spend less? ──────────────────────────────────── */

interface Flagged { surface: string; label: string; premiumModel: string; targetModel: string; saving: number }

const SURFACE_WORDS: Record<string, string> = { code: 'Claude Code', cowork: 'Claude Cowork', chatgpt: 'ChatGPT', codex: 'Codex' };

export function SpendLess({ period, totalUsd }: { period: string; totalUsd: number }) {
  const [state, setState] = useState<{ enabled: boolean; flags: Flagged[] } | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all(['code', 'cowork'].map(surface =>
      fetch(`/api/finance/model-efficiency?surface=${surface}&period=${period}`)
        .then(r => (r.ok ? r.json() : null))
        .catch(() => null)
        .then(d => ({ surface, d })),
    )).then(results => {
      if (!live) return;
      const enabled = results.some(x => x.d && x.d.enabled !== false);
      const flags: Flagged[] = [];
      for (const { surface, d } of results) {
        for (const a of d?.activities ?? []) {
          const f = a.flag;
          if (f && !f.suppressedReason && !f.shareBasedOnly && f.targetModel && f.estCeilingUsd && f.estCeilingUsd > 0) {
            flags.push({ surface, label: a.label, premiumModel: f.premiumModel, targetModel: f.targetModel, saving: f.estCeilingUsd });
          }
        }
      }
      flags.sort((a, b) => b.saving - a.saving);
      setState({ enabled, flags });
    });
    return () => { live = false; };
  }, [period]);
  if (!state || !state.enabled) return null;
  if (state.flags.length === 0) {
    return <AnswerPanel question="Where could we spend less?" period={monthName(period, true)} quiet="No kind of work stands out as running on a dearer model than it needs this month." detail={{ href: '#detail-efficiency', label: 'See every kind of work and its models' }} />;
  }
  const shown = state.flags.slice(0, 4);
  const saving = shown.reduce((a, f) => a + f.saving, 0);
  const short = (m: string) => m.replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/-/g, ' ');
  return (
    <AnswerPanel
      question="Where could we spend less?"
      period={`${monthName(period, true)} so far`}
      tag="estimate"
      answer={<>Moving {plural(shown.length, 'kind')} of work to a cheaper model would have saved up to <b>{fmtUsd(saving)}</b> this month.</>}
      detail={{ href: '#detail-efficiency', label: 'See every kind of work and its models' }}
      note="kinds of work are Claude's judgement; spend is measured. A saving is the most you could save at list prices if the work ran on the cheaper model, so it is a ceiling, not a promise."
    >
      <Waterfall
        start={{ label: 'Spent so far', value: totalUsd }}
        steps={shown.map(f => ({ label: `${f.label} to ${short(f.targetModel)}`, value: -f.saving }))}
        end={{ label: 'With the changes' }}
        format={fmtUsdShort}
      />
      <div className="mt-2 text-[12px] text-[#8F8F8F]">
        {shown.map(f => `${f.label} in ${SURFACE_WORDS[f.surface] ?? f.surface} runs mostly on ${short(f.premiumModel)}`).join('. ')}.
      </div>
    </AnswerPanel>
  );
}
