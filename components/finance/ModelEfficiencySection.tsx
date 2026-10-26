// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

/**
 * FinOps "Model efficiency" section — an activity × model × cost cross-tab
 * per surface (Code | Cowork), plus a neutral "worth reviewing" flag for
 * activities where a high share of spend ran on the top-priced model.
 *
 * Consumes `GET /api/finance/model-efficiency?surface=&period=` (Tasks 3-5)
 * and does no recomputation of its own beyond formatting/rounding for
 * display. Honesty split preserved throughout: the activity axis + any
 * savings estimate are JUDGED (violet); spend/tokens/model-split/friction
 * are MEASURED (blue). Copy is always "worth reviewing", never
 * "overspending" — CCC does not measure output quality.
 *
 * Self-gating: when `financeModelEfficiencyEnabled` (or `chargebackEnabled`)
 * is off, the route 404s and this section renders nothing — mirroring how
 * the rest of `/finops` treats a disabled route (see `notEnabled` on the
 * page). No separate config fetch needed.
 */

import { useEffect, useState, type ReactNode } from 'react';
import type {
  ModelEfficiencyReport,
  ActivityRow,
  MeasuredBreakdownItem,
  Surface,
} from '@/lib/finance/model-efficiency';
import { formatModelLabel } from '@/lib/pulse/code/model-label';
import { Panel, Tag, Pill, T, Segmented, Notice, Muted, SubHead, cx } from '@/components/precision/ui';
import { MODEL_COLOURS, MODEL_OTHER, SHARE_BAR } from '@/lib/ui/chart-colours';

