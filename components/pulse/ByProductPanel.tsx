// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

// Work Pulse "By product": Cowork, then the Claude in Office apps, then the
// Claude in Google apps, last 30 days, with an All products row that equals the
// overview's Meaningful work headline.
// Data: GET /api/pulse/org-summary → byProduct (lib/pulse/cowork/by-product.ts).
// Always shown: until a group's activity arrives its apps read 0 and the panel says how to set it up.
import { Fragment } from 'react';
import { Panel, PanelFoot, Tag, Dot, T, C } from '@/components/precision/ui';
import { WORK_PRODUCT_COLOR } from '@/lib/ui/chart-colours';
import { FAMILY_LABEL, FAMILY_ORDER, PRODUCT_FAMILY, PRODUCT_LABEL, type WorkProduct } from '@/lib/pulse/cowork/products';

export interface ByProductRow {
  product: WorkProduct | 'all';
  people: number;
  sessions: number;
  meaningfulPct: number | null;
  producedPct: number | null;
  spendUsd: number | null;
  spendEstimated: boolean;
  unpricedModels: string[];
}

function money(v: number): string {
  return v >= 100 ? `$${Math.round(v).toLocaleString('en-GB')}` : `$${v.toFixed(2)}`;
}

function NotMeasured() {
  return <span className="text-[#8F8F8F]" title="Not measured">—</span>;
}

export interface ByProductData {
  rows: ByProductRow[];
  total: ByProductRow;
  hasOffice: boolean;
  /** Which groups had activity. Absent from an older response: read as both seen. */
  seen?: { office: boolean; google: boolean };
}

export default function ByProductPanel({ data }: { data: ByProductData | null | undefined }) {
  if (!data || data.rows.length === 0) return null;
  const { rows, total } = data;
  const unpriced = [...new Set(rows.flatMap(r => r.unpricedModels))];
  const seen = data.seen ?? { office: true, google: true };
  const groups = FAMILY_ORDER.map(f => ({
    family: f,
    rows: rows.filter(r => r.product !== 'all' && PRODUCT_FAMILY[r.product] === f),
  })).filter(g => g.rows.length > 0);

  return (
    <Panel
      title="By product"
      subtitle="Cowork, Claude in Office and Claude in Google, last 30 days"
      flush
    >
      <div className="overflow-x-auto">
        <table className={`${T.table} min-w-[640px]`}>
          <thead>
            <tr className={T.headRow}>
              <th scope="col" className={`${T.th} align-top`}>Product</th>
              <th scope="col" className={`${T.thRight} align-top`}>App users</th>
              <th scope="col" className={`${T.thRight} align-top`}>Sessions</th>
              <th scope="col" className={`${T.thRight} align-top`}>
                Meaningful work <Tag tone="judged" title="Share of prompts Claude judged Tier 2 or 3">AI-judged</Tag>
                <span className="block mt-0.5 whitespace-nowrap font-normal text-[12px] leading-snug text-[#8F8F8F]">Prompts Claude judged to be multi-step work (Tier 2 or 3), not quick one-off questions</span>
              </th>
              <th scope="col" className={`${T.thRight} align-top`}>
                Produced something
                <span className="block mt-0.5 whitespace-nowrap font-normal text-[12px] leading-snug text-[#8F8F8F]">Sessions where Claude made a file or changed the document</span>
              </th>
              <th scope="col" className={`${T.thRight} align-top`}>Spend</th>
            </tr>
          </thead>
          <tbody>
            {groups.map(g => (
              <Fragment key={g.family}>
              {g.family !== 'cowork' && (
                <tr className={T.row}>
                  <td colSpan={6} className={`${T.td} pt-3 pb-1 text-[12px] font-medium uppercase tracking-wide text-[#666666]`}>
                    {FAMILY_LABEL[g.family]}
                  </td>
                </tr>
              )}
              {g.rows.map(r => (
              <tr key={r.product} className={T.row}>
                <td className={T.td} style={g.family !== 'cowork' ? { paddingLeft: 32 } : undefined}>
                  {r.product !== 'all' && <Dot color={WORK_PRODUCT_COLOR[r.product]}>{PRODUCT_LABEL[r.product]}</Dot>}
                </td>
                <td className={T.tdRight}>{r.people.toLocaleString('en-GB')}</td>
                <td className={T.tdRight}>{r.sessions.toLocaleString('en-GB')}</td>
                <td className={T.tdRight} style={{ color: C.judgedInk }}>
                  {r.meaningfulPct === null ? <NotMeasured /> : `${r.meaningfulPct}%`}
                </td>
                <td className={T.tdRight}>
                  {r.producedPct === null ? <NotMeasured /> : `${r.producedPct}%`}
                </td>
                <td className={T.tdRight}>
                  {r.spendUsd === null ? <NotMeasured /> : (
                    <>
                      {r.spendEstimated ? '≈' : ''}{money(r.spendUsd)}{' '}
                      <span className="text-[12px] text-[#8F8F8F]">{r.spendEstimated ? 'estimate' : 'reported'}</span>
                    </>
                  )}
                </td>
              </tr>
              ))}
              </Fragment>
            ))}
            <tr className={`${T.row} border-t border-[#EAEAEA] font-medium`}>
              <td className={T.td}>All products</td>
              <td className={T.tdRight}>{total.people.toLocaleString('en-GB')}</td>
              <td className={T.tdRight}>{total.sessions.toLocaleString('en-GB')}</td>
              <td className={T.tdRight} style={{ color: C.judgedInk }}>
                {total.meaningfulPct === null ? <NotMeasured /> : `${total.meaningfulPct}%`}
              </td>
              <td className={T.tdRight}>
                {total.producedPct === null ? <NotMeasured /> : `${total.producedPct}%`}
              </td>
              <td className={T.tdRight}>
                {total.spendUsd === null ? <NotMeasured /> : (
                  <>
                    {total.spendEstimated ? '≈' : ''}{money(total.spendUsd)}{' '}
                    <span className="text-[12px] text-[#8F8F8F]">{total.spendEstimated ? 'estimate' : 'reported'}</span>
                  </>
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      {!seen.office && (
        <p className="m-0 px-4 py-2.5 border-t border-[#F2F2F2] text-[13px] text-[#666666]">
          No Claude in Office activity yet. It appears here once Office monitoring is set up in the Claude admin console
          (Organisation settings → Office agents) and people use Claude in Excel, Word, PowerPoint or Outlook.
        </p>
      )}
      {!seen.google && (
        <p className="m-0 px-4 py-2.5 border-t border-[#F2F2F2] text-[13px] text-[#666666]">
          No Claude in Google activity yet. It appears here once people use Claude in Google Sheets, Docs or Slides, which
          reports through the same Office agents monitoring settings in the Claude admin console.
        </p>
      )}
      <PanelFoot>
        Office and Google send tokens but no cost, so their spend is priced from the model rates on Admin → Developer Pulse. App users counts a person once for each product they used, so the column adds
        up. Meaningful work for All products is the figure at the top of the
        page. A blank means too little to measure.
        {unpriced.length > 0 && ` Not priced, so left out of spend: ${unpriced.join(', ')}.`}
      </PanelFoot>
    </Panel>
  );
}