const fmtUsd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const fmtPct = (n: number) => `${Math.round(n * 100)}%`;
export const prettyModel = (model: string) => formatModelLabel(model).label;
const fmtTokensCompact = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B`
  : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M`
  : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K`
  : String(n);

/** Colour for the measured model-spend bar — GLOBAL and stable: a model's colour
 * is driven by its rank in `modelOrder` (the report's distinct-priced-models list,
 * most-expensive-first), never by its rank within a single activity's mix, so the
 * same model renders the same colour on every row. Each model gets a distinct hue
 * from MODEL_COLOURS (shades of one blue ran together past three models). A model
 * not found in `modelOrder` (shouldn't happen — `byModel` is derived from the same
 * priced set) takes the last colour. */
export function shadeForModel(model: string, modelOrder: string[]): string {
  const idx = modelOrder.indexOf(model);
  // Beyond the six colours a model is grey ("other"), so no two models share a colour.
  return idx >= 0 && idx < MODEL_COLOURS.length ? MODEL_COLOURS[idx] : MODEL_OTHER;
}

interface ReviewChip {
  label: string;
  tone: 'warn' | 'neutral' | 'good';
}

function reviewChipFor(activity: ActivityRow, belowVolumeKeys: Set<string>): ReviewChip {
  if (activity.flag && !activity.flag.suppressedReason) {
    return { label: 'Worth reviewing', tone: 'warn' };
  }
  if (activity.flag?.suppressedReason === 'high_friction') {
    return { label: 'High friction', tone: 'neutral' };
  }
  if (activity.flag?.suppressedReason === 'low_volume' || belowVolumeKeys.has(activity.key)) {
    return { label: 'Low volume', tone: 'neutral' };
  }
  if (activity.key === 'unclassified') {
    return { label: 'Classifier gap', tone: 'neutral' };
  }
  return { label: 'Efficient', tone: 'good' };
}

function ModelSpendBar({ activity, modelOrder }: { activity: ActivityRow; modelOrder: string[] }) {
  const modelSum = activity.byModel.reduce((s, m) => s + m.spendUsd, 0);
  const residual = Math.max(0, activity.totalSpendUsd - modelSum);
  const denom = activity.totalSpendUsd > 0 ? activity.totalSpendUsd : modelSum + residual;

  if (denom <= 0) {
    return <div className="h-2 w-full bg-[#F2F2F2] rounded-full" />;
  }

  return (
    <div className="h-2 w-full bg-[#F2F2F2] rounded-full overflow-hidden flex gap-px" title={`${fmtUsd(activity.totalSpendUsd)} total`}>
      {activity.byModel.map((m) => (
        <div
          key={m.model}
          className="h-full"
          style={{ width: `${(m.spendUsd / denom) * 100}%`, backgroundColor: shadeForModel(m.model, modelOrder) }}
          title={`${prettyModel(m.model)}: ${fmtUsd(m.spendUsd)}`}
        />
      ))}
      {residual > 0 && (
        <div
          className="h-full"
          style={{ width: `${(residual / denom) * 100}%`, backgroundColor: MODEL_OTHER }}
          title={`Other / unpriced: ${fmtUsd(residual)}`}
        />
      )}
    </div>
  );
}

function BreakdownRow({ item }: { item: MeasuredBreakdownItem }) {
  const value = item.count !== undefined ? `${item.count} uses` : fmtUsd(item.spendUsd);
  return (
    <li className="flex items-center justify-between gap-2 text-[13px] py-1.5 border-t border-[#EAEAEA] first:border-t-0">
      <span className="text-[#333333] flex items-center gap-2 min-w-0">
        <Tag>{item.dimension}</Tag>
        <span className="truncate">{item.key}</span>
      </span>
      <span className="text-[#0A0A0A] tabular-nums shrink-0">{value}</span>
    </li>
  );
}

function ActivityTableRow({
  activity,
  belowVolumeKeys,
  modelOrder,
  expanded,
  onToggle,
}: {
  activity: ActivityRow;
  belowVolumeKeys: Set<string>;
  modelOrder: string[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const chip = reviewChipFor(activity, belowVolumeKeys);
  return (
    <>
      <tr className={cx(T.row, 'cursor-pointer')} onClick={onToggle}>
        <td className={T.td}>
          <button
            type="button"
            aria-expanded={expanded}
            onClick={(e) => { e.stopPropagation(); onToggle(); }}
            className="inline-flex items-center gap-1.5 text-left text-[#0A0A0A] hover:text-[#245BF3]"
          >
            <span className="text-[#B3B3B3] inline-block w-3" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
            {activity.label}
          </button>
        </td>
        <td className={cx(T.td, 'w-48')}>
          <ModelSpendBar activity={activity} modelOrder={modelOrder} />
        </td>
        <td className={cx(T.tdRight, 'font-medium')}>
          {fmtUsd(activity.totalSpendUsd)}
        </td>
        <td className={cx(T.tdRight, 'text-[#666666]')}>
          {activity.friction === null ? '—' : fmtPct(activity.friction)}
        </td>
        <td className={T.tdRight}>
          <Pill tone={chip.tone}>{chip.label}</Pill>
        </td>
      </tr>
      {expanded && (
        <tr className="border-t border-[#F2F2F2] bg-[#FAFAFA]">
          <td colSpan={5} className="px-4 py-2">
            {activity.measuredBreakdown.length === 0 ? (
              <Muted>No skill, subagent or connector breakdown for this activity.</Muted>
            ) : (
              <ul className="m-0 p-0 pl-5 list-none">
                {activity.measuredBreakdown.map((item) => (
                  <BreakdownRow key={`${item.dimension}:${item.key}`} item={item} />
                ))}
              </ul>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function OpportunityCard({ activity }: { activity: ActivityRow }) {
  const flag = activity.flag;
  if (!flag) return null;
  return (
    <div className="border border-[#EAEAEA] rounded-[6px] px-3.5 py-3 flex flex-col gap-1">
      <p className="m-0 text-[14px] font-semibold text-[#0A0A0A]">{activity.label}</p>
      <p className="m-0 text-[13px] text-[#4D4D4D] leading-5">
        {fmtPct(flag.premiumShare)} of measured spend ran on {prettyModel(flag.premiumModel)}.
      </p>
      {flag.estCeilingUsd !== null && flag.targetModel ? (
        <p className="m-0 text-[13px] text-[#2451F3] tabular-nums">
          About {fmtUsd(Math.round(flag.estCeilingUsd))} estimated ceiling if repriced at {prettyModel(flag.targetModel)}
        </p>
      ) : (
        <p className="m-0 text-[13px] text-[#8F8F8F]">Concentration only</p>
      )}
    </div>
  );
}

/** What the cost-driver cards read: the same fields whether org-wide (FinOps) or one person (Spend Review). */
export type CostDriverFigures = Pick<ModelEfficiencyReport, 'spendByModel' | 'modelOrder' | 'costByType' | 'cacheEfficiency'>;

function ShareBar({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="h-1 w-full bg-[#F2F2F2] rounded-full overflow-hidden">
      <div className="h-full rounded-full" style={{ width: `${Math.max(0, Math.min(100, pct * 100))}%`, backgroundColor: color }} />
    </div>
  );
}

/** One column of the cost-driver band; hairline dividers between columns. */
function DriverColumn({ title, children, first = false }: { title: string; children: ReactNode; first?: boolean }) {
  return (
    <div className={cx('px-4 py-3 min-w-0', !first && 'border-t sm:border-t-0 sm:border-l border-[#F2F2F2]')}>
      <SubHead>{title}</SubHead>
      {children}
    </div>
  );
}

function SpendByModelCard({ report }: { report: CostDriverFigures }) {
  // Priced-only denominator — matches CostByTypeCard's basis (which is
  // restricted to priced models via costByType). On Cowork, report.totals.spendUsd
  // also includes unpriced/null-model cost_usd, which would make the two
  // cards' percentages reconcile to different totals.
  const total = report.spendByModel.reduce((s, m) => s + m.spendUsd, 0);
  return (
    <DriverColumn title="Spend by model" first>
      {report.spendByModel.length === 0 ? (
        <Muted>—</Muted>
      ) : (
        <ul className="m-0 p-0 list-none flex flex-col gap-2">
          {report.spendByModel.map((m) => {
            const share = total > 0 ? m.spendUsd / total : 0;
            return (
              <li key={m.model} className="min-w-0">
                <div className="flex items-center justify-between gap-2 text-[13px] mb-1">
                  <span className="text-[#0A0A0A] truncate">{prettyModel(m.model)}</span>
                  <span className="flex items-center gap-2 shrink-0 tabular-nums">
                    <span className="font-medium text-[#05073F]">{fmtUsd(m.spendUsd)}</span>
                    <span className="text-[#8F8F8F]">{fmtTokensCompact(m.tokens)} tok</span>
                  </span>
                </div>
                <ShareBar pct={share} color={shadeForModel(m.model, report.modelOrder)} />
              </li>
            );
          })}
        </ul>
      )}
    </DriverColumn>
  );
}

function CostByTypeCard({ report }: { report: CostDriverFigures }) {
  const { inputUsd, outputUsd, cacheWriteUsd, cacheReadUsd, unclassifiedUsd } = report.costByType;
  const total = inputUsd + outputUsd + cacheWriteUsd + cacheReadUsd + unclassifiedUsd;
  const rows: { label: string; value: number; note?: string }[] = [
    { label: 'Input', value: inputUsd },
    { label: 'Output', value: outputUsd },
    { label: 'Cache write', value: cacheWriteUsd },
    { label: 'Cache read', value: cacheReadUsd },
  ];
  if (unclassifiedUsd > 0) {
    rows.push({ label: 'Unclassified', value: unclassifiedUsd, note: 'priced spend with no token detail' });
  }
  return (
    <DriverColumn title="Cost by type">
      {total <= 0 ? (
        <Muted>—</Muted>
      ) : (
        <ul className="m-0 p-0 list-none flex flex-col gap-2">
          {rows.map((row) => {
            const share = row.value / total;
            return (
              <li key={row.label} className="min-w-0">
                <div className="flex items-center justify-between gap-2 text-[13px] mb-1">
                  <span className="text-[#0A0A0A] truncate">
                    {row.label}
                    {row.note && <span className="block text-[12px] text-[#8F8F8F]">{row.note}</span>}
                  </span>
                  <span className="flex items-center gap-2 shrink-0 tabular-nums">
                    <span className="font-medium text-[#05073F]">{fmtUsd(row.value)}</span>
                    <span className="text-[#8F8F8F]">{fmtPct(share)}</span>
                  </span>
                </div>
                <ShareBar pct={share} color={SHARE_BAR} />
              </li>
            );
          })}
        </ul>
      )}
    </DriverColumn>
  );
}

function CacheEfficiencyCard({ report }: { report: CostDriverFigures }) {
  return (
    <DriverColumn title="Cache efficiency">
      <p className="m-0 text-[24px] leading-7 font-semibold tracking-[-0.02em] tabular-nums text-[#05073F]">
        {report.cacheEfficiency.ratio === null ? '—' : `${Math.round(report.cacheEfficiency.ratio * 100)}%`}
      </p>
      <p className="m-0 mt-1 text-[13px] text-[#8F8F8F] leading-5">
        Share of input tokens served from cache
        {report.cacheEfficiency.cacheReadTokens > 0
          ? ` (${fmtTokensCompact(report.cacheEfficiency.cacheReadTokens)} tokens read from cache).`
          : '.'}
      </p>
    </DriverColumn>
  );
}

/** Cost drivers as one band of three columns. Sits at the bottom of a flush Panel.
 * `scope` names the product the figures cover when they are not all of it. */
export function CostDrivers({ report, scope }: { report: CostDriverFigures; scope?: string }) {
  return (
    <div className="border-t border-[#EAEAEA]">
      <div className="px-4 pt-3 flex items-center gap-2">
        <span className="text-[14px] font-semibold text-[#0A0A0A]">{scope ? `Cost drivers, ${scope}` : 'Cost drivers'}</span>
        <Tag tone="measured">Measured</Tag>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3">
        <SpendByModelCard report={report} />
        <CostByTypeCard report={report} />
        <CacheEfficiencyCard report={report} />
      </div>
    </div>
  );
}

function EmptyState({ surface, period }: { surface: Surface; period: string }) {
  return (
    <div className="p-4">
      <div className="border border-dashed border-[#DADADA] rounded-[14px] px-6 py-8 text-center">
        <p className="m-0 text-[14px] text-[#8F8F8F]">
          No priced {surface === 'code' ? 'Code' : 'Cowork'} spend for {period}.
        </p>
      </div>
    </div>
  );
}

export default function ModelEfficiencySection({ period }: { period: string }) {
  const [surface, setSurface] = useState<Surface>('code');
  const [report, setReport] = useState<ModelEfficiencyReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [notEnabled, setNotEnabled] = useState(false);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setExpandedKey(null);
    fetch(`/api/finance/model-efficiency?surface=${surface}&period=${period}`)
      .then((r) => {
        if (r.status === 404) {
          if (!cancelled) setNotEnabled(true);
          throw new Error('not enabled');
        }
        if (!r.ok) throw new Error("Couldn't load this page. Try again.");
        return r.json();
      })
      .then((data: ModelEfficiencyReport) => {
        if (cancelled) return;
        setNotEnabled(false);
        setReport(data);
      })
      .catch(() => {
        // Graceful: on 404 (dormant) or any transient failure, the section
        // simply shows nothing new rather than an error banner. `notEnabled`
        // hides the whole section; other failures just leave `report` stale/null.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [surface, period]);

  if (notEnabled) return null;
  if (!report && !loading) return null;

  const belowVolumeKeys = new Set((report?.belowVolume ?? []).map((b) => b.key));
  const opportunities = (report?.activities ?? []).filter((a) => a.flag && !a.flag.suppressedReason);
  const isShareBasedOnly = surface === 'cowork';

  return (
    <Panel
      title="Model efficiency"
      subtitle={<>Activity is <span className="text-[#2451F3]">AI-judged</span>; spend, model split and friction are <span className="text-[#05073F] font-medium">measured</span></>}
      right={
        <Segmented<Surface>
          label="Surface"
          value={surface}
          onChange={setSurface}
          options={[{ value: 'code', label: 'Code' }, { value: 'cowork', label: 'Cowork' }]}
        />
      }
      flush
    >
      {loading && <p className="m-0 p-6 text-center text-[13px] text-[#8F8F8F]">Loading…</p>}

      {!loading && report && !report.hasData && <EmptyState surface={surface} period={period} />}

      {!loading && report && report.hasData && (
        <>
          <div className="overflow-x-auto">
            <table className={T.table}>
              <thead>
                <tr className={T.headRow}>
                  <th scope="col" className={T.th}>Activity</th>
                  <th scope="col" className={T.th}>Model split</th>
                  <th scope="col" className={T.thRight}>Spend</th>
                  <th scope="col" className={T.thRight}>Friction</th>
                  <th scope="col" className={T.thRight}>Review</th>
                </tr>
              </thead>
              <tbody>
                {report.activities.map((activity) => (
                  <ActivityTableRow
                    key={activity.key}
                    activity={activity}
                    belowVolumeKeys={belowVolumeKeys}
                    modelOrder={report.modelOrder}
                    expanded={expandedKey === activity.key}
                    onToggle={() => setExpandedKey((k) => (k === activity.key ? null : activity.key))}
                  />
                ))}
              </tbody>
            </table>
          </div>

          <div className="px-4 py-2.5 border-t border-[#F2F2F2] flex items-center gap-x-4 gap-y-1 flex-wrap text-[13px] text-[#8F8F8F]">
            {report.modelOrder.map((model) => (
              <span key={model} className="flex items-center gap-1.5">
                <span className="inline-block w-2.5 h-2 rounded-full" style={{ backgroundColor: shadeForModel(model, report.modelOrder) }} />
                {prettyModel(model)}
              </span>
            ))}
            {report.modelOrder.length > 0 && <span>most expensive first</span>}
            <span className="sm:ml-auto">Measured spend, model mix and cache usage for this period. Recent sessions classify once idle.</span>
          </div>

          {report.unpricedModels.length > 0 && (
            <div className="px-4 pb-3">
              <Notice tone="warn">
                {report.unpricedModels.length} model{report.unpricedModels.length === 1 ? '' : 's'} unpriced (excluded from tiering).
              </Notice>
            </div>
          )}

          <CostDrivers report={report} scope={surface === 'code' ? 'Claude Code' : 'Cowork'} />

          {opportunities.length > 0 && (
            <div className="border-t border-[#EAEAEA] px-4 py-3 flex flex-col gap-2">
              <span className="text-[14px] font-semibold text-[#0A0A0A]">Opportunities to review</span>
              {isShareBasedOnly && (
                <Notice tone="warn">Share-based: there is no friction check on Cowork, so review manually before acting.</Notice>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {opportunities.map((activity) => (
                  <OpportunityCard key={activity.key} activity={activity} />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}
